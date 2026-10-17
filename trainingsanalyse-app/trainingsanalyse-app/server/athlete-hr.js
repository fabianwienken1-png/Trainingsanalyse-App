// Automatische Pflege von Maximal- und Ruhepuls.
//
// Maximalpuls: der höchste Wert, der durch mindestens ein zweites Training
// bestätigt wird (±3 Schläge). Einzelne Messfehler der optischen Pulsmessung
// (z.B. ein Ausreißer auf 210) fallen dadurch heraus. Berücksichtigt werden
// Trainings der letzten 2 Jahre mit mindestens 10 Minuten Dauer.
//
// Ruhepuls: Ø der letzten 14 Tage aus den täglichen Ruhepuls-Werten der Watch
// (store.health.restingHR, kommt über die Automation "Schlaf und Erholung"),
// höchstens einmal pro Woche aktualisiert.
//
// Beides nur, solange der Wert auf "automatisch" steht. Trägt der Nutzer in den
// Einstellungen selbst einen Wert ein, bleibt dieser unangetastet.

const DAY_MS = 24 * 60 * 60 * 1000;
const RESTING_UPDATE_EVERY_MS = 7 * DAY_MS;

function robustMaxHR(activities) {
  const cutoff = Date.now() - 730 * DAY_MS;
  const values = activities
    .filter((a) => typeof a.maxHeartrate === 'number'
      && a.maxHeartrate >= 120 && a.maxHeartrate <= 230
      && (a.movingTimeSec || 0) >= 600
      && new Date(a.startDate).getTime() >= cutoff)
    .map((a) => Math.round(a.maxHeartrate))
    .sort((x, y) => y - x);
  if (!values.length) return null;
  for (const v of values) {
    const confirmations = values.filter((x) => x <= v && x >= v - 3).length;
    if (confirmations >= 2) return v;
  }
  return values[0];
}

function recentRestingHR(health, now = Date.now()) {
  const map = (health && health.restingHR) || {};
  const cutoff = new Date(now - 14 * DAY_MS).toISOString().slice(0, 10);
  const vals = Object.entries(map)
    .filter(([day, v]) => day >= cutoff && typeof v === 'number' && v >= 30 && v <= 110)
    .map(([, v]) => v);
  if (vals.length < 5) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// Aktualisiert die automatischen Werte im Store. Gibt die Änderungen zurück
// (leeres Objekt = nichts geändert). force: Ruhepuls sofort neu berechnen.
function updateAutoHR(store, { force = false } = {}) {
  const a = store.athlete;
  const changes = {};
  if (!a.maxHRSource) a.maxHRSource = 'auto';
  if (!a.restingHRSource) a.restingHRSource = 'auto';

  if (a.maxHRSource === 'auto') {
    const max = robustMaxHR(store.activities || []);
    if (max && max !== a.maxHR) {
      changes.maxHR = { from: a.maxHR, to: max };
      a.maxHR = max;
    }
  }

  if (a.restingHRSource === 'auto') {
    const due = force || !a.restingHRUpdatedAt || Date.now() - new Date(a.restingHRUpdatedAt).getTime() > RESTING_UPDATE_EVERY_MS;
    if (due) {
      const rhr = recentRestingHR(store.health);
      if (rhr) {
        if (rhr !== a.restingHR) changes.restingHR = { from: a.restingHR, to: rhr };
        a.restingHR = rhr;
        a.restingHRUpdatedAt = new Date().toISOString();
      }
    }
  }
  return changes;
}

module.exports = { robustMaxHR, recentRestingHR, updateAutoHR };
