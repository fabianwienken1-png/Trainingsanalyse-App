// Leistungswerte für konkrete Vorgaben und Auswertungen:
//  - Lauf: Tempo-Bereiche (min/km) aus einer Bestzeit oder – falls keine
//    eingetragen ist – geschätzt aus deinen Läufen mit Puls.
//  - Rad: Watt-Bereiche aus der FTP (Functional Threshold Power).
//  - Gefühlte Anstrengung (RPE 1–10) nach dem Training.
//  - Langzeit-Trends (Ruhepuls, HRV, Lauf-Effizienz).

const analysis = require('./analysis');

const DAY_MS = 24 * 60 * 60 * 1000;

const RUN_DISTANCES = { '5k': 5000, '10k': 10000, half: 21097.5, marathon: 42195 };
const RUN_DISTANCE_LABEL = { '5k': '5 km', '10k': '10 km', half: 'Halbmarathon', marathon: 'Marathon' };

// "45:30", "1:52:10" oder "45" (Minuten) → Sekunden
function parseTime(str) {
  if (typeof str === 'number') return str > 0 ? Math.round(str) : null;
  const parts = String(str || '').trim().split(':').map((p) => Number(p.replace(',', '.')));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  let sec;
  if (parts.length === 1) sec = parts[0] * 60;
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  return sec > 0 ? Math.round(sec) : null;
}

