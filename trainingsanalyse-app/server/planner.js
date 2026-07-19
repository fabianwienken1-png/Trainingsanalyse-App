// Regelbasierte Trainingsplan-Engine.
//
// Bewusst NICHT als Black-Box-ML-Modell umgesetzt, sondern als nachvollziehbare
// Regeln, damit du immer verstehst, WARUM sich dein Plan verändert. Jede Regel
// ist unten kommentiert. Die wichtigsten Prinzipien:
//
//  1. Wöchentliche Belastungssteigerung ist gedeckelt (Default 10%) - orientiert
//     an der verbreiteten Trainings-Faustregel gegen Überlastungsverletzungen.
//  2. Alle N Wochen (Default 4) folgt automatisch eine Deload-Woche (-40% Last).
//  3. Ist die ACWR (siehe analysis.js) erhöht, wird nicht weiter gesteigert,
//     sondern gehalten oder reduziert.
//  4. Wurden in der Vorwoche >30% der geplanten Einheiten verpasst, wird die
//     Zielbelastung nicht weiter erhöht (kein "Nachholdruck").
//  5. Die Sportart-Verteilung im Plan orientiert sich an deiner tatsächlichen
//     Trainingshistorie der letzten 8 Wochen (aus Strava/Apple Fitness importiert).

const analysis = require('./analysis');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// Grobe Ziel-Intensität (Trainingslast-Punkte pro Minute) je Sportart & Härtegrad,
// wird genutzt um aus einer Ziel-Last eine Ziel-Dauer abzuleiten (Umkehrung der
// Fallback-Formel aus analysis.js, damit Last <-> Dauer konsistent zueinander sind).
const INTENSITY_PER_MIN = {
  Run: { easy: 5, moderate: 8, hard: 11 },
  TrailRun: { easy: 5.5, moderate: 8.5, hard: 11.5 },
  Ride: { easy: 3.5, moderate: 6, hard: 8.5 },
  VirtualRide: { easy: 3.5, moderate: 6, hard: 8.5 },
  Swim: { easy: 5, moderate: 7.5, hard: 10 },
  WeightTraining: { easy: 3, moderate: 4.5, hard: 6 },
  Walk: { easy: 2, moderate: 3, hard: 4 },
  Hike: { easy: 3, moderate: 4.5, hard: 6 },
  Yoga: { easy: 1.5, moderate: 2.5, hard: 3.5 },
  default: { easy: 4, moderate: 6, hard: 8 }
};

const SESSION_DESCRIPTIONS = {
  easy: {
    Run: 'Ruhiger Dauerlauf, Ziel-HF Zone 2 (locker, Unterhaltung möglich)',
    Ride: 'Lockere Ausfahrt, Ziel-HF Zone 2',
    Swim: 'Lockeres Schwimmen, Fokus Technik',
    WeightTraining: 'Kraft – Grundlagenbereich, moderate Gewichte, saubere Ausführung',
    default: 'Lockere Einheit, niedrige Intensität (Zone 2)'
  },
  moderate: {
    Run: 'Lauf im moderaten Tempo (Zone 3), z.B. Fahrtspiel oder progressiver Dauerlauf',
    Ride: 'Ausfahrt mit Tempowechseln, Zone 3',
    Swim: 'Intervalle im moderaten Tempo',
    WeightTraining: 'Kraft – höheres Volumen/Gewicht als Grundlagenreiz',
    default: 'Mittlere Intensität, spürbare Anstrengung (Zone 3)'
  },
  hard: {
    Run: 'Intensive Einheit: Intervalle/Tempolauf (Zone 4-5)',
    Ride: 'Intensive Einheit: Intervalle (Zone 4-5)',
    Swim: 'Intensive Intervalle',
    WeightTraining: 'Kraft – hohe Intensität/Maximalkraft oder Krafteausdauer',
    default: 'Hohe Intensität, harte Einheit (Zone 4-5)'
  }
};

function describeSession(sport, intensity) {
  const group = SESSION_DESCRIPTIONS[intensity] || SESSION_DESCRIPTIONS.easy;
  return group[sport] || group.default;
}

function getIntensityFactor(sport, intensity) {
  const table = INTENSITY_PER_MIN[sport] || INTENSITY_PER_MIN.default;
  return table[intensity];
}

// Realistische Basis-Dauern (in Minuten) je Sportart & Härtegrad. Dienen als
// Ausgangsform für die Session-Verteilung: harte Einheiten sind kürzer und
// intensiver, lockere Einheiten länger - so wie ein Trainer sie ansetzen würde.
// Diese Rohdauern werden anschließend gemeinsam so skaliert, dass die Summe
// ihrer Last exakt die berechnete Wochenzielbelastung ergibt (siehe buildSessions).
const BASE_DURATION_MIN = {
  Run: { easy: 50, moderate: 40, hard: 35 },
  TrailRun: { easy: 60, moderate: 45, hard: 40 },
  Ride: { easy: 75, moderate: 60, hard: 45 },
  VirtualRide: { easy: 60, moderate: 50, hard: 40 },
  Swim: { easy: 40, moderate: 35, hard: 30 },
  WeightTraining: { easy: 45, moderate: 50, hard: 45 },
  Walk: { easy: 45, moderate: 40, hard: 35 },
  Hike: { easy: 90, moderate: 75, hard: 60 },
  Yoga: { easy: 40, moderate: 40, hard: 35 },
  default: { easy: 45, moderate: 40, hard: 35 }
};

