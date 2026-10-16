// Erkennung doppelter Trainings.
//
// Hintergrund: Wird dasselbe Training von zwei Quellen nach Apple Health
// geschrieben (z.B. Apple Watch + Strava, das sich die Einheit von Technogym
// holt und als Kopie zurückschreibt), kommen über Health Auto Export zwei
// Workouts mit unterschiedlicher ID an. Die bisherige Dedupe-Logik (exakte ID)
// erkennt das nicht.
//
// Regel: Zwei Aktivitäten gelten als Duplikat, wenn
//   - sie zur selben Sportart-Gruppe gehören (z.B. Ride/VirtualRide = Rad),
//   - ihr Start höchstens DUPLICATE_START_WINDOW_SEC auseinanderliegt und
//   - ihre Dauer sich um höchstens 20 % unterscheidet.
// Behalten wird der Eintrag mit den vollständigeren Daten (Puls, Distanz, ...).
// Zusätzlich werden versehentlich gestartete Mini-Einträge (< MIN_DURATION_SEC)
// entfernt. Manuell angelegte Aktivitäten werden nie automatisch gelöscht.

const DUPLICATE_START_WINDOW_SEC = 3 * 60;
const MIN_DURATION_RATIO = 0.8;
const MIN_DURATION_SEC = 60;

const SPORT_GROUPS = {
  Swim: 'swim',
  Ride: 'bike',
  VirtualRide: 'bike',
  Run: 'run',
  TrailRun: 'run',
  WeightTraining: 'strength'
};

function sportGroup(type) {
  return SPORT_GROUPS[type] || type || 'other';
}

function completeness(act) {
  let score = 0;
  if (act.averageHeartrate) score += 3;
  if (act.maxHeartrate) score += 1;
  if (act.distanceMeters > 0) score += 2;
  if (act.activeEnergyKcal) score += 1;
  if (act.elevationGainMeters) score += 1;
  if (act.source === 'manual') score += 10; // vom Nutzer selbst eingetragen → nie verdrängen
  return score;
}

function isDuplicatePair(a, b) {
  if (sportGroup(a.type) !== sportGroup(b.type)) return false;
  const diffSec = Math.abs(new Date(a.startDate) - new Date(b.startDate)) / 1000;
  if (diffSec > DUPLICATE_START_WINDOW_SEC) return false;
  const da = a.movingTimeSec || 0;
  const db = b.movingTimeSec || 0;
  if (!da || !db) return false;
  return Math.min(da, db) / Math.max(da, db) >= MIN_DURATION_RATIO;
}

// Liefert die zu entfernenden Aktivitäten samt Begründung, ohne den Store zu ändern.
function findRemovals(activities) {
  const sorted = [...activities].sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const removeIds = new Set();
  const removals = [];

  for (const act of sorted) {
    if (act.source !== 'manual' && (act.movingTimeSec || 0) < MIN_DURATION_SEC) {
      removeIds.add(act.id);
      removals.push({ activity: act, reason: 'zu kurz', keptId: null });
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (removeIds.has(a.id)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const gapSec = (new Date(b.startDate) - new Date(a.startDate)) / 1000;
      if (gapSec > DUPLICATE_START_WINDOW_SEC) break;
      if (removeIds.has(b.id) || !isDuplicatePair(a, b)) continue;
      // Beide manuell → bewusst vom Nutzer angelegt, nicht anfassen
      if (a.source === 'manual' && b.source === 'manual') continue;
      const keepA = completeness(a) >= completeness(b);
      const keep = keepA ? a : b;
      const drop = keepA ? b : a;
      removeIds.add(drop.id);
      removals.push({ activity: drop, reason: 'doppelt', keptId: keep.id });
      if (!keepA) break; // a ist entfernt → nächstes a
    }
  }

  return removals;
}

// Entfernt Duplikate direkt im Store. Gibt die entfernten Einträge zurück.
function removeDuplicates(store) {
  const removals = findRemovals(store.activities);
  if (removals.length) {
    const ids = new Set(removals.map((r) => r.activity.id));
    store.activities = store.activities.filter((a) => !ids.has(a.id));
  }
  return removals;
}

module.exports = { findRemovals, removeDuplicates, isDuplicatePair };
