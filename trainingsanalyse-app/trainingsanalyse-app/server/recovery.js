// Erholungsdaten (Schlaf, Herzfrequenzvariabilität, Ruhepuls) aus Health Auto
// Export übernehmen und zu einer einfachen Erholungs-Einschätzung verdichten.
//
// Health Auto Export schickt diese Werte über eine zweite Automation mit
// Datentyp "Gesundheitsmetriken" an denselben Endpunkt wie die Workouts
// (/api/import/health-auto-export). Format laut help.healthyapps.dev:
//
//   sleep_analysis (zusammengefasst):
//     { date: "2026-10-16", totalSleep: 7.2, asleep, core, deep, rem, inBed,
//       sleepStart: "2026-10-15 23:10:00 +0200", sleepEnd: "...", ... }   (Stunden)
//   sleep_analysis (einzelne Phasen):
//     { startDate, endDate, qty, value: "Core"|"REM"|"Deep"|"Asleep"|"Awake"|"In Bed", ... }
//   heart_rate_variability / resting_heart_rate:
//     { qty: 48, date: "2026-10-16 07:12:00 +0200", source }
//
// Gespeichert wird pro Kalendertag ein Wert in store.health
// ({ sleep: { 'YYYY-MM-DD': {...} }, hrv: { 'YYYY-MM-DD': ms }, restingHR: {...} }).

const KEEP_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, digits = 2) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// "2026-10-16 07:12:00 +0200" → "2026-10-16" (lokaler Kalendertag des Nutzers)
function dayOf(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function normName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
}

function extractMetrics(body) {
  if (body && body.data && Array.isArray(body.data.metrics)) return body.data.metrics;
  if (body && Array.isArray(body.metrics)) return body.metrics;
  return [];
}

function findMetric(body, names) {
  const wanted = names.map(normName);
  return extractMetrics(body).find((m) => m && wanted.includes(normName(m.name))) || null;
}

// Kurze Zusammenfassung des letzten Gesundheitsdaten-Payloads (zur Fehlersuche)
function describePayload(body) {
  return extractMetrics(body).map((m) => ({
    name: m && m.name,
    units: m && m.units,
    points: m && Array.isArray(m.data) ? m.data.length : 0,
    sampleKeys: m && Array.isArray(m.data) && m.data[0] ? Object.keys(m.data[0]) : []
  }));
}

function parseSleep(metric) {
  const out = {};
  if (!metric || !Array.isArray(metric.data)) return out;

  // Variante 1: zusammengefasst – ein Eintrag pro Nacht
  for (const d of metric.data) {
    if (!d || d.value) continue; // Einzelphasen weiter unten
    const stages = (isNum(d.core) ? d.core : 0) + (isNum(d.deep) ? d.deep : 0) + (isNum(d.rem) ? d.rem : 0);
    const total = isNum(d.totalSleep) && d.totalSleep > 0 ? d.totalSleep
      : isNum(d.asleep) && d.asleep > 0 ? d.asleep
        : stages > 0 ? stages
          : isNum(d.qty) && d.qty > 0 ? d.qty : null;
    const day = dayOf(d.sleepEnd) || dayOf(d.date) || dayOf(d.endDate);
    if (!day || !isNum(total) || total <= 0) continue;
    const entry = {
      total: round(total),
      deep: isNum(d.deep) ? round(d.deep) : null,
      rem: isNum(d.rem) ? round(d.rem) : null,
      core: isNum(d.core) ? round(d.core) : null,
      inBed: isNum(d.inBed) ? round(d.inBed) : null,
      start: d.sleepStart || d.inBedStart || null,
      end: d.sleepEnd || d.inBedEnd || null
    };
    // Mehrere Quellen am selben Tag (z.B. Watch + iPhone) → die längere Nacht behalten
    if (!out[day] || entry.total > out[day].total) out[day] = entry;
  }

  // Variante 2: Einzelphasen – pro Nacht (Tag des Aufwachens) aufsummieren
  const nights = {};
  for (const d of metric.data) {
    if (!d || !d.value || !isNum(d.qty)) continue;
    const day = dayOf(d.sleepEnd) || dayOf(d.endDate);
    if (!day) continue;
    const n = (nights[day] = nights[day] || { total: 0, deep: 0, rem: 0, core: 0, start: d.sleepStart || null, end: d.sleepEnd || null });
    const v = String(d.value).toLowerCase();
    if (['core', 'rem', 'deep', 'asleep', 'unspecified'].includes(v)) n.total += d.qty;
    if (v === 'deep') n.deep += d.qty;
    if (v === 'rem') n.rem += d.qty;
    if (v === 'core') n.core += d.qty;
  }
  for (const [day, n] of Object.entries(nights)) {
    if (n.total <= 0 || out[day]) continue;
    out[day] = {
      total: round(n.total), deep: round(n.deep), rem: round(n.rem), core: round(n.core),
      inBed: null, start: n.start, end: n.end
    };
  }
  return out;
}

