// Nimmt Trainingsdaten entgegen, die ein iOS-Kurzbefehl (Shortcuts-App) direkt
// aus Apple Health/Fitness exportiert und an unseren Server sendet (siehe README,
// Abschnitt "Apple Health per Kurzbefehl verbinden"). Ersetzt die Strava-Anbindung
// als kostenlosen, empfohlenen Standardweg.
//
// Der Kurzbefehl schickt bewusst nur die robust auslesbaren Basiswerte
// (Sportart, Start-/Endzeit, Dauer, Distanz, Kalorien, Höhenmeter) - Herzfrequenz
// lässt sich über Shortcuts in der Praxis nur unzuverlässig pro Training auslesen
// (siehe Diskussionen in der Apple-Community) und wird daher bewusst nicht
// vorausgesetzt. Die Analyse-Engine (analysis.js) kommt ohnehin auch ohne
// Herzfrequenz aus und schätzt die Trainingslast dann über Sportart + Dauer.

// Ordnet die von Health/Shortcuts gelieferte Trainingsart (deutsch oder englisch,
// je nach iPhone-Spracheinstellung) auf unsere interne Sportart-Taxonomie ab,
// die analysis.js und planner.js verwenden (Run, Ride, Swim, WeightTraining, ...).
// Bewusst über Teilstring-Erkennung statt exakter Liste, damit Locale-Varianten
// ("Laufen im Freien", "Outdoor Run", "Running", ...) automatisch abgedeckt sind.
function mapWorkoutType(rawType) {
  const t = (rawType || '').toLowerCase();

  // "ausführ..." zusätzlich zu "lauf"/"run": Health Auto Export übersetzt den
  // englischen Workout-Namen "Run" fälschlich als "Ausführen" (im Sinne von
  // "ein Programm ausführen") statt als Sportart "Laufen" - siehe echte
  // Export-Beispieldaten. Ohne diesen Fall würde "Outdoor Ausführen" in den
  // generischen "Workout"-Fallback statt "Run" fallen.
  if (t.includes('lauf') || t.includes('run') || t.includes('ausführ') || t.includes('ausfuhr')) {
    if (t.includes('trail')) return 'TrailRun';
    return 'Run';
  }
  if (t.includes('rad') || t.includes('cycl') || t.includes('bike')) return 'Ride';
  if (t.includes('schwimm') || t.includes('swim')) return 'Swim';
  if (t.includes('wander') || t.includes('hik')) return 'Hike';
  if (t.includes('geh') || t.includes('walk') || t.includes('spazier')) return 'Walk';
  if (t.includes('yoga')) return 'Yoga';
  if (t.includes('kraft') || t.includes('strength')) return 'WeightTraining';

  return 'Workout'; // generischer Fallback (z.B. HIIT, Rudern, Crosstrainer, ...)
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Prüft den vom Kurzbefehl gesendeten Payload auf die minimal nötigen Felder.
// Gibt entweder { ok: true, data } oder { ok: false, error } zurück.
function validatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Kein gültiges JSON-Objekt empfangen.' };
  }
  if (!body.startDate || Number.isNaN(new Date(body.startDate).getTime())) {
    return { ok: false, error: 'Feld "startDate" fehlt oder ist kein gültiges Datum (ISO-8601 erwartet, z.B. 2026-07-19T07:30:00Z).' };
  }
  if (!isFiniteNumber(body.durationSec) || body.durationSec <= 0) {
    return { ok: false, error: 'Feld "durationSec" fehlt oder ist keine positive Zahl (Dauer in Sekunden erwartet).' };
  }
  if (!body.type || typeof body.type !== 'string') {
    return { ok: false, error: 'Feld "type" fehlt (Trainingsart als Text, z.B. "Laufen im Freien").' };
  }
  return { ok: true };
}

// Erzeugt einen stabilen Id-Schlüssel aus Startzeit + Sportart, damit derselbe
// Kurzbefehl-Aufruf (z.B. bei einer iOS-Wiederholung nach Netzwerkfehler) nicht
// zweimal dieselbe Aktivität anlegt, sondern den bestehenden Eintrag aktualisiert.
function buildStableId(startDateIso, rawType) {
  const minuteBucket = startDateIso.slice(0, 16); // 'YYYY-MM-DDTHH:MM'
  const typeSlug = (rawType || 'workout').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `health_${minuteBucket}_${typeSlug}`;
}

