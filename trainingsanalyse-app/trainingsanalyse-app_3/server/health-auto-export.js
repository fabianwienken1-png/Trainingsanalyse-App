// Nimmt Trainingsdaten entgegen, die von der App "Health Auto Export – JSON+CSV"
// (App Store, healthyapps.dev) automatisch im Hintergrund an unseren Server
// geschickt werden. Ersetzt den fehleranfälligen iOS-Kurzbefehl-Weg
// (siehe health-import.js) als zuverlässigere, aber kostenpflichtige Alternative:
// Health Auto Export ist eine echte native App mit HealthKit-Background-Delivery-
// Berechtigung und liefert daher deutlich zuverlässiger Daten als eine
// Shortcuts-Automation.
//
// Payload-Format laut Doku (github.com/Lybron/health-auto-export/wiki):
//   {
//     "data": {
//       "metrics": [ { "name": "heart_rate", "units": "bpm", "data": [...] }, ... ],
//       "workouts": [
//         {
//           "id": "...",
//           "name": "Running",                       // Sportart (Klartext)
//           "start": "2026-07-19 16:50:24 +0000",     // "yyyy-MM-dd HH:mm:ss Z"
//           "end": "2026-07-19 16:51:57 +0000",
//           "duration": 93,                           // Sekunden
//           "distance": { "qty": 1.2, "units": "km" },
//           "activeEnergyBurned": { "qty": 80, "units": "kcal" },
//           "heartRate": { "min": 90, "avg": 130, "max": 165 },
//           ...
//         }
//       ]
//     }
//   }
//
// WICHTIG: Das exakte Feld-Set kann je nach App-Version/Export-Einstellungen
// leicht variieren (z.B. "activeEnergy" statt "activeEnergyBurned" im älteren
// "v1"-Format). Der Parser unten versucht daher mehrere gängige Feldnamen und
// überspringt einzelne Workouts defensiv, statt den ganzen Import abzubrechen,
// falls ein Eintrag unerwartet aussieht. Bei Problemen einfach die Render-Logs
// prüfen (dort wird pro Anfrage geloggt, wie viele Workouts erkannt wurden und,
// falls keines davon verwertbar war, welche Felder der erste rohe Eintrag hat).