// Tagesmittelwert einer normalen Metrik (z.B. mehrere HRV-Messungen pro Tag)
function parseDaily(metric) {
  const sums = {};
  if (!metric || !Array.isArray(metric.data)) return {};
  for (const d of metric.data) {
    if (!d || !isNum(d.qty)) continue;
    const day = dayOf(d.date);
    if (!day) continue;
    (sums[day] = sums[day] || []).push(d.qty);
  }
  const out = {};
  for (const [day, vals] of Object.entries(sums)) {
    out[day] = round(vals.reduce((a, b) => a + b, 0) / vals.length, 1);
  }
  return out;
}

function prune(map) {
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const day of Object.keys(map)) if (day < cutoff) delete map[day];
}

// Übernimmt Schlaf/HRV/Ruhepuls aus einem Payload in den Store.
// Gibt die Anzahl übernommener Tage je Metrik zurück.
function mergeHealthMetrics(store, body) {
  const sleep = parseSleep(findMetric(body, ['sleep_analysis']));
  const hrv = parseDaily(findMetric(body, ['heart_rate_variability', 'heart_rate_variability_sdnn', 'hrv']));
  const rhr = parseDaily(findMetric(body, ['resting_heart_rate']));
  const counts = { sleep: Object.keys(sleep).length, hrv: Object.keys(hrv).length, restingHR: Object.keys(rhr).length };
  const metrics = extractMetrics(body);
  if (metrics.length) {
    store.health = store.health || {};
    store.health.lastPayload = { at: new Date().toISOString(), metrics: describePayload(body), parsed: counts };
  }
  if (!counts.sleep && !counts.hrv && !counts.restingHR) {
    counts.payloadOnly = metrics.length > 0;
    return counts;
  }

  store.health = store.health || {};
  store.health.sleep = Object.assign(store.health.sleep || {}, sleep);
  store.health.hrv = Object.assign(store.health.hrv || {}, hrv);
  store.health.restingHR = Object.assign(store.health.restingHR || {}, rhr);
  prune(store.health.sleep);
  prune(store.health.hrv);
  prune(store.health.restingHR);
  store.health.lastImportAt = new Date().toISOString();
  return counts;
}

// ---------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------

// Kalendertag in der Zeitzone des Nutzers (Health Auto Export liefert lokale Tage,
// der Server läuft in UTC – ohne Umrechnung wäre z.B. 0:30 Uhr noch "gestern").
const USER_TZ = process.env.USER_TIMEZONE || 'Europe/Berlin';
function dayKey(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: USER_TZ });
}

// Werte der letzten `days` Tage (inkl. heute) aus einer Tages-Map
function lastDays(map, days, now, pick = (v) => v) {
  const vals = [];
  for (let i = 0; i < days; i++) {
    const v = map[dayKey(new Date(now.getTime() - i * DAY_MS))];
    const x = v == null ? null : pick(v);
    if (isNum(x)) vals.push(x);
  }
  return vals;
}

