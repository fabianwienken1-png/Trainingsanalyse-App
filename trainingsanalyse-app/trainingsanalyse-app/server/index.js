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
const performance = require('./performance');
const healthImport = require('./health-import');
const healthAutoExport = require('./health-auto-export');
const dedupe = require('./dedupe');
const recovery = require('./recovery');
const auth = require('./auth');
const athleteHr = require('./athlete-hr');
const spontaneous = require('./spontaneous');

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

// Schreib-Warteschlange: Alle Daten liegen als ein Dokument in Supabase
// (laden → ändern → speichern). Laufen zwei Anfragen gleichzeitig (z.B. die
// Workout- und die Schlaf-Automation in derselben Minute), würde die zweite die
// Änderungen der ersten überschreiben. Deshalb werden alle ändernden Anfragen
// strikt nacheinander abgearbeitet.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
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

function serveStatic(req, res, pathname, headOnly) {
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
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': content.length
    };
    // HTML/JS/CSS/Manifest ohne HTTP-Cache ausliefern: die App hat keine
    // Cache-Busting-Dateinamen (z.B. app.abc123.js), daher würde ein vom
    // Browser gecachtes index.html/app.js nach einem Deploy sonst erst nach
    // einem harten Reload aktualisiert werden (siehe Verwirrung beim
    // Phase-2-Rollout - der Deploy war korrekt, nur der Browser zeigte noch
    // die alte Version). Bilder/Icons ändern sich praktisch nie und dürfen
    // normal gecacht werden.
    if (['.html', '.js', '.css', '.webmanifest', '.json'].includes(ext)) {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(headOnly ? undefined : content);
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
  const hrChanges = athleteHr.updateAutoHR(s);
  if (Object.keys(hrChanges).length) console.log('[puls] automatisch aktualisiert:', JSON.stringify(hrChanges));
  const reclassified = healthImport.reclassifyActivities(s);
  if (reclassified) console.log(`[sportart] ${reclassified} Einträge neu eingeordnet.`);
  const planChanged = planner.ensureCurrentPlan(s);
  const marked = planner.autoMarkDone(s);
  if (Object.keys(hrChanges).length || planChanged || marked || reclassified) await saveStore(s);
  const report = analysis.buildAnalysisReport(s.activities, s.athlete);
  const rec = recovery.computeRecovery(s.health);
  if (rec && rec.status === 'eingeschränkt') {
    report.flags.unshift({
      level: 'warnung',
      message: `Eingeschränkte Erholung: ${rec.reasons.join(', ')}. Plane lockere Einheiten oder einen Ruhetag ein.`
    });
  }
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
    recovery: rec,
    planSuggestion: planner.suggestAdjustment(s, rec, recovery.dayKey(new Date())),
    sleepSeries: recovery.sleepSeries(s.health, 28),
    workoutLibrary: s.workoutLibrary || {},
    healthMetrics: { lastImportAt: (s.health && s.health.lastImportAt) || null },
    plan: Object.assign({}, s.plan, { sessions: planner.decorateSessions(s), history: (s.plan.history || []).slice(0, 8) }),
    goal: planner.getGoal(s.athlete),
    performance: performanceInfo(s),
    rpe: performance.rpeSignal(s),
    trends: performance.trends(s),
    analysis: report
  });
});