const { mapWorkoutType, mergeHealthActivity } = require('./health-import');

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Health Auto Export liefert Datumswerte im Format "yyyy-MM-dd HH:mm:ss Z"
// (Leerzeichen statt "T", Zeitzonen-Offset ohne Doppelpunkt, z.B. "+0000").
// Das versteht der native JS-Date-Parser nicht zuverlässig - deshalb hier
// explizit in ISO 8601 umwandeln, bevor wir es an `new Date()` übergeben.
function parseFlexibleDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{4}|[+-]\d{2}:\d{2}|Z)?$/);
  if (m) {
    let iso = `${m[1]}T${m[2]}`;
    if (m[3] && m[3] !== 'Z') {
      iso += /^[+-]\d{4}$/.test(m[3]) ? `${m[3].slice(0, 3)}:${m[3].slice(3)}` : m[3];
    } else {
      iso += 'Z';
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

// Wandelt ein { qty, units }-Objekt (Distanz) in Meter um.
function distanceToMeters(d) {
  if (!d || !isFiniteNumber(d.qty)) return 0;
  const u = String(d.units || 'km').toLowerCase();
  if (u === 'km' || u === 'kilometer' || u === 'kilometers') return d.qty * 1000;
  if (u === 'mi' || u === 'mile' || u === 'miles') return d.qty * 1609.344;
  return d.qty; // 'm', 'meter', 'meters' oder unbekannt -> als Meter annehmen
}

// Wandelt ein { qty, units }-Objekt (Energie) in kcal um.
function energyToKcal(e) {
  if (!e || !isFiniteNumber(e.qty)) return null;
  const u = String(e.units || 'kcal').toLowerCase();
  if (u === 'kj') return e.qty / 4.184;
  return e.qty; // 'kcal', 'cal' oder unbekannt -> unverändert übernehmen
}

// Wandelt ein { qty, units }-Objekt (Höhenmeter) in Meter um.
function elevationToMeters(e) {
  if (!e) return 0;
  if (isFiniteNumber(e)) return e; // manchmal direkt als Zahl statt {qty,units}
  if (!isFiniteNumber(e.qty)) return 0;
  const u = String(e.units || 'm').toLowerCase();
  if (u === 'ft' || u === 'feet') return e.qty * 0.3048;
  return e.qty;
}

function buildStableId(startDateIso, rawType) {
  const minuteBucket = startDateIso.slice(0, 16);
  const typeSlug = (rawType || 'workout').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `hae_${minuteBucket}_${typeSlug}`;
}

// Extrahiert die Workout-Liste aus verschiedenen möglichen Payload-Formen.
function extractWorkouts(body) {
  if (body && body.data && Array.isArray(body.data.workouts)) return body.data.workouts;
  if (Array.isArray(body && body.workouts)) return body.workouts;
  return [];
}

// Normalisiert ein einzelnes rohes Health-Auto-Export-Workout in unser
// internes Aktivitäts-Format (gleiche Form wie health-import.js). Gibt bei
// unbrauchbaren/unvollständigen Daten `null` zurück, statt zu werfen - der
// Aufrufer überspringt solche Einträge dann einfach.
function normalizeWorkout(w) {
  if (!w || typeof w !== 'object') return null;

  const startD = parseFlexibleDate(w.start || w.startDate || w.startTime);
  const endD = parseFlexibleDate(w.end || w.endDate || w.endTime);

  let durationSec = isFiniteNumber(w.duration) ? w.duration : null;
  if (!isFiniteNumber(durationSec) && startD && endD) {
    durationSec = Math.round((endD.getTime() - startD.getTime()) / 1000);
  }

  if (!startD || !isFiniteNumber(durationSec) || durationSec <= 0) {
    return null;
  }

  const rawType = w.name || w.workoutActivityType || w.type || 'Workout';
  const sport = mapWorkoutType(rawType);
  const startDateIso = startD.toISOString();

  const distance = w.distance || w.walkingRunningDistance || w.walkingAndRunningDistance;
  const energy = w.activeEnergyBurned || w.activeEnergy || w.totalEnergy;
  const elevation = w.elevationAscended || w.elevation || w.elevationUp;
  const hr = w.heartRate || w.heartRateData || {};

  return {
    id: w.id ? `hae_${w.id}` : buildStableId(startDateIso, rawType),
    source: 'apple_health',
    name: rawType,
    rawType,
    type: sport,
    startDate: startDateIso,
    movingTimeSec: Math.round(durationSec),
    elapsedTimeSec: Math.round(durationSec),
    distanceMeters: distanceToMeters(distance),
    elevationGainMeters: elevationToMeters(elevation),
    averageHeartrate: isFiniteNumber(hr.avg) ? hr.avg : (isFiniteNumber(hr.average) ? hr.average : null),
    maxHeartrate: isFiniteNumber(hr.max) ? hr.max : null,
    averageWatts: null,
    sufferScore: null,
    averageSpeedMs: null,
    activeEnergyKcal: energyToKcal(energy)
  };
}

// Verarbeitet den kompletten Payload: normalisiert jedes Workout, merged die
// gültigen in den Store und gibt eine kleine Statistik zurück, die der
// Route-Handler direkt als Antwort zurückschicken kann.
function processPayload(store, body) {
  const rawWorkouts = extractWorkouts(body);
  const imported = [];
  const skipped = [];

  for (const raw of rawWorkouts) {
    const normalized = normalizeWorkout(raw);
    if (normalized) {
      mergeHealthActivity(store, normalized);
      imported.push(normalized);
    } else {
      skipped.push(raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw);
    }
  }

  return { totalWorkouts: rawWorkouts.length, imported, skipped };
}

module.exports = {
  parseFlexibleDate,
  distanceToMeters,
  energyToKcal,
  elevationToMeters,
  extractWorkouts,
  normalizeWorkout,
  processPayload
};