function avg(vals) {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Neuester Wert der letzten 2 Tage (Schlaf wird dem Tag des Aufwachens zugeordnet)
function latest(map, now, pick = (v) => v) {
  for (let i = 0; i < 2; i++) {
    const key = dayKey(new Date(now.getTime() - i * DAY_MS));
    if (map[key] != null) return { day: key, value: pick(map[key]) };
  }
  return null;
}

// HRV-Steuerung nach Plews/Kiviniemi: ln(HRV) – 7-Tage-Mittel im Vergleich zu
// deiner persönlichen Normalspanne (60-Tage-Mittel ± 0,5 SD = "kleinste
// bedeutsame Veränderung"). Einzelwerte schwanken stark, der Trend ist robust.
function hrvStatus(hrvMap, now) {
  const all60 = lastDays(hrvMap, 60, now).filter((v) => v > 0);
  if (all60.length < 14) return null;
  const ln = all60.map((v) => Math.log(v));
  const mean = avg(ln);
  const sd = Math.sqrt(avg(ln.map((x) => (x - mean) ** 2))) || 0.05;
  const swc = 0.5 * sd;
  const last7 = lastDays(hrvMap, 7, now).filter((v) => v > 0).map((v) => Math.log(v));
  const today = latest(hrvMap, now);
  const trend = last7.length >= 3 ? avg(last7) : null;
  let state = 'normal';
  if (trend !== null && trend < mean - swc) state = 'niedrig';
  else if (trend !== null && trend > mean + swc) state = 'hoch';
  const todayLow = today ? Math.log(today.value) < mean - sd : false;
  return {
    state,
    todayLow,
    baseline: Math.exp(mean),
    low: Math.exp(mean - swc),
    high: Math.exp(mean + swc),
    trend7: trend === null ? null : Math.exp(trend),
    days: all60.length
  };
}

function computeRecovery(health, now = new Date()) {
  if (!health) return null;
  const sleepMap = health.sleep || {};
  const hrvMap = health.hrv || {};
  const rhrMap = health.restingHR || {};
  const total = (s) => s.total;

  const sleep7 = lastDays(sleepMap, 7, now, total);
  const sleep28 = lastDays(sleepMap, 28, now, total);
  const hrv28 = lastDays(hrvMap, 28, now);
  const rhr28 = lastDays(rhrMap, 28, now);
  if (!sleep7.length && !hrv28.length && !rhr28.length) return null;

  // "Letzte Nacht" nur, wenn für heute (Tag des Aufwachens) wirklich Schlaf aufgezeichnet
  // wurde – sonst z.B. Uhr nachts nicht getragen. Dann zeigen wir die zuletzt
  // aufgezeichnete Nacht separat an, statt sie als "letzte Nacht" auszugeben.
  const todayKey = dayKey(now);
  const lastNight = sleepMap[todayKey] ? { day: todayKey, ...sleepMap[todayKey] } : null;
  const recordedDays = Object.keys(sleepMap).filter((d) => d <= todayKey).sort();
  const lastDay = recordedDays[recordedDays.length - 1];
  const lastRecorded = !lastNight && lastDay ? { day: lastDay, ...sleepMap[lastDay] } : null;
  const hrvLatest = latest(hrvMap, now);
  const rhrLatest = latest(rhrMap, now);

  const sleepAvg7 = avg(sleep7);
  const sleepAvg28 = avg(sleep28);
  const hrvBaseline = avg(hrv28);
  const rhrBaseline = avg(rhr28);

  // Einfaches, nachvollziehbares Punktesystem statt Blackbox-Score
  let score = 0;
  const reasons = [];
  if (sleepAvg7 !== null) {
    if (sleepAvg7 < 6) { score -= 2; reasons.push(`Ø nur ${fmtH(sleepAvg7)} Schlaf in den letzten 7 Nächten`); }
    else if (sleepAvg7 < 7) { score -= 1; reasons.push(`Ø ${fmtH(sleepAvg7)} Schlaf in den letzten 7 Nächten`); }
    else if (sleepAvg7 >= 7.5) { score += 1; }
  }
  if (lastNight && lastNight.total < 6) { score -= 1; reasons.push(`letzte Nacht nur ${fmtH(lastNight.total)}`); }
  const hs = hrvStatus(hrvMap, now);
  if (hs) {
    if (hs.state === 'niedrig') { score -= 1; reasons.push('HRV-Trend der letzten 7 Tage unter deiner Normalspanne'); }
    if (hs.todayLow) { score -= 1; reasons.push('HRV heute deutlich unter deinem Normalwert'); }
    if (hs.state !== 'niedrig' && !hs.todayLow && hrvLatest && hrvLatest.value >= hs.baseline) score += 1;
  } else if (hrvLatest && hrvBaseline && hrv28.length >= 7) {
    if (hrvLatest.value < hrvBaseline * 0.85) { score -= 1; reasons.push('Herzfrequenzvariabilität deutlich unter deinem Schnitt'); }
    else if (hrvLatest.value > hrvBaseline * 1.05) { score += 1; }
  }
  if (rhrLatest && rhrBaseline && rhr28.length >= 7 && rhrLatest.value > rhrBaseline + 5) {
    score -= 1; reasons.push('Ruhepuls erhöht');
  }

  let status = 'normal';
  if (score <= -2) status = 'eingeschränkt';
  else if (score >= 1) status = 'gut';

  return {
    status,
    score,
    reasons,
    lastNight,
    lastRecorded,
    sleepAvg7: sleepAvg7 === null ? null : round(sleepAvg7),
    sleepAvg28: sleepAvg28 === null ? null : round(sleepAvg28),
    sleepNights7: sleep7.length,
    hrv: hrvLatest ? {
      latest: hrvLatest.value,
      baseline: hs ? round(hs.baseline, 1) : hrvBaseline === null ? null : round(hrvBaseline, 1),
      range: hs ? [Math.round(hs.low), Math.round(hs.high)] : null,
      trend7: hs && hs.trend7 ? round(hs.trend7, 1) : null,
      state: hs ? hs.state : null,
      todayLow: hs ? hs.todayLow : false
    } : null,
    restingHR: rhrLatest ? { latest: rhrLatest.value, baseline: rhrBaseline === null ? null : round(rhrBaseline, 1) } : null
  };
}

function fmtH(h) {
  const min = Math.round(h * 60);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;
}

// Schlafwerte der letzten `days` Tage fürs Frontend-Diagramm
function sleepSeries(health, days = 28, now = new Date()) {
  const map = (health && health.sleep) || {};
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(now.getTime() - i * DAY_MS));
    const s = map[key];
    out.push({ date: key, total: s ? s.total : null, deep: s ? s.deep : null, rem: s ? s.rem : null });
  }
  return out;
}

module.exports = { dayKey, mergeHealthMetrics, computeRecovery, sleepSeries, parseSleep, parseDaily };
