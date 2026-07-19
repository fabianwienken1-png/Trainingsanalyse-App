// Datenspeicher der App. Zwei Modi, automatisch anhand der Umgebungsvariablen
// SUPABASE_URL/SUPABASE_SERVICE_KEY gewählt:
//
//  - "Remote"-Modus (produktiv, empfohlen): Ein einzelner JSON-Blob wird per
//    Supabase-REST-API (PostgREST, https://<projekt>.supabase.co/rest/v1/...)
//    gelesen/geschrieben - dafür wird ausschließlich das in Node 18+ eingebaute
//    `fetch` genutzt, keine neue npm-Abhängigkeit nötig. Grund: Render's
//    kostenlose Instanzen haben KEIN persistentes Dateisystem (siehe
//    INSTALLATION.md/README) - alles, was lokal auf Disk landet, geht bei jedem
//    Deploy und jeder Ruhephase nach 15 Min Inaktivität verloren. Supabase's
//    kostenloser Tier pausiert Projekte zwar nach 7 Tagen Inaktivität, verliert
//    dabei aber keine Daten (nur manuelles Fortsetzen im Dashboard nötig) -
//    ein großer Unterschied zum Datenverlust auf Render.
//  - "Lokal"-Modus (Fallback, z.B. lokales Testen ohne Supabase-Zugangsdaten):
//    wie bisher eine einfache JSON-Datei unter data/store.json.
//
// Setup: siehe INSTALLATION.md, Abschnitt "Persistenter Speicher (Supabase)".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const REMOTE_MODE = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const SUPABASE_TABLE = 'app_store';
const SUPABASE_ROW_ID = 'main'; // Single-User-App - immer genau eine Zeile

function defaultStore() {
  return {
    athlete: {
      name: 'Fabian',
      maxHR: null, // z.B. 190 - kann in den Einstellungen gesetzt werden
      restingHR: null, // z.B. 50
      gender: 'unspecified', // 'male' | 'female' | 'unspecified' - beeinflusst TRIMP-Formel leicht
      weeklyIncreaseCap: 0.10, // max. 10% Belastungssteigerung pro Woche
      deloadEveryNWeeks: 4,
      sessionsPerWeekDefault: 4
    },
    // Optional: Import über Strava (seit Sommer 2026 kostenpflichtig, siehe README) - bleibt
    // im Code unterstützt, ist aber nicht mehr der empfohlene Standardweg.
    strava: {
      connected: false,
      athleteId: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: 0, // unix seconds
      lastSyncAt: null,
      webhookSubscriptionId: null
    },
    // Import direkt aus Apple Health/Fitness (empfohlen: Health Auto Export,
    // alternativ iOS-Kurzbefehl). Der importToken wird beim ersten Start
    // automatisch erzeugt (siehe load()) bzw. kommt fest aus der Umgebungsvariable
    // APPLE_HEALTH_IMPORT_TOKEN, damit er Deploys/Neustarts übersteht.
    appleHealth: {
      importToken: null,
      lastImportAt: null,
      importCount: 0
    },
    activities: [], // siehe strava.js normalizeActivity() bzw. health-import.js/health-auto-export.js für Feldformat
    plan: {
      currentWeekStart: null, // 'YYYY-MM-DD' (Montag)
      weekIndex: 0, // fortlaufender Zähler, u.a. für Deload-Erkennung
      sessions: [], // aktuelle Wochen-Sessions
      history: [] // abgeschlossene Wochen inkl. Auswertung
    }
  };
}

// ---------- Remote (Supabase) I/O ----------

function supabaseHeaders(extra) {
  // Supabase hat 2026 auf ein neues API-Key-Format umgestellt (sb_secret_...
  // statt der alten service_role-JWTs). Laut offizieller Migrations-Doku
  // müssen die neuen Keys AUSSCHLIESSLICH über den apikey-Header gesendet
  // werden - ein zusätzlicher "Authorization: Bearer"-Header lässt Supabase
  // den Wert fälschlich als JWT parsen und mit 401 ablehnen. Nur apikey
  // senden funktioniert sowohl mit den alten als auch den neuen Keys.
  return {
    apikey: SUPABASE_SERVICE_KEY,
    ...extra
  };
}