function normalizeHealthPayload(body) {
  const startDate = new Date(body.startDate).toISOString();
  const sport = mapWorkoutType(body.type);

  return {
    id: body.id ? `health_${body.id}` : buildStableId(startDate, body.type),
    source: 'apple_health',
    name: body.type || sport,
    rawType: body.type || null, // Original-Bezeichnung aus Health, für Transparenz/Debugging
    type: sport,
    startDate,
    movingTimeSec: Math.round(body.durationSec),
    elapsedTimeSec: Math.round(body.elapsedSec || body.durationSec),
    distanceMeters: isFiniteNumber(body.distanceMeters) ? body.distanceMeters : 0,
    elevationGainMeters: isFiniteNumber(body.elevationGainMeters) ? body.elevationGainMeters : 0,
    averageHeartrate: isFiniteNumber(body.averageHeartrate) ? body.averageHeartrate : null,
    maxHeartrate: isFiniteNumber(body.maxHeartrate) ? body.maxHeartrate : null,
    averageWatts: null,
    sufferScore: null,
    averageSpeedMs: null,
    activeEnergyKcal: isFiniteNumber(body.activeEnergyKcal) ? body.activeEnergyKcal : null
  };
}

// Fügt eine per Health-Import normalisierte Aktivität in store.activities ein
// (Dedupe nach id - siehe buildStableId) und sortiert danach wieder nach Datum.
function mergeHealthActivity(store, normalized) {
  const idx = store.activities.findIndex((a) => a.id === normalized.id);
  if (idx >= 0) {
    store.activities[idx] = normalized;
  } else {
    store.activities.push(normalized);
  }
  store.activities.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
}

// Manuelle Aktivitäten (siehe Verbesserungs-Roadmap, Phase 3): für Einheiten,
// die Health/Strava nicht sauber erfasst (Studio-Kurs ohne Uhr, Krafttraining
// ohne Tracking o.ä.). Bewusst nur eine feste Liste bekannter Sportarten
// zugelassen (statt Freitext), damit analysis.js/planner.js sie genauso wie
// importierte Aktivitäten behandeln können (Fallback-Intensitätsfaktoren etc.
// sind pro Sportart hinterlegt).
const VALID_MANUAL_SPORTS = [
  'Run', 'TrailRun', 'Ride', 'VirtualRide', 'Swim',
  'WeightTraining', 'Walk', 'Hike', 'Yoga', 'Workout'
];

function validateManualActivity(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Kein gültiges JSON-Objekt empfangen.' };
  }
  if (!body.startDate || Number.isNaN(new Date(body.startDate).getTime())) {
    return { ok: false, error: 'Feld "startDate" fehlt oder ist kein gültiges Datum.' };
  }
  if (!isFiniteNumber(body.durationMin) || body.durationMin <= 0) {
    return { ok: false, error: 'Feld "durationMin" fehlt oder ist keine positive Zahl (Dauer in Minuten erwartet).' };
  }
  if (!body.type || !VALID_MANUAL_SPORTS.includes(body.type)) {
    return { ok: false, error: `Feld "type" fehlt oder ist keine unterstützte Sportart (${VALID_MANUAL_SPORTS.join(', ')}).` };
  }
  return { ok: true };
}

function normalizeManualActivity(body) {
  const startDate = new Date(body.startDate).toISOString();
  const movingTimeSec = Math.round(body.durationMin * 60);
  return {
    id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: 'manual',
    name: body.name || body.type,
    rawType: null,
    type: body.type,
    startDate,
    movingTimeSec,
    elapsedTimeSec: movingTimeSec,
    distanceMeters: isFiniteNumber(body.distanceKm) ? Math.round(body.distanceKm * 1000) : 0,
    elevationGainMeters: 0,
    averageHeartrate: isFiniteNumber(body.averageHeartrate) ? body.averageHeartrate : null,
    maxHeartrate: null,
    averageWatts: null,
    sufferScore: null,
    averageSpeedMs: null,
    activeEnergyKcal: null
  };
}

module.exports = {
  mapWorkoutType,
  validatePayload,
  normalizeHealthPayload,
  mergeHealthActivity,
  buildStableId,
  VALID_MANUAL_SPORTS,
  validateManualActivity,
  normalizeManualActivity
};
