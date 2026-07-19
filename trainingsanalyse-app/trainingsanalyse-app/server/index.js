// Trainingsanalyse-App – Hauptserver.
// Bewusst mit reinem Node.js (http-Modul) umgesetzt, ganz ohne externe
// Abhängigkeiten (kein Express nötig) – dadurch läuft "npm install" in
// Sekunden bzw. wird gar nicht gebraucht, was das Deployment vereinfacht.
// (Auch der Supabase-Zugriff in store.js nutzt nur das eingebaute `fetch`.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// .env laden, falls vorhanden (Node 20.6+ hat process.loadEnvFile eingebaut)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn('Konnte .env nicht laden:', err.message);
  }
}

const store = require('./store');
const strava = require('./strava');
const analysis = require('./analysis');
const planner = require('./planner');
const healthImport = require('./health-import');
const healthAutoExport = require('./health-auto-export');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

console.log(
  store.REMOTE_MODE
    ? 'Datenspeicher: Supabase (persistent über Deploys/Ruhephasen hinweg).'
    : 'Datenspeicher: lokale Datei data/store.json (WARNUNG: auf Render Free Tier nicht persistent - siehe INSTALLATION.md, Supabase-Setup empfohlen).'
);

// Store wird bei jedem Request frisch geladen (asynchron - siehe store.js), um bei
// Restarts/mehreren Prozessen konsistent zu bleiben - bei der erwarteten Last einer
// Single-User-App ist das performant genug.
async function loadStore() {
  return store.load();
}
async function saveStore(s) {
  return store.save(s);
}

