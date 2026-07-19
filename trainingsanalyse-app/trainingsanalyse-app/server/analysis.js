// Trainingsanalyse-Engine: berechnet aus den importierten Aktivitäten eine
// "Trainingslast" pro Einheit (TRIMP-basiert) und daraus abgeleitete Kennzahlen
// wie die Acute:Chronic Workload Ratio (ACWR) und Monotony/Strain (nach Foster).
//
// Diese Kennzahlen sind Heuristiken aus der Sportwissenschaft, keine medizinische
// Diagnostik. Sie helfen, grobe Trends (Belastungsanstieg, Übertrainingsrisiko,
// Monotonie) sichtbar zu machen - sie ersetzen kein ärztliches/trainerisches Urteil.

const DAY_MS = 24 * 60 * 60 * 1000;

// Grobe Default-Intensitätsfaktoren (Punkte pro Minute), falls keine Herzfrequenz
// vorliegt. Bewusst konservativ gehalten; können später pro Sportart verfeinert werden.
const FALLBACK_INTENSITY_PER_MIN = {
  Run: 7,
  TrailRun: 7.5,
  Ride: 5,
  VirtualRide: 5,
  Swim: 7,
  WeightTraining: 4,
  Workout: 5,
  Walk: 3,
  Hike: 4,
  Yoga: 2,
  default: 5
};

function toDateKey(isoString) {
  return isoString.slice(0, 10); // 'YYYY-MM-DD'
}

// Banister-TRIMP (exponentiell gewichtet). HRr = Herzfrequenzreserve-Anteil (0..1).
// Faktor y je nach Geschlecht leicht unterschiedlich (Standardwerte aus der Literatur).
function trimpExp(durationMin, hrReserveFraction, gender) {
  const y = gender === 'female' ? 1.67 : 1.92; // männlich als Default, falls unspezifiziert
  const k = gender === 'female' ? 0.86 : 0.64;
  const hrr = Math.min(Math.max(hrReserveFraction, 0), 1);
  return durationMin * hrr * k * Math.exp(y * hrr);
}

function computeActivityLoad(activity, athlete) {
  const durationMin = (activity.movingTimeSec || 0) / 60;
  if (durationMin <= 0) return 0;

  // 1. Bevorzugt: Stravas eigener "Suffer Score" (Relative Effort), falls vorhanden
  //    (nur mit Strava-Herzfrequenz-Daten bzw. Premium verfügbar).
  if (typeof activity.sufferScore === 'number' && activity.sufferScore > 0) {
    return activity.sufferScore;
  }

  // 2. Eigene TRIMP-Berechnung, falls Herzfrequenz + Athletendaten vorliegen.
  if (activity.averageHeartrate && athlete.maxHR && athlete.restingHR) {
    const hrReserveFraction =
      (activity.averageHeartrate - athlete.restingHR) / (athlete.maxHR - athlete.restingHR);
    return trimpExp(durationMin, hrReserveFraction, athlete.gender);
  }

  // 3. Fallback: grobe Schätzung nach Sportart-Dauer.
  const factor = FALLBACK_INTENSITY_PER_MIN[activity.type] ?? FALLBACK_INTENSITY_PER_MIN.default;
  return durationMin * factor;
}

// Aggregiert Aktivitäten zu täglicher Gesamtlast (mehrere Einheiten am selben Tag werden summiert)
function computeDailyLoadSeries(activities, athlete) {
  const byDate = new Map();
  for (const act of activities) {
    const load = computeActivityLoad(act, athlete);
    const key = toDateKey(act.startDate);
    byDate.set(key, (byDate.get(key) || 0) + load);
  }
  return byDate; // Map<'YYYY-MM-DD', number>
}

function sumLoadInWindow(dailyLoadSeries, endDate, windowDays) {
  let sum = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(endDate.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    sum += dailyLoadSeries.get(key) || 0;
  }
  return sum;
}

// Acute:Chronic Workload Ratio - vergleicht die Belastung der letzten 7 Tage
// mit dem Schnitt der letzten 28 Tage (jeweils auf 7-Tage-Basis normiert).
// Faustregel aus der Sportwissenschaft (Gabbett et al.):
//   < 0.8  -> eher Detraining / sehr niedrige Belastung
//   0.8-1.3 -> "Sweet Spot", gute Balance
//   1.3-1.5 -> erhöhtes Risiko, Vorsicht
//   > 1.5   -> deutlich erhöhtes Verletzungs-/Übertrainingsrisiko
function computeACWR(dailyLoadSeries, asOfDate) {
  const acute7 = sumLoadInWindow(dailyLoadSeries, asOfDate, 7);
  const chronic28Total = sumLoadInWindow(dailyLoadSeries, asOfDate, 28);
  const chronicWeekly = chronic28Total / 4;
  const acwr = chronicWeekly > 0 ? acute7 / chronicWeekly : acute7 > 0 ? 2 : null;
  let riskLevel = 'unbekannt';
  if (acwr !== null) {
    if (acwr < 0.8) riskLevel = 'niedrig (Detraining)';
    else if (acwr <= 1.3) riskLevel = 'optimal';
    else if (acwr <= 1.5) riskLevel = 'erhöht';
    else riskLevel = 'hoch';
  }
  return { acute7, chronicWeekly, acwr, riskLevel };
}