// Liest die eine Store-Zeile aus der Supabase-Tabelle. Gibt `null` zurück,
// wenn die Zeile noch nicht existiert (allererster Start).
async function loadFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${SUPABASE_ROW_ID}&select=data`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase-Laden fehlgeschlagen (HTTP ${res.status}): ${text}`);
  }
  const rows = await res.json();
  return rows.length > 0 ? rows[0].data : null;
}

// Schreibt den kompletten Store als Upsert (Prefer: resolution=merge-duplicates
// sorgt dafür, dass die bestehende Zeile überschrieben statt ein Duplikat-
// Fehler geworfen wird - erspart eine separate "existiert Zeile schon"-Prüfung).
async function saveToSupabase(store) {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    }),
    body: JSON.stringify({ id: SUPABASE_ROW_ID, data: store, updated_at: new Date().toISOString() })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase-Speichern fehlgeschlagen (HTTP ${res.status}): ${text}`);
  }
}

// ---------- Lokale Datei I/O (Fallback) ----------

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(STORE_PATH)) return null;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Fehler beim Lesen von store.json, verwende Default:', err);
    return null;
  }
}

function saveToDisk(store) {
  ensureDataDir();
  const tmpPath = STORE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, STORE_PATH); // atomarer Replace, vermeidet korrupte Datei bei Absturz
}

// ---------- Öffentliche API (async, unabhängig vom Modus) ----------

function deepMergeDefaults(defaults, actual) {
  if (Array.isArray(defaults)) return actual !== undefined ? actual : defaults;
  if (typeof defaults === 'object' && defaults !== null) {
    const result = {};
    for (const key of Object.keys(defaults)) {
      if (actual && Object.prototype.hasOwnProperty.call(actual, key)) {
        result[key] = deepMergeDefaults(defaults[key], actual[key]);
      } else {
        result[key] = defaults[key];
      }
    }
    // Zusätzliche Felder aus actual übernehmen, die nicht in defaults sind
    if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
      for (const key of Object.keys(actual)) {
        if (!Object.prototype.hasOwnProperty.call(result, key)) {
          result[key] = actual[key];
        }
      }
    }
    return result;
  }
  return actual !== undefined ? actual : defaults;
}

async function load() {
  let parsed;
  if (REMOTE_MODE) {
    parsed = await loadFromSupabase();
  } else {
    parsed = loadFromDisk();
  }

  let store;
  let isNew = false;
  if (parsed === null) {
    store = defaultStore();
    isNew = true;
  } else {
    // Merge mit Default, falls neue Felder in einer neueren Version hinzukamen
    store = deepMergeDefaults(defaultStore(), parsed);
  }

  // Import-Token: bevorzugt aus der Umgebungsvariable (übersteht auch im
  // Lokal-Modus einen Neustart ohne Supabase; im Remote-Modus rein zur
  // Absicherung, falls die Tabelle mal manuell zurückgesetzt wird).
  const envToken = process.env.APPLE_HEALTH_IMPORT_TOKEN;
  if (envToken && store.appleHealth.importToken !== envToken) {
    store.appleHealth.importToken = envToken;
    isNew = true;
  } else if (!envToken && !store.appleHealth.importToken) {
    store.appleHealth.importToken = crypto.randomBytes(20).toString('hex');
    isNew = true;
  }

  if (isNew) {
    await save(store);
  }
  return store;
}

async function save(store) {
  if (REMOTE_MODE) {
    await saveToSupabase(store);
  } else {
    saveToDisk(store);
  }
}

module.exports = { load, save, defaultStore, STORE_PATH, REMOTE_MODE };
