// Einfacher dateibasierter Datenspeicher (JSON). Für einen einzigen Nutzer
// (Single-User-App) völlig ausreichend und macht das Deployment simpel,
// da keine Datenbank benötigt wird. Für den produktiven Betrieb auf Render
// sollte data/store.json auf einem "Persistent Disk" liegen (siehe README).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

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
    // Import direkt aus Apple Health/Fitness per iOS-Kurzbefehl (kostenlos, empfohlener Standardweg).
    // Der importToken wird beim ersten Start automatisch erzeugt (siehe load()) und schützt den
    // Import-Endpunkt davor, dass Fremde beliebige Trainingsdaten einschleusen können.
    appleHealth: {
      importToken: null,
      lastImportAt: null,
      importCount: 0
    },
    activities: [], // siehe strava.js normalizeActivity() bzw. health-import.js für Feldformat
    plan: {
      currentWeekStart: null, // 'YYYY-MM-DD' (Montag)
      weekIndex: 0, // fortlaufender Zähler, u.a. für Deload-Erkennung
      sessions: [], // aktuelle Wochen-Sessions
      history: [] // abgeschlossene Wochen inkl. Auswertung
    }
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  let store;
  let isNew = false;
  if (!fs.existsSync(STORE_PATH)) {
    store = defaultStore();
    isNew = true;
  } else {
    try {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge mit Default, falls neue Felder in einer neueren Version hinzukamen
      store = deepMergeDefaults(defaultStore(), parsed);
    } catch (err) {
      console.error('Fehler beim Lesen von store.json, verwende Default:', err);
      store = defaultStore();
      isNew = true;
    }
  }
  // WICHTIG (Render Free Tier hat kein persistentes Dateisystem - siehe README/
  // INSTALLATION.md): data/store.json wird bei jedem Deploy und jedem "Einschlafen"
  // der kostenlosen Instanz verworfen. Ohne diesen Fix würde dabei jedes Mal ein
  // neuer, zufälliger Import-Token erzeugt, wodurch die in der Kurzbefehl-/Health-
  // Auto-Export-Konfiguration hinterlegte URL ständig ungültig würde. Ist die
  // Umgebungsvariable APPLE_HEALTH_IMPORT_TOKEN gesetzt (Render-Dashboard →
  // Environment), gewinnt sie deshalb IMMER - sie übersteht Deploys/Neustarts,
  // weil sie Teil der Service-Konfiguration ist, nicht des Dateisystems.
  const envToken = process.env.APPLE_HEALTH_IMPORT_TOKEN;
  if (envToken && store.appleHealth.importToken !== envToken) {
    store.appleHealth.importToken = envToken;
    isNew = true;
  } else if (!envToken && !store.appleHealth.importToken) {
    // Kein Env-Var gesetzt (z.B. lokale Entwicklung) - wie bisher zufällig erzeugen.
    store.appleHealth.importToken = crypto.randomBytes(20).toString('hex');
    isNew = true;
  }
  if (isNew) {
    save(store);
  }
  return store;
}

function save(store) {
  ensureDataDir();
  const tmpPath = STORE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, STORE_PATH); // atomarer Replace, vermeidet korrupte Datei bei Absturz
}

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

module.exports = { load, save, defaultStore, STORE_PATH };