function getBaseDuration(sport, intensity) {
  const table = BASE_DURATION_MIN[sport] || BASE_DURATION_MIN.default;
  return table[intensity];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Gleicht die Vorwoche (falls ein Plan existierte) mit den tatsächlich
// importierten Aktivitäten ab: Session gilt als "erledigt", wenn am selben Tag
// (±1 Tag Toleranz) eine Aktivität derselben Sportart importiert wurde.
function evaluatePreviousWeek(store) {
  const { plan, activities, athlete } = store;
  if (!plan.currentWeekStart || plan.sessions.length === 0) return null;

  const weekStart = new Date(plan.currentWeekStart + 'T00:00:00Z');
  const evaluated = plan.sessions.map((session) => {
    const sessionDate = new Date(session.day + 'T00:00:00Z');
    const match = activities.find((act) => {
      const actDate = new Date(act.startDate);
      const diffDays = Math.abs((actDate.getTime() - sessionDate.getTime()) / DAY_MS);
      return diffDays <= 1 && act.type === session.sport;
    });
    return { ...session, status: match ? 'done' : 'missed', matchedActivityId: match ? match.id : null };
  });

  const doneCount = evaluated.filter((s) => s.status === 'done').length;
  const completionRate = evaluated.length > 0 ? doneCount / evaluated.length : 1;
  const summary = analysis.computeWeeklySummary(activities, athlete, weekStart);

  return { weekStart: plan.currentWeekStart, sessions: evaluated, completionRate: round1(completionRate * 100), summary };
}

// Ermittelt die Basis-Zielbelastung für die kommende Woche.
function computeBaseTargetLoad(store, lastWeekSummary) {
  if (lastWeekSummary && lastWeekSummary.totalLoad > 5) {
    return lastWeekSummary.totalLoad;
  }
  // Kein/kaum Trainingsdaten der Vorwoche: konservativer Startwert basierend auf
  // Default-Sessions/Woche à 40 Minuten im lockeren Bereich.
  const sessions = store.athlete.sessionsPerWeekDefault || 3;
  return sessions * 40 * INTENSITY_PER_MIN.default.easy;
}

function decideMultiplierAndReason(store, weekIndex, acwr, completionRate) {
  const cap = store.athlete.weeklyIncreaseCap ?? 0.1;
  const deloadEvery = store.athlete.deloadEveryNWeeks ?? 4;

  if (weekIndex > 0 && weekIndex % deloadEvery === 0) {
    return { multiplier: 0.6, reason: `Deload-Woche (jede ${deloadEvery}. Woche) – bewusste Erholungswoche zur Regeneration.` };
  }
  if (acwr.acwr !== null && acwr.acwr > 1.5) {
    return { multiplier: 0.75, reason: 'ACWR war zuletzt hoch (>1.5) – Belastung wird reduziert, um Verletzungsrisiko zu senken.' };
  }
  if (acwr.acwr !== null && acwr.acwr > 1.3) {
    return { multiplier: 0.95, reason: 'ACWR leicht erhöht – Belastung wird gehalten statt weiter gesteigert.' };
  }
  if (completionRate !== null && completionRate < 70) {
    return { multiplier: 1.0, reason: `Nur ${completionRate}% der letzten Woche geplanten Einheiten absolviert – Zielbelastung bleibt konstant statt zu steigen.` };
  }
  return { multiplier: 1 + cap, reason: `Normale Progression: +${Math.round(cap * 100)}% gegenüber Vorwoche.` };
}

// Verteilt die Ziel-Gesamtlast auf konkrete Sessions über die Woche.
function buildSessions(weekStartDate, targetTotalLoad, sportFrequency, isDeload) {
  // Sportart-Mix aus Historie ableiten (mind. 1 Session, max 6 pro Woche)
  let mix = Object.entries(sportFrequency.sessionsPerWeek)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4); // max. 4 verschiedene Sportarten im Plan, sonst zu unübersichtlich

  if (mix.length === 0) {
    mix = [['Run', 3]];
  }

  let sessionCount = Math.round(mix.reduce((sum, [, freq]) => sum + freq, 0));
  sessionCount = Math.max(3, Math.min(isDeload ? 4 : 6, sessionCount || 3));

  // Sessions proportional zur Häufigkeit auf die Sportarten verteilen
  const totalFreq = mix.reduce((s, [, f]) => s + f, 0) || 1;
  const sportSlots = [];
  for (const [sport, freq] of mix) {
    const count = Math.max(1, Math.round((freq / totalFreq) * sessionCount));
    for (let i = 0; i < count; i++) sportSlots.push(sport);
  }
  while (sportSlots.length > sessionCount) sportSlots.pop();
  while (sportSlots.length < sessionCount) sportSlots.push(mix[0][0]);

  // Intensitätsverteilung: hauptsächlich locker, 1-2 härtere Reize pro Woche
  // (klassisches 80/20-Prinzip aus dem Ausdauertraining), in der Deload-Woche nur "easy".
  const intensityPlan = isDeload
    ? sportSlots.map(() => 'easy')
    : sportSlots.map((_, i) => {
        if (sessionCount >= 4 && i === Math.floor(sessionCount / 2)) return 'hard';
        if (sessionCount >= 3 && i === sessionCount - 2) return 'moderate';
        return 'easy';
      });

  // Basis-Dauer & daraus resultierende Basis-Last je Session (siehe BASE_DURATION_MIN).
  // Die Summe dieser Basis-Lasten wird anschließend auf die Wochenzielbelastung skaliert -
  // dadurch bleibt die Form des Plans (langer lockerer Lauf, kurze harte Intervalle, ...)
  // erhalten, während die absolute Belastung exakt zur Zielvorgabe passt.
  const baseDurations = sportSlots.map((sport, i) => getBaseDuration(sport, intensityPlan[i]));
  const baseLoads = sportSlots.map((sport, i) => baseDurations[i] * getIntensityFactor(sport, intensityPlan[i]));
  const baseLoadSum = baseLoads.reduce((a, b) => a + b, 0) || 1;
  const scale = targetTotalLoad / baseLoadSum;

  // Tage in der Woche verteilen: möglichst 1 Ruhetag, harte Einheit nicht direkt
  // vor/nach einer anderen harten Einheit. Einfache Heuristik: Slots gleichmäßig
  // über Mo-So verteilen, So freihalten falls Platz ist.
  const dayOffsets = pickDayOffsets(sessionCount);

  const sessions = sportSlots.map((sport, i) => {
    const intensity = intensityPlan[i];
    const factor = getIntensityFactor(sport, intensity);
    const targetDurationMin = Math.max(15, Math.round(baseDurations[i] * scale));
    const targetLoad = round1(targetDurationMin * factor);
    const day = new Date(weekStartDate.getTime() + dayOffsets[i] * DAY_MS);
    return {
      id: `s_${day.toISOString().slice(0, 10)}_${i}`,
      day: day.toISOString().slice(0, 10),
      weekday: WEEKDAYS[dayOffsets[i]],
      sport,
      intensity,
      targetDurationMin,
      targetLoad,
      description: describeSession(sport, intensity),
      status: 'planned',
      matchedActivityId: null
    };
  });

  return sessions.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function pickDayOffsets(count) {
  // 0=Mo .. 6=So. Bevorzugte Reihenfolge sorgt für Verteilung mit Ruhetagen dazwischen.
  const preferred = [1, 3, 5, 0, 4, 6, 2]; // Di, Do, Sa, Mo, Fr, So, Mi
  return preferred.slice(0, count).sort((a, b) => a - b);
}

// Hauptfunktion: schließt die laufende Woche ab (falls vorhanden) und generiert
// den Plan für die kommende Woche. Mutiert store.plan direkt.
function generateNextWeekPlan(store) {
  const evalResult = evaluatePreviousWeek(store);
  if (evalResult) {
    store.plan.history.unshift({
      weekStart: evalResult.weekStart,
      sessions: evalResult.sessions,
      completionRate: evalResult.completionRate,
      summary: evalResult.summary
    });
    store.plan.history = store.plan.history.slice(0, 26); // max. ~6 Monate Historie behalten
  }

  const report = analysis.buildAnalysisReport(store.activities, store.athlete);
  const weekIndex = store.plan.weekIndex + 1;
  const isDeload = weekIndex % (store.athlete.deloadEveryNWeeks || 4) === 0;
  const completionRate = evalResult ? evalResult.completionRate : null;

  const baseLoad = computeBaseTargetLoad(store, evalResult ? evalResult.summary : report.lastWeek);
  const { multiplier, reason } = decideMultiplierAndReason(store, weekIndex, report.acwr, completionRate);
  const targetTotalLoad = round1(baseLoad * multiplier);

  const today = new Date();
  const nextWeekStart = new Date(analysis.startOfWeek(today).getTime() + 7 * DAY_MS);
  const sessions = buildSessions(nextWeekStart, targetTotalLoad, report.sportFrequency, isDeload);

  store.plan.currentWeekStart = nextWeekStart.toISOString().slice(0, 10);
  store.plan.weekIndex = weekIndex;
  store.plan.sessions = sessions;
  store.plan.lastDecision = {
    generatedAt: new Date().toISOString(),
    baseLoad: round1(baseLoad),
    multiplier,
    targetTotalLoad,
    isDeload,
    reason,
    acwr: report.acwr,
    completionRate
  };

  return store.plan;
}

module.exports = { generateNextWeekPlan, evaluatePreviousWeek };