// Backup-Export: kompletter Store als JSON-Datei zum Download, unabhängig von
// Supabase/Render (siehe Verbesserungs-Roadmap, Phase 2) - so hat der Nutzer
// jederzeit eine eigene Kopie seiner Trainingsdaten/Einstellungen, falls z.B.
// mal die Datenbank-Anbindung Probleme macht. OAuth-Zugangsdaten (Strava-Tokens,
// Health-Import-Token) werden bewusst NICHT mit exportiert - das Backup soll
// die Trainingsdaten sichern, keine Secrets weitergeben.
route('GET', '/api/backup', async (req, res) => {
  const s = await loadStore();
  const exportData = JSON.parse(JSON.stringify(s));
  if (exportData.strava) {
    exportData.strava.accessToken = null;
    exportData.strava.refreshToken = null;
  }
  if (exportData.appleHealth) {
    exportData.appleHealth.importToken = null;
  }
  const filename = `trainingsanalyse-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const body = JSON.stringify(exportData, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
});

// Liefert Aktivitäten mit optionalen Filtern (Suche/Sportart) für die
// Aktivitätentabelle im Frontend (siehe Verbesserungs-Roadmap, Phase 3).
// Eigener Endpoint statt Erweiterung von /api/state, da /api/state bewusst nur
// die letzten 20 für die Kurzübersicht liefert (?q= durchsucht Name/Sportart,
// ?sport= filtert exakt, ?limit= deckelt die Ergebnisliste).
route('GET', '/api/activities', async (req, res, urlObj) => {
  const s = await loadStore();
  const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
  const sport = urlObj.searchParams.get('sport') || '';
  const limit = Math.min(5000, Math.max(1, Number(urlObj.searchParams.get('limit')) || 200));
  let list = s.activities;
  if (sport) {
    list = list.filter((a) => a.type === sport);
  }
  if (q) {
    list = list.filter(
      (a) => (a.name || '').toLowerCase().includes(q) || (a.type || '').toLowerCase().includes(q)
    );
  }
  sendJson(res, 200, { activities: list.slice(0, limit), total: list.length });
});

// Legt eine manuell erfasste Aktivität an (siehe health-import.js,
// normalizeManualActivity) - für Einheiten, die Health/Strava nicht sauber
// erfasst haben (z.B. Studio-Kurs ohne Uhr am Handgelenk).
route('POST', '/api/activities', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const validation = healthImport.validateManualActivity(body);
  if (!validation.ok) {
    return sendError(res, 400, validation.error);
  }
  const s = await loadStore();
  const normalized = healthImport.normalizeManualActivity(body);
  healthImport.mergeHealthActivity(s, normalized);
  await saveStore(s);
  sendJson(res, 201, { activity: normalized });
});

// Setzt den Status einer einzelnen Plan-Session der laufenden Woche manuell
// (erledigt/übersprungen/zurücksetzen auf geplant) - unabhängig von der
// automatischen ±1-Tag-Erkennung beim nächsten Wochenwechsel (siehe
// planner.js, evaluatePreviousWeek). Das gesetzte "manualOverride"-Flag sorgt
// dafür, dass die Entscheidung beim nächsten "Neue Woche planen" nicht wieder
// von der Automatik überschrieben wird.
route('POST', '/api/plan/session-status', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const { sessionId, status } = body || {};
  if (!sessionId || !['planned', 'done', 'missed'].includes(status)) {
    return sendError(res, 400, 'Felder "sessionId" und "status" (planned|done|missed) sind erforderlich.');
  }
  const s = await loadStore();
  const session = (s.plan.sessions || []).find((sess) => sess.id === sessionId);
  if (!session) {
    return sendError(res, 404, 'Session nicht gefunden (evtl. wurde inzwischen eine neue Woche geplant).');
  }
  session.status = status;
  session.manualOverride = status !== 'planned';
  await saveStore(s);
  sendJson(res, 200, { plan: s.plan });
});

// Doppelte/versehentliche Einträge (siehe dedupe.js): GET zeigt eine Vorschau,
// POST entfernt sie. Beim Import läuft dieselbe Bereinigung automatisch.
route('GET', '/api/activities/duplicates', async (req, res) => {
  const s = await loadStore();
  const removals = dedupe.findRemovals(s.activities);
  sendJson(res, 200, {
    count: removals.length,
    items: removals.map((r) => ({ reason: r.reason, keptId: r.keptId, activity: r.activity }))
  });
});

// Diagnose: was kam zuletzt an Gesundheitsdaten an (Metrik-Namen, Anzahl, Feldnamen)?
route('GET', '/api/health-metrics/status', async (req, res) => {
  const s = await loadStore();
  const h = s.health || {};
  sendJson(res, 200, {
    lastImportAt: h.lastImportAt || null,
    days: { sleep: Object.keys(h.sleep || {}).length, hrv: Object.keys(h.hrv || {}).length, restingHR: Object.keys(h.restingHR || {}).length },
    lastPayload: h.lastPayload || null
  });
});

route('POST', '/api/activities/dedupe', async (req, res) => {
  const s = await loadStore();
  const removals = dedupe.removeDuplicates(s);
  if (removals.length) await saveStore(s);
  console.log(`[dedupe] ${removals.length} Eintrag/Einträge manuell bereinigt.`);
  sendJson(res, 200, { removed: removals.length, total: s.activities.length });
});

// Spontane Trainingsempfehlung (außerhalb des Wochenplans)
// ?minutes=45&sport=run|bike|swim|strength (sport optional)
route('GET', '/api/suggest', async (req, res, urlObj) => {
  const s = await loadStore();
  sendJson(res, 200, spontaneous.suggest(s, {
    minutes: urlObj.searchParams.get('minutes'),
    sport: urlObj.searchParams.get('sport')
  }));
});

// Merkliste der Einheiten-Codes, die schon auf der Uhr / in der Technogym-App angelegt sind
route('POST', '/api/workout-library', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const code = String((body && body.code) || '').trim().toUpperCase();
  if (!/^[A-Z]{1,2}(-[A-Z0-9]{1,3}){1,2}$/.test(code)) return sendError(res, 400, 'Ungültiger Code.');
  const s = await loadStore();
  s.workoutLibrary = s.workoutLibrary || {};
  if (body.created === false) {
    delete s.workoutLibrary[code];
  } else {
    s.workoutLibrary[code] = {
      at: new Date().toISOString(),
      title: String(body.title || '').slice(0, 60),
      device: body.device === 'technogym' ? 'technogym' : 'watch'
    };
  }
  await saveStore(s);
  sendJson(res, 200, { library: s.workoutLibrary });
});

// Passt eine Plan-Einheit an die Erholung an (locker statt hart) oder macht das rückgängig
route('POST', '/api/plan/adjust-session', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const { sessionId, action, reason } = body || {};
  if (!sessionId || !['easy', 'undo'].includes(action)) {
    return sendError(res, 400, 'Felder "sessionId" und "action" (easy|undo) sind erforderlich.');
  }
  const s = await loadStore();
  const result = planner.adjustSession(s, sessionId, action, reason);
  if (result.error) return sendError(res, 404, result.error);
  await saveStore(s);
  sendJson(res, 200, { session: result.session });
});

// Löscht eine einzelne Aktivität (z.B. Test-Trainings, die man in Health/Strava
// zwar entfernt hat, die aber - da unser Import rein additiv ist, siehe
// health-import.js/health-auto-export.js - sonst für immer in der App
// stehen blieben würden). Kein Pfad-Parameter-Routing im einfachen Router hier,
// daher als Query-Parameter statt "/api/activities/:id".
function performanceInfo(s) {
  const run = performance.runPerformance(s);
  return {
    run: run ? Object.assign({}, run, { tenK: performance.formatTime(run.tenKSec), table: performance.paceTable(run.tenKSec) }) : null,
    runTest: s.athlete.runTest || null,
    ftp: s.athlete.ftp || null,
    lthr: performance.lthrInfo(s)
  };
}

// Gefühlte Anstrengung (RPE 1–10) zu einer Aktivität speichern; rpe null = löschen
route('POST', '/api/activities/feedback', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const s = await loadStore();
  const act = s.activities.find((a) => a.id === body.id);
  if (!act) return sendError(res, 404, 'Aktivität nicht gefunden.');
  if (body.rpe === null) {
    delete act.rpe;
    act.rpeSkipped = !!body.skip;
  } else {
    const rpe = Math.round(Number(body.rpe));
    if (!(rpe >= 1 && rpe <= 10)) return sendError(res, 400, 'RPE muss zwischen 1 und 10 liegen.');
    act.rpe = rpe;
    delete act.rpeSkipped;
  }
  await saveStore(s);
  sendJson(res, 200, { ok: true, rpe: act.rpe || null });
});

// Sportart einer Aktivität korrigieren. learn=true: alle Einträge mit demselben
// Namen aus Apple Health (jetzt und künftig) genauso einordnen.
route('POST', '/api/activities/type', async (req, res) => {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültiger JSON-Body: ' + err.message);
  }
  const type = body && body.type;
  if (!healthImport.VALID_MANUAL_SPORTS.includes(type)) return sendError(res, 400, 'Unbekannte Sportart.');
  const s = await loadStore();
  const act = s.activities.find((a) => a.id === body.id);
  if (!act) return sendError(res, 404, 'Aktivität nicht gefunden.');
  act.type = type;
  act.typeOverride = true;
  let affected = 1;
  const key = (act.rawType || '').trim().toLowerCase();
  if (body.learn && key && act.source !== 'manual') {
    s.athlete.typeRules = Object.assign({}, s.athlete.typeRules, { [key]: type });
    for (const a of s.activities) {
      if (a !== act && !a.typeOverride && (a.rawType || '').trim().toLowerCase() === key) {
        a.type = type;
        affected++;
      }
    }
  }
  planner.autoMarkDone(s);
  await saveStore(s);
  sendJson(res, 200, { ok: true, affected });
});

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
  dedupe.removeDuplicates(s);
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
  }

  // Ruhepuls/Maximalpuls automatisch übernehmen, falls in den Einstellungen
  // noch leer (siehe deriveAthleteDefaults in health-auto-export.js) - macht
  // die Trainingslast-Berechnung ab dem nächsten Sync spürbar genauer.
  const athleteDefaults = healthAutoExport.deriveAthleteDefaults(s, body);

  // Schlaf / HRV / Ruhepuls (zweite Automation mit Datentyp "Gesundheitsmetriken")
  const metricCounts = recovery.mergeHealthMetrics(s, body);
  const planMarked = result.imported.length > 0 ? planner.autoMarkDone(s) : false;
  const hrChanges = athleteHr.updateAutoHR(s);
  if (Object.keys(hrChanges).length) console.log('[puls] automatisch aktualisiert:', JSON.stringify(hrChanges));
  const metricsMerged = metricCounts.sleep + metricCounts.hrv + metricCounts.restingHR > 0 || !!metricCounts.payloadOnly;
  if (metricCounts.payloadOnly) {
    console.log('[health-auto-export] Gesundheitsmetriken empfangen, aber nichts erkannt:', JSON.stringify(s.health.lastPayload.metrics));
  }
  if (metricsMerged) {
    console.log(`[health-auto-export] Gesundheitsdaten übernommen: ${metricCounts.sleep} Nächte Schlaf, ${metricCounts.hrv} Tage HRV, ${metricCounts.restingHR} Tage Ruhepuls.`);
  }

  // Doppelt erfasste Workouts (z.B. Watch + Strava-Kopie) direkt aussortieren
  const deduped = result.imported.length > 0 ? dedupe.removeDuplicates(s) : [];
  if (deduped.length) {
    console.log(`[dedupe] ${deduped.length} doppelte/zu kurze Einträge beim Import entfernt.`);
  }

  if (result.imported.length > 0 || Object.keys(athleteDefaults).length > 0 || metricsMerged || Object.keys(hrChanges).length > 0 || planMarked) {
    await saveStore(s);
  }

  console.log(
    `[health-auto-export] ${result.totalWorkouts} Workout(s) im Payload, ${result.imported.length} importiert, ${result.skipped.length} übersprungen.`
  );
  if (result.totalWorkouts > 0 && result.imported.length === 0) {
    console.log('[health-auto-export] Keines der Workouts konnte geparst werden. Felder des ersten Eintrags:', result.skipped[0]);
  }
  if (Object.keys(athleteDefaults).length > 0) {
    console.log('[health-auto-export] Athlet-Einstellungen automatisch abgeleitet:', athleteDefaults);
  }

  sendJson(res, 200, {
    received: true,
    totalWorkouts: result.totalWorkouts,
    imported: result.imported.length,
    skipped: result.skipped.length,
    duplicatesRemoved: deduped.length,
    healthMetrics: metricCounts,
    athleteDefaultsSet: athleteDefaults,
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
  // Puls: geänderter Wert = manuell, leeres Feld oder "auto" = wieder automatisch
  for (const key of ['maxHR', 'restingHR']) {
    const srcKey = key + 'Source';
    if (body[key + 'Auto'] === true || body[key] === null || body[key] === '') {
      s.athlete[srcKey] = 'auto';
      if (key === 'restingHR') s.athlete.restingHRUpdatedAt = null;
      delete body[key];
    } else if (body[key] !== undefined && Number(body[key]) !== Number(s.athlete[key])) {
      s.athlete[srcKey] = 'manual';
    }
  }
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      s.athlete[key] = body[key];
    }
  }
  athleteHr.updateAutoHR(s, { force: true });

  // Laufleistung (Bestzeit) und FTP
  if (body.runTest !== undefined) {
    const t = body.runTest;
    const sec = t ? performance.parseTime(t.time) : null;
    s.athlete.runTest = t && performance.RUN_DISTANCES[t.distance] && sec ? { distance: t.distance, timeSec: sec, date: new Date().toISOString().slice(0, 10) } : null;
  }
  if (body.lthr !== undefined) {
    const l = Math.round(Number(body.lthr));
    s.athlete.lthr = l >= 120 && l <= 210 ? l : null;
  }
  if (body.ftp !== undefined) {
    const f = Math.round(Number(body.ftp));
    s.athlete.ftp = f >= 80 && f <= 600 ? f : null;
  }

  // Saisonziel
  let replanned = false;
  if (body.goal && typeof body.goal === 'object') {
    const g = body.goal;
    const date = typeof g.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.date) ? g.date : null;
    s.athlete.goal = {
      name: String(g.name || '').slice(0, 60),
      date,
      distance: ['sprint', 'olympic', 'half', 'full', 'run10k', 'runHalf', 'marathon', 'none'].includes(g.distance) ? g.distance : 'olympic',
      weeklyHours: Math.min(25, Math.max(2, Number(g.weeklyHours) || 6)),
      strengthPerWeek: Math.min(3, Math.max(0, Math.round(Number(g.strengthPerWeek) || 0))),
      mobilityPerWeek: Math.min(4, Math.max(0, Math.round(Number(g.mobilityPerWeek ?? 2) || 0))),
      restDays: Array.isArray(g.restDays) ? [...new Set(g.restDays.map(Number).filter((d) => d >= 0 && d <= 6))].slice(0, 3) : [0]
    };
    planner.replanCurrentWeek(s);
    replanned = true;
  }
  await saveStore(s);
  sendJson(res, 200, { athlete: s.athlete, replanned });
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
  const plan = planner.replanCurrentWeek(s);
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

// Öffentlicher Keep-alive für UptimeRobot: liest einmal aus der Datenbank, damit
// Render UND Supabase wach bleiben – gibt aber keine Daten heraus.
route('GET', '/api/health', async (req, res) => {
  const s = await loadStore();
  sendJson(res, 200, { ok: true, activities: s.activities.length > 0, time: new Date().toISOString() });
});

// ---------- Anmeldung ----------

route('GET', '/api/auth-status', async (req, res) => {
  sendJson(res, 200, { enabled: auth.enabled(), authenticated: auth.isAuthenticated(req) });
});

route('POST', '/api/login', async (req, res) => {
  if (!auth.enabled()) return sendJson(res, 200, { ok: true });
  if (auth.isBlocked(req)) return sendError(res, 429, 'Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen.');
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendError(res, 400, 'Ungültige Anfrage.');
  }
  if (!auth.checkPassword(body && body.password)) {
    auth.recordFailure(req);
    console.warn(`[auth] Fehlgeschlagener Login von ${auth.clientIp(req)}`);
    return sendError(res, 401, 'Falsches Passwort.');
  }
  res.setHeader('Set-Cookie', auth.sessionCookie(req));
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/logout', async (req, res) => {
  res.setHeader('Set-Cookie', auth.clearCookie(req));
  sendJson(res, 200, { ok: true });
});

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  // CORS: erlaubt Aufrufe von außerhalb der eigenen App-Origin (z.B. eine lokal
  // geöffnete HTML-Datei für einmalige Skripte/Backfill-Importe). Single-User-App
  // mit Token-Auth auf den sensiblen Routen - ein offener Access-Control-Allow-Origin
  // ist hier unkritisch. Ohne das blockiert der Browser (v.a. Safari) den Zugriff
  // von file://-Seiten mit "Load failed", noch bevor die Anfrage den Server erreicht.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // HEAD wie GET behandeln (u.a. für Uptime-Monitore wie UptimeRobot, die
    // standardmäßig HEAD statt GET schicken, um Bandbreite zu sparen) - ohne
    // das würde jeder Wach-halt-Ping fälschlich als 404 gewertet.
    const routeMethod = req.method === 'HEAD' ? 'GET' : req.method;

    if (auth.requiresAuth(pathname) && !auth.isAuthenticated(req)) {
      sendError(res, 401, 'Bitte anmelden.');
      return;
    }

    const matched = matchRoute(routeMethod, pathname);
    if (matched) {
      const mutates = routeMethod !== 'GET' || pathname === '/api/state';
      if (mutates) await withWriteLock(() => matched.handler(req, res, urlObj));
      else await matched.handler(req, res, urlObj);
      return;
    }

    if (routeMethod === 'GET') {
      serveStatic(req, res, pathname, req.method === 'HEAD');
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