function formatTime(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function formatPace(secPerKm) {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Riegel-Formel: Zeit auf andere Distanz umrechnen
function riegel(timeSec, fromM, toM) {
  return timeSec * Math.pow(toM / fromM, 1.06);
}

// Geschätzte 10-km-Zeit aus normalen Trainingsläufen: Tempo und Puls jedes Laufs
// werden auf Wettkampfanstrengung (~92 % der Herzfrequenzreserve) hochgerechnet.
// Median der letzten Läufe → robust gegen einzelne Ausreißer.
function estimate10k(activities, athlete, now = Date.now()) {
  const runs = (activities || []).filter((a) => a.type === 'Run'
    && a.distanceMeters >= 3000 && a.movingTimeSec > 0
    && now - new Date(a.startDate).getTime() <= 180 * DAY_MS)
    .slice(0, 15);
  if (!runs.length) return null;
  const hrOk = athlete.maxHR && athlete.restingHR && athlete.maxHR > athlete.restingHR;
  const estimates = [];
  for (const r of runs) {
    let speed = r.distanceMeters / r.movingTimeSec; // m/s
    if (hrOk && r.averageHeartrate) {
      const hrr = (r.averageHeartrate - athlete.restingHR) / (athlete.maxHR - athlete.restingHR);
      if (hrr < 0.5 || hrr > 0.97) continue;
      speed *= Math.pow((0.92 - 0.15) / (hrr - 0.15), 0.6);
      estimates.push(10000 / speed);
    } else if (!hrOk) {
      estimates.push(riegel(r.movingTimeSec, r.distanceMeters, 10000));
    }
  }
  if (estimates.length < 2) return null;
  estimates.sort((a, b) => a - b);
  const mid = estimates[Math.floor(estimates.length / 2)];
  return Math.round(Math.min(Math.max(mid, 30 * 60), 90 * 60));
}

// Laufleistung: eingetragene Bestzeit oder Schätzung → 10-km-Zeit
function runPerformance(store) {
  const a = store.athlete || {};
  const t = a.runTest;
  if (t && RUN_DISTANCES[t.distance] && t.timeSec > 0) {
    const tenK = riegel(t.timeSec, RUN_DISTANCES[t.distance], 10000);
    return { source: 'manual', tenKSec: Math.round(tenK), basis: `${RUN_DISTANCE_LABEL[t.distance]} in ${formatTime(t.timeSec)}` };
  }
  const est = estimate10k(store.activities, a);
  if (est) return { source: 'auto', tenKSec: est, basis: 'geschätzt aus deinen Läufen mit Puls' };
  return null;
}

// Tempo-Faktoren relativ zum 10-km-Tempo je Pulszone [langsam, schnell]
const PACE_FACTOR = { 1: [1.45, 1.3], 2: [1.32, 1.18], 3: [1.13, 1.06], 4: [1.05, 0.99], 5: [0.98, 0.92] };

function paceForZone(tenKSec, z, pos = 0.5) {
  const f = PACE_FACTOR[z];
  if (!f || !tenKSec) return null;
  const center = (tenKSec / 10) * (f[0] + (f[1] - f[0]) * pos);
  const spread = z <= 2 ? 0.035 : 0.02;
  const slow = center * (1 + spread);
  const fast = center * (1 - spread);
  return {
    text: `${formatPace(fast)}–${formatPace(slow)} /km`,
    kmh: `${(3600 / slow).toFixed(1).replace('.', ',')}–${(3600 / fast).toFixed(1).replace('.', ',')} km/h`,
    center: Math.round(center)
  };
}

// Tempo-Übersicht für die Einstellungen
function paceTable(tenKSec) {
  if (!tenKSec) return null;
  return {
    easy: paceForZone(tenKSec, 2, 0.5),
    tempo: paceForZone(tenKSec, 3, 0.6),
    threshold: paceForZone(tenKSec, 4, 0.5),
    interval: paceForZone(tenKSec, 5, 0.3),
    predictions: {
      '5k': formatTime(riegel(tenKSec, 10000, 5000)),
      '10k': formatTime(tenKSec),
      half: formatTime(riegel(tenKSec, 10000, 21097.5)),
      marathon: formatTime(riegel(tenKSec, 10000, 42195) * 1.03)
    }
  };
}

// Watt-Bereiche (Anteil der FTP) je Pulszone
const POWER_FACTOR = { 1: [0.45, 0.55], 2: [0.6, 0.75], 3: [0.84, 0.94], 4: [0.95, 1.05], 5: [1.06, 1.2] };

function wattsForZone(ftp, z, pos = 0.5) {
  const f = POWER_FACTOR[z];
  if (!f || !ftp) return null;
  const center = ftp * (f[0] + (f[1] - f[0]) * pos);
  const lo = Math.round((center - ftp * 0.025) / 5) * 5;
  const hi = Math.round((center + ftp * 0.025) / 5) * 5;
  return { text: `${lo}–${hi} W`, center: Math.round(center) };
}

// Schwellenpuls (LTHR, Laufen). Manuell eingetragen oder geschätzt:
// höchster Ø-Puls einer zusammenhängenden harten Einheit (20–70 min, letzte
// 6 Monate) – so eine Einheit liegt typischerweise knapp an der Schwelle –,
// mindestens aber 88 % des Maximalpulses (typischer Wert), höchstens 93 %.
function lthrInfo(store) {
  const a = store.athlete || {};
  const manual = Number(a.lthr);
  if (manual >= 120 && manual <= 210) return { value: Math.round(manual), source: 'manual' };
  if (!a.maxHR) return null;
  const now = Date.now();
  const sustained = (store.activities || [])
    .filter((x) => ['Run', 'TrailRun', 'Ride', 'VirtualRide'].includes(x.type) && x.averageHeartrate
      && x.movingTimeSec >= 20 * 60 && x.movingTimeSec <= 70 * 60
      && now - new Date(x.startDate).getTime() <= 180 * DAY_MS)
    .map((x) => x.averageHeartrate + (x.type === 'Ride' || x.type === 'VirtualRide' ? 5 : 0)); // Rad-Puls liegt ~5 Schläge tiefer
  const best = sustained.length ? Math.max(...sustained) : 0;
  const value = Math.round(Math.min(a.maxHR * 0.93, Math.max(a.maxHR * 0.88, best)));
  return { value, source: 'auto', basis: best >= a.maxHR * 0.88 ? 'aus deiner härtesten Einheit (20–70 min)' : '88 % deines Maximalpulses' };
}

// Vorgaben für Workouts (an buildWorkout übergeben)
function targetsFor(store) {
  const perf = runPerformance(store);
  const ftp = Number(store.athlete && store.athlete.ftp) || null;
  const lthr = lthrInfo(store);
  return {
    tenKSec: perf ? perf.tenKSec : null,
    ftp: ftp && ftp >= 80 && ftp <= 600 ? ftp : null,
    lthr: lthr ? lthr.value : null
  };
}

// ---------------------------------------------------------------------------
// Gefühlte Anstrengung (RPE)
// ---------------------------------------------------------------------------

function hrrOf(act, athlete) {
  if (!act.averageHeartrate || !athlete.maxHR || !athlete.restingHR) return null;
  return (act.averageHeartrate - athlete.restingHR) / (athlete.maxHR - athlete.restingHR);
}

// Wie fühlt sich das Training an? Grundlage für die Wochenplanung.
function rpeSignal(store, now = new Date()) {
  const athlete = store.athlete || {};
  const sessions = [...((store.plan && store.plan.sessions) || []), ...((store.plan && store.plan.history) || []).flatMap((h) => h.sessions || [])];
  const plannedBy = new Map(sessions.filter((s) => s.matchedActivityId).map((s) => [s.matchedActivityId, s]));
  const rated = (store.activities || []).filter((a) => a.rpe >= 1 && a.rpe <= 10
    && now - new Date(a.startDate) <= 14 * DAY_MS && !['Mobility', 'Yoga', 'Walk'].includes(a.type));
  const easy = [];
  const hard = [];
  for (const a of rated) {
    const planned = plannedBy.get(a.id);
    const hrr = hrrOf(a, athlete);
    const isEasy = planned ? planned.intensity === 'easy' && planned.kind !== 'strength' : hrr !== null && hrr < 0.7 && a.type !== 'WeightTraining';
    if (isEasy) easy.push(a.rpe);
    else hard.push(a.rpe);
  }
  const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
  const last7 = rated.filter((a) => now - new Date(a.startDate) <= 7 * DAY_MS).map((a) => a.rpe);
  const result = {
    count: rated.length,
    easyAvg: avg(easy), easyCount: easy.length,
    hardAvg: avg(hard), hardCount: hard.length,
    weekAvg: avg(last7), weekCount: last7.length,
    easyTooHard: easy.length >= 3 && avg(easy) >= 6,
    overloaded: last7.length >= 3 && avg(last7) >= 7.5,
    fresh: easy.length >= 3 && hard.length >= 1 && avg(easy) <= 3 && avg(hard) <= 6
  };
  return result;
}

// ---------------------------------------------------------------------------
// Langzeit-Trends (Wochenwerte, 26 Wochen)
// ---------------------------------------------------------------------------

function mondayOf(dayKey) {
  const d = new Date(dayKey + 'T00:00:00Z');
  const wd = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((wd === 0 ? -6 : 1) - wd));
  return d.toISOString().slice(0, 10);
}

function weeklyFromDayMap(map, weeks) {
  const by = new Map(weeks.map((w) => [w, []]));
  for (const [day, v] of Object.entries(map || {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const w = mondayOf(day);
    if (by.has(w)) by.get(w).push(v);
  }
  return weeks.map((w) => {
    const vals = by.get(w);
    return { week: w, value: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null, n: vals.length };
  });
}

function trends(store, now = new Date(), count = 26) {
  const thisMonday = mondayOf(analysis.dayKeyOf(now));
  const weeks = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(thisMonday + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - i * 7);
    weeks.push(d.toISOString().slice(0, 10));
  }
  const health = store.health || {};

  // Lauf-Effizienz: Meter pro Herzschlag (Tempo in m/min ÷ Ø-Puls).
  // Steigt der Wert, läufst du bei gleichem Puls schneller → aerobe Fitness wächst.
  const effByWeek = new Map(weeks.map((w) => [w, []]));
  for (const a of store.activities || []) {
    if (!['Run', 'TrailRun'].includes(a.type) || !a.averageHeartrate || !(a.distanceMeters > 2000) || !(a.movingTimeSec > 600)) continue;
    const w = mondayOf(analysis.dayKeyOf(new Date(a.startDate)));
    if (!effByWeek.has(w)) continue;
    const mPerMin = a.distanceMeters / (a.movingTimeSec / 60);
    effByWeek.get(w).push(mPerMin / a.averageHeartrate);
  }
  const runEff = weeks.map((w) => {
    const v = effByWeek.get(w);
    return { week: w, value: v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 100) / 100 : null, n: v.length };
  });

  return {
    weeks,
    restingHR: weeklyFromDayMap(health.restingHR, weeks),
    hrv: weeklyFromDayMap(health.hrv, weeks),
    runEfficiency: runEff
  };
}

module.exports = {
  RUN_DISTANCES,
  RUN_DISTANCE_LABEL,
  parseTime,
  formatTime,
  formatPace,
  runPerformance,
  paceForZone,
  paceTable,
  wattsForZone,
  lthrInfo,
  targetsFor,
  rpeSignal,
  trends
};