// Kurzlebiger State-Wert für den OAuth-CSRF-Schutz (kein Cookie nötig, da Single-User)
let pendingOAuthState = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// 25 statt ursprünglich 5 MB: Health-Auto-Export-Payloads können bei aktivierten
// GPS-Routen pro Sync mehrere MB groß werden (siehe health-auto-export.js) -
// wir empfehlen zwar, Routen in der App-Automation zu deaktivieren (sie werden
// für die Trainingsanalyse nicht gebraucht), aber ein großzügigeres Limit hier
// verhindert trotzdem, dass ein einzelner unerwartet großer Sync einfach verworfen wird.
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) {
        reject(new Error('Body zu groß'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Verboten');
    return;
  }
  fs.readFile(fullPath, (err, content) => {
    if (err) {
      sendError(res, 404, 'Nicht gefunden');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// Merged frisch abgerufene Strava-Aktivitäten in store.activities (Dedupe nach stravaId)
function mergeActivities(currentStore, rawActivities) {
  const existingByStravaId = new Map(currentStore.activities.map((a) => [a.stravaId, a]));
  for (const raw of rawActivities) {
    const normalized = strava.normalizeActivity(raw);
    existingByStravaId.set(normalized.stravaId, normalized);
  }
  currentStore.activities = Array.from(existingByStravaId.values()).sort(
    (a, b) => new Date(b.startDate) - new Date(a.startDate)
  );
}

async function handleSync(currentStore, sinceDays) {
  const afterEpoch = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;
  const raw = await strava.fetchActivitiesSince(currentStore, saveStore, afterEpoch);
  mergeActivities(currentStore, raw);
  currentStore.strava.lastSyncAt = new Date().toISOString();
  await saveStore(currentStore);
  return raw.length;
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return r;
  }
  return null;
}

// ---------- API-Routen ----------

route('GET', '/api/state', async (req, res) => {
  const s = await loadStore();
  const report = analysis.buildAnalysisReport(s.activities, s.athlete);
  sendJson(res, 200, {
    athlete: s.athlete,
    strava: {
      connected: s.strava.connected,
      athleteId: s.strava.athleteId,
      lastSyncAt: s.strava.lastSyncAt,
      webhookActive: !!s.strava.webhookSubscriptionId
    },
    appleHealth: {
      importToken: s.appleHealth.importToken,
      lastImportAt: s.appleHealth.lastImportAt,
      importCount: s.appleHealth.importCount
    },
    recentActivities: s.activities.slice(0, 20),
    plan: s.plan,
    analysis: report
  });
});

// Löscht eine einzelne Aktivität (z.B. Test-Trainings, die man in Health/Strava
// zwar entfernt hat, die aber - da unser Import rein additiv ist, siehe
// health-import.js/health-auto-export.js - sonst für immer in der App
// stehen blieben würden). Kein Pfad-Parameter-Routing im einfachen Router hier,
// daher als Query-Parameter statt "/api/activities/:id".
route('DELETE', '/api/activities', async (req, res, urlObj) => {
  const id = urlObj.searchParams.get('id');
  if (!id) {
    return sendError(res, 400, 'Fehlender Parameter "id".');
  }
  const s = await loadStore();
  const idx = s.activities.findIndex((a) => a.id === id);
  if (idx === -1) {
    return sendError(res, 404, 'Aktivität nicht gefunden (evtl. schon gelöscht).');
  }
  const [removed] = s.activities.splice(idx, 1);
  await saveStore(s);
  sendJson(res, 200, { deleted: true, activity: removed });
});

// Nimmt einen einzelnen Trainings-Datensatz vom iOS-Kurzbefehl entgegen.
// Auth über einen einfachen geteilten Token (kein OAuth nötig, da Single-User-App):
// entweder als ?token=... in der URL oder als "Authorization: Bearer ..."-Header.
route('POST', '/api/import/health', async (req, res, urlObj) => {
  const s = await loadStore();
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const providedToken = urlObj.searchParams.get('token') || headerToken;

  if (!providedToken || providedToken !== s.appleHealth.importToken) {
    return sendError(res, 401, 'Ungültiger oder fehlender Import-Token.');
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }

  const validation = healthImport.validatePayload(body);
  if (!validation.ok) {
    return sendError(res, 400, validation.error);
  }

  const normalized = healthImport.normalizeHealthPayload(body);
  healthImport.mergeHealthActivity(s, normalized);
  s.appleHealth.lastImportAt = new Date().toISOString();
  s.appleHealth.importCount = (s.appleHealth.importCount || 0) + 1;
  await saveStore(s);

  sendJson(res, 200, { received: true, activity: normalized });
});

// Nimmt einen Health-Auto-Export-Payload entgegen (siehe health-auto-export.js
// für das erwartete JSON-Format). Ein Aufruf kann mehrere Workouts enthalten
// (z.B. bei einem automatischen periodischen Sync mit mehreren Trainings seit
// dem letzten Export) - die werden dann alle in einem Rutsch verarbeitet.
// Gleicher Token wie /api/import/health, damit nur ein Secret verwaltet werden muss.
route('POST', '/api/import/health-auto-export', async (req, res, urlObj) => {
  const s = await loadStore();
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const providedToken = urlObj.searchParams.get('token') || headerToken;

  if (!providedToken || providedToken !== s.appleHealth.importToken) {
    return sendError(res, 401, 'Ungültiger oder fehlender Import-Token.');
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }

  const result = healthAutoExport.processPayload(s, body);

  if (result.imported.length > 0) {
    s.appleHealth.lastImportAt = new Date().toISOString();
    s.appleHealth.importCount = (s.appleHealth.importCount || 0) + result.imported.length;
    await saveStore(s);
  }

  console.log(
    `[health-auto-export] ${result.totalWorkouts} Workout(s) im Payload, ${result.imported.length} importiert, ${result.skipped.length} übersprungen.`
  );
  if (result.totalWorkouts > 0 && result.imported.length === 0) {
    console.log('[health-auto-export] Keines der Workouts konnte geparst werden. Felder des ersten Eintrags:', result.skipped[0]);
  }

  sendJson(res, 200, {
    received: true,
    totalWorkouts: result.totalWorkouts,
    imported: result.imported.length,
    skipped: result.skipped.length,
    activities: result.imported
  });
});

// Erzeugt einen neuen Import-Token (macht den alten ungültig) - z.B. falls der
// Token versehentlich geteilt wurde oder du den Kurzbefehl neu einrichtest.
// Hinweis: Ist APPLE_HEALTH_IMPORT_TOKEN als Umgebungsvariable gesetzt, überschreibt
// store.load() diesen Wert beim nächsten Request wieder mit dem Env-Var-Wert - die
// Rotation hier ist dann nur sinnvoll, wenn man die Env-Var gleichzeitig mit ändert.
route('POST', '/api/import/health/rotate-token', async (req, res) => {
  const s = await loadStore();
  s.appleHealth.importToken = crypto.randomBytes(20).toString('hex');
  await saveStore(s);
  sendJson(res, 200, { importToken: s.appleHealth.importToken });
});

route('POST', '/api/settings', async (req, res) => {
  const body = await parseJsonBody(req);
  const s = await loadStore();
  const allowed = [
    'name',
    'maxHR',
    'restingHR',
    'gender',
    'weeklyIncreaseCap',
    'deloadEveryNWeeks',
    'sessionsPerWeekDefault'
  ];
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      s.athlete[key] = body[key];
    }
  }
  await saveStore(s);
  sendJson(res, 200, { athlete: s.athlete });
});

route('GET', '/auth/strava', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/auth/strava/callback`;
  pendingOAuthState = crypto.randomBytes(16).toString('hex');
  try {
    const url = strava.getAuthUrl(redirectUri, pendingOAuthState);
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

route('GET', '/auth/strava/callback', async (req, res, urlObj) => {
  const code = urlObj.searchParams.get('code');
  const state = urlObj.searchParams.get('state');
  const error = urlObj.searchParams.get('error');
  if (error) {
    res.writeHead(302, { Location: '/?strava_error=' + encodeURIComponent(error) });
    return res.end();
  }
  if (!code || !state || state !== pendingOAuthState) {
    res.writeHead(302, { Location: '/?strava_error=invalid_state' });
    return res.end();
  }
  pendingOAuthState = null;
  try {
    const tokenData = await strava.exchangeCodeForToken(code);
    const s = await loadStore();
    s.strava.connected = true;
    s.strava.athleteId = tokenData.athlete ? tokenData.athlete.id : null;
    s.strava.accessToken = tokenData.access_token;
    s.strava.refreshToken = tokenData.refresh_token;
    s.strava.expiresAt = tokenData.expires_at;
    await saveStore(s);
    // Direkt einen initialen Sync der letzten 90 Tage anstoßen
    try {
      await handleSync(s, 90);
    } catch (syncErr) {
      console.error('Initialer Sync fehlgeschlagen:', syncErr.message);
    }
    res.writeHead(302, { Location: '/?strava_connected=1' });
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(302, { Location: '/?strava_error=' + encodeURIComponent(err.message) });
    res.end();
  }
});

route('POST', '/api/sync', async (req, res) => {
  const s = await loadStore();
  if (!s.strava.connected) {
    return sendError(res, 400, 'Strava ist nicht verbunden.');
  }
  try {
    const count = await handleSync(s, 90);
    sendJson(res, 200, { syncedRaw: count, totalActivities: s.activities.length });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

route('POST', '/api/plan/regenerate', async (req, res) => {
  const s = await loadStore();
  const plan = planner.generateNextWeekPlan(s);
  await saveStore(s);
  sendJson(res, 200, { plan });
});

route('POST', '/api/webhook/setup', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const callbackUrl = `${baseUrl}/webhook`;
  const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    return sendError(res, 400, 'STRAVA_WEBHOOK_VERIFY_TOKEN ist nicht in .env gesetzt.');
  }
  try {
    const existing = await strava.listWebhookSubscriptions();
    if (existing && existing.length > 0) {
      const s = await loadStore();
      s.strava.webhookSubscriptionId = existing[0].id;
      await saveStore(s);
      return sendJson(res, 200, { subscription: existing[0], note: 'Es existierte bereits eine Subscription.' });
    }
    const sub = await strava.createWebhookSubscription(callbackUrl, verifyToken);
    const s = await loadStore();
    s.strava.webhookSubscriptionId = sub.id;
    await saveStore(s);
    sendJson(res, 200, { subscription: sub });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

// Strava Webhook-Verifizierung (wird einmalig beim Anlegen der Subscription aufgerufen)
route('GET', '/webhook', async (req, res, urlObj) => {
  const mode = urlObj.searchParams.get('hub.mode');
  const token = urlObj.searchParams.get('hub.verify_token');
  const challenge = urlObj.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    return sendJson(res, 200, { 'hub.challenge': challenge });
  }
  sendError(res, 403, 'Verify-Token stimmt nicht überein.');
});

// Strava Webhook-Events (neue/aktualisierte Aktivität hochgeladen)
route('POST', '/webhook', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger Body');
  }
  // Strava erwartet eine schnelle 200-Antwort - erst antworten, dann verarbeiten.
  sendJson(res, 200, { received: true });

  if (body.object_type !== 'activity') return;
  if (body.aspect_type !== 'create' && body.aspect_type !== 'update') return;

  try {
    const s = await loadStore();
    if (!s.strava.connected) return;
    const detail = await strava.fetchActivityDetail(s, saveStore, body.object_id);
    mergeActivities(s, [detail]);
    await saveStore(s);
    console.log(`Webhook: Aktivität ${body.object_id} importiert (${detail.name}).`);
  } catch (err) {
    console.error('Webhook-Verarbeitung fehlgeschlagen:', err.message);
  }
});

route('GET', '/api/health', async (req, res) => {
  sendJson(res, 200, { ok: true, time: new Date().toISOString() });
});

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    const matched = matchRoute(req.method, pathname);
    if (matched) {
      await matched.handler(req, res, urlObj);
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    sendError(res, 404, 'Route nicht gefunden');
  } catch (err) {
    console.error('Unerwarteter Fehler:', err);
    if (!res.headersSent) sendError(res, 500, 'Interner Serverfehler: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`Trainingsanalyse-App läuft auf Port ${PORT}`);
  console.log(`Lokal erreichbar unter: http://localhost:${PORT}`);
});