// Foster's Monotony & Strain: hohe Monotony (wenig Variation Tag zu Tag) kombiniert
// mit hoher wöchentlicher Gesamtlast (Strain) gilt als Risikofaktor für Übertraining/Infekte.
function computeMonotonyStrain(dailyLoadSeries, asOfDate) {
  const values = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(asOfDate.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    values.push(dailyLoadSeries.get(key) || 0);
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const monotony = stddev > 0 ? mean / stddev : mean > 0 ? mean : 0;
  const weeklyLoad = values.reduce((a, b) => a + b, 0);
  const strain = weeklyLoad * monotony;
  return { monotony: round1(monotony), strain: round1(strain), weeklyLoad: round1(weeklyLoad) };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function startOfWeek(date) {
  // Montag als Wochenstart
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=So, 1=Mo, ...
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function computeWeeklySummary(activities, athlete, weekStartDate) {
  const weekEnd = new Date(weekStartDate.getTime() + 7 * DAY_MS);
  const inWeek = activities.filter((a) => {
    const t = new Date(a.startDate).getTime();
    return t >= weekStartDate.getTime() && t < weekEnd.getTime();
  });
  const bySport = {};
  let totalLoad = 0;
  let totalDurationMin = 0;
  let totalDistanceKm = 0;
  for (const act of inWeek) {
    const load = computeActivityLoad(act, athlete);
    totalLoad += load;
    totalDurationMin += act.movingTimeSec / 60;
    totalDistanceKm += act.distanceMeters / 1000;
    bySport[act.type] = bySport[act.type] || { count: 0, load: 0, durationMin: 0, distanceKm: 0 };
    bySport[act.type].count += 1;
    bySport[act.type].load += load;
    bySport[act.type].durationMin += act.movingTimeSec / 60;
    bySport[act.type].distanceKm += act.distanceMeters / 1000;
  }
  return {
    weekStart: weekStartDate.toISOString().slice(0, 10),
    sessionCount: inWeek.length,
    totalLoad: round1(totalLoad),
    totalDurationMin: round1(totalDurationMin),
    totalDistanceKm: round1(totalDistanceKm),
    bySport
  };
}

// Ermittelt die typische Sportart-Verteilung (Häufigkeit) der letzten N Tage,
// damit der Plan generator realistische, zum Nutzer passende Sessions vorschlägt.
function computeSportFrequency(activities, lookbackDays = 56) {
  const cutoff = Date.now() - lookbackDays * DAY_MS;
  const recent = activities.filter((a) => new Date(a.startDate).getTime() >= cutoff);
  const counts = {};
  for (const act of recent) {
    counts[act.type] = (counts[act.type] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const weeks = lookbackDays / 7;
  const perWeek = {};
  for (const [sport, count] of Object.entries(counts)) {
    perWeek[sport] = round1(count / weeks);
  }
  return { counts, total, sessionsPerWeek: perWeek };
}

// Baut den vollständigen Analyse-Report für das Dashboard.
function buildAnalysisReport(activities, athlete) {
  const dailyLoadSeries = computeDailyLoadSeries(activities, athlete);
  const now = new Date();
  const acwr = computeACWR(dailyLoadSeries, now);
  const monotonyStrain = computeMonotonyStrain(dailyLoadSeries, now);
  const thisWeekStart = startOfWeek(now);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
  const thisWeek = computeWeeklySummary(activities, athlete, thisWeekStart);
  const lastWeek = computeWeeklySummary(activities, athlete, lastWeekStart);
  const sportFrequency = computeSportFrequency(activities);

  let trend = 'stabil';
  if (lastWeek.totalLoad > 0) {
    const change = (thisWeek.totalLoad - lastWeek.totalLoad) / lastWeek.totalLoad;
    if (change > 0.15) trend = 'steigend';
    else if (change < -0.15) trend = 'sinkend';
  }

  const flags = [];
  if (acwr.acwr !== null && acwr.acwr > 1.5) {
    flags.push({
      level: 'warnung',
      message: 'ACWR > 1.5: Belastung ist stark angestiegen. Erhöhtes Verletzungsrisiko – nächste Tage eher lockerer angehen.'
    });
  } else if (acwr.acwr !== null && acwr.acwr > 1.3) {
    flags.push({
      level: 'hinweis',
      message: 'ACWR leicht erhöht. Belastungssteigerung im Blick behalten.'
    });
  } else if (acwr.acwr !== null && acwr.acwr < 0.8 && acwr.chronicWeekly > 0) {
    flags.push({
      level: 'hinweis',
      message: 'Belastung liegt deutlich unter deinem gewohnten Niveau (Detraining-Bereich).'
    });
  }
  if (monotonyStrain.monotony > 2.0) {
    flags.push({
      level: 'hinweis',
      message: 'Hohe Trainingsmonotonie: wenig Abwechslung zwischen harten und leichten Tagen. Mehr Variation kann Übertrainings-/Infektrisiko senken.'
    });
  }

  return {
    generatedAt: now.toISOString(),
    acwr,
    monotonyStrain,
    thisWeek,
    lastWeek,
    trend,
    sportFrequency,
    flags,
    dailyLoadSeries: Object.fromEntries(dailyLoadSeries) // für Chart im Frontend
  };
}

module.exports = {
  computeActivityLoad,
  computeDailyLoadSeries,
  computeACWR,
  computeMonotonyStrain,
  computeWeeklySummary,
  computeSportFrequency,
  buildAnalysisReport,
  startOfWeek
};
