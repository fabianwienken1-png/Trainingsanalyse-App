// Spontane Trainingsempfehlung außerhalb des festen Wochenplans.
//
// Eingabe: verfügbare Zeit (Minuten) und optional eine Sportart.
// Berücksichtigt: Erholung (Schlaf/HRV/Ruhepuls), ACWR, Belastung von gestern
// und heute, geplante Einheiten heute/morgen und die Sportart-Verteilung der
// letzten 14 Tage (Triathlon-Mix). Ergebnis: eine konkrete Einheit mit Ablauf,
// Pulsbereichen und Begründung, plus Alternativen.

const analysis = require('./analysis');
const recovery = require('./recovery');

const DAY_MS = 24 * 60 * 60 * 1000;

const SPORTS = {
  swim: { label: 'Schwimmen', types: ['Swim'], planType: 'Swim' },
  bike: { label: 'Radfahren', types: ['Ride', 'VirtualRide'], planType: 'Ride' },
  run: { label: 'Laufen', types: ['Run', 'TrailRun'], planType: 'Run' },
  strength: { label: 'Krafttraining', types: ['WeightTraining'], planType: 'WeightTraining' }
};

// Zielverteilung der Ausdauerzeit im Triathlon (grobe Faustregel)
const TRI_SHARE = { swim: 0.25, bike: 0.4, run: 0.35 };

const INTENSITY_ORDER = ['rest', 'easy', 'moderate', 'hard'];
const INTENSITY_LABEL = { rest: 'Erholung', easy: 'locker', moderate: 'mittel', hard: 'intensiv' };

function groupOf(type) {
  for (const [key, s] of Object.entries(SPORTS)) if (s.types.includes(type)) return key;
  return 'other';
}

function minIntensity(a, b) {
  return INTENSITY_ORDER.indexOf(a) <= INTENSITY_ORDER.indexOf(b) ? a : b;
}

// Pulsbereich nach Karvonen (Herzfrequenzreserve), falls Max- und Ruhepuls bekannt
function zone(athlete, n) {
  const bounds = { 1: [0.5, 0.6], 2: [0.6, 0.7], 3: [0.7, 0.8], 4: [0.8, 0.9], 5: [0.9, 1.0] }[n];
  if (!athlete.maxHR || !athlete.restingHR) return `Zone ${n}`;
  const hrr = athlete.maxHR - athlete.restingHR;
  const lo = Math.round(athlete.restingHR + hrr * bounds[0]);
  const hi = Math.round(athlete.restingHR + hrr * bounds[1]);
  return `Zone ${n} (${lo}–${hi} bpm)`;
}

function roundTo(v, step) {
  return Math.max(step, Math.round(v / step) * step);
}

// Durchschnittliches Schwimmtempo (Sek. pro 100 m) aus der Historie, für Meterangaben
function swimPace(activities) {
  const swims = activities.filter((a) => groupOf(a.type) === 'swim' && a.distanceMeters > 200 && a.movingTimeSec > 300).slice(0, 10);
  if (!swims.length) return 150;
  const pace = swims.reduce((s, a) => s + a.movingTimeSec / (a.distanceMeters / 100), 0) / swims.length;
  return Math.min(240, Math.max(90, pace));
}

// ---------------------------------------------------------------------------
// Einheiten-Vorlagen
// ---------------------------------------------------------------------------

function buildWorkout(sport, intensity, minutes, ctx) {
  const a = ctx.athlete;
  const D = minutes;
  if (intensity === 'rest') {
    return {
      title: 'Aktive Erholung',
      steps: [
        { label: `${Math.min(D, 30)} min`, text: 'lockerer Spaziergang oder sehr lockeres Radeln, Puls deutlich unter Zone 2' },
        { label: '10–15 min', text: 'Mobility: Hüftbeuger, Waden, Brustwirbelsäule, Faszienrolle' }
      ]
    };
  }

  if (sport === 'run') {
    if (intensity === 'easy') {
      const main = Math.max(10, D - 10);
      return {
        title: 'Lockerer Dauerlauf',
        steps: [
          { label: '5 min', text: `einlaufen, sehr locker` },
          { label: `${main} min`, text: `gleichmäßig in ${zone(a, 2)} – Unterhaltung muss möglich sein` },
          D >= 40 ? { label: '4 × 20 s', text: 'Steigerungsläufe, locker schnell, dazwischen 1 min gehen/traben' } : null,
          { label: '5 min', text: 'auslaufen' }
        ]
      };
    }
    if (intensity === 'moderate') {
      const block = Math.min(20, Math.max(6, Math.floor((D - 25) / 2)));
      const extra = D - 15 - (2 * block + 3) - 7;
      return {
        title: 'Tempodauerlauf',
        steps: [
          { label: '15 min', text: `einlaufen in ${zone(a, 2)}` },
          { label: `2 × ${block} min`, text: `zügig in ${zone(a, 3)}, dazwischen 3 min traben in ${zone(a, 1)}` },
          extra >= 5 ? { label: `${extra} min`, text: `ruhig weiter in ${zone(a, 2)}` } : null,
          { label: `${extra >= 5 ? 7 : Math.max(5, extra + 7)} min`, text: 'auslaufen' }
        ]
      };
    }
    const reps = D >= 55 ? 5 : D >= 45 ? 4 : 3;
    const extra = D - 15 - reps * 5 - 10;
    return {
      title: 'Intervalle',
      steps: [
        { label: '15 min', text: `einlaufen in ${zone(a, 2)}, dann 3 kurze Steigerungen` },
        { label: `${reps} × 3 min`, text: `schnell in ${zone(a, 4)}, dazwischen 2 min traben in ${zone(a, 1)}` },
        extra >= 5 ? { label: `${extra} min`, text: `ruhig in ${zone(a, 2)}` } : null,
        { label: `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, text: 'auslaufen' }
      ]
    };
  }

  if (sport === 'bike') {
    if (intensity === 'easy') {
      return {
        title: 'Grundlagenausdauer Rad',
        steps: [
          { label: '10 min', text: 'locker einrollen' },
          { label: `${Math.max(10, D - 15)} min`, text: `gleichmäßig in ${zone(a, 2)}, Trittfrequenz 85–95` },
          { label: '5 min', text: 'ausrollen' }
        ]
      };
    }
    if (intensity === 'moderate') {
      const reps = D >= 75 ? 4 : D >= 55 ? 3 : 2;
      const extra = D - 15 - reps * 12 - 10;
      return {
        title: 'Sweet Spot',
        steps: [
          { label: '15 min', text: `einrollen in ${zone(a, 2)}` },
          { label: `${reps} × 8 min`, text: `kräftig in ${zone(a, 3)} (oberer Bereich), dazwischen 4 min locker in ${zone(a, 1)}` },
          extra >= 5 ? { label: `${extra} min`, text: `gleichmäßig in ${zone(a, 2)}` } : null,
          { label: `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, text: 'ausrollen' }
        ]
      };
    }
    const reps = D >= 60 ? 5 : 4;
    const extra = D - 15 - reps * 6 - 10;
    return {
      title: 'VO2max-Intervalle',
      steps: [
        { label: '15 min', text: `einrollen in ${zone(a, 2)}, 2 × 30 s antreten` },
        { label: `${reps} × 3 min`, text: `hart in ${zone(a, 5)}, dazwischen 3 min sehr locker in ${zone(a, 1)}` },
        extra >= 5 ? { label: `${extra} min`, text: `gleichmäßig in ${zone(a, 2)}` } : null,
        { label: `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, text: 'ausrollen' }
      ]
    };
  }

  if (sport === 'swim') {
    const totalM = roundTo(((D - 5) * 60) / ctx.swimPace * 100, 100); // ~5 min Pausen
    if (intensity === 'easy') {
      const main = Math.max(200, totalM - 300 - 300 - 200);
      return {
        title: 'Technik & Grundlage',
        distance: totalM,
        steps: [
          { label: '300 m', text: 'einschwimmen, locker, gemischte Lagen erlaubt' },
          { label: '6 × 50 m', text: 'Technik: Abschlagschwimmen, Faustschwimmen, Zählen der Züge – 15 s Pause' },
          { label: `${main} m`, text: 'gleichmäßig locker kraulen, Fokus auf lange Züge' },
          { label: '200 m', text: 'ausschwimmen' }
        ]
      };
    }
    if (intensity === 'moderate') {
      const reps = Math.min(15, Math.max(4, Math.floor((totalM - 600) / 100)));
      const left = roundTo(totalM - 600 - reps * 100, 100);
      return {
        title: 'Ausdauer zügig',
        distance: totalM,
        steps: [
          { label: '400 m', text: 'einschwimmen, davon 100 m Technik' },
          { label: `${reps} × 100 m`, text: 'zügig, gleichmäßiges Tempo – 20 s Pause' },
          left >= 200 && totalM - 600 - reps * 100 >= 150 ? { label: `${left} m`, text: 'locker, gleichmäßig' } : null,
          { label: '200 m', text: 'ausschwimmen' }
        ]
      };
    }
    const reps = Math.max(6, Math.min(12, Math.floor((totalM - 700) / 50)));
    return {
      title: 'Tempo-Intervalle',
      distance: totalM,
      steps: [
        { label: '400 m', text: 'einschwimmen, 4 × 25 m Steigerung' },
        { label: `${reps} × 50 m`, text: 'schnell – 30 s Pause' },
        { label: '200 m', text: 'locker' },
        { label: '100 m', text: 'ausschwimmen' }
      ]
    };
  }

  // Krafttraining an den Technogym-Geräten (Einheiten A/B im Wechsel)
  const useA = ctx.strengthCount % 2 === 0;
  const sets = intensity === 'easy' ? '2' : '3';
  const reps = intensity === 'easy' ? '12–15' : '8–10';
  const exercises = useA
    ? ['Beinpresse', 'Beinbeuger (Leg Curl)', 'Abduktoren', 'Latzug', 'Rückenstrecker', 'Bauchmaschine']
    : ['Beinstrecker', 'Beinpresse einbeinig', 'Wadenheben', 'Rudern (Low Row)', 'Schulterpresse', 'Rumpfrotation'];
  const count = D >= 45 ? 6 : D >= 35 ? 5 : 4;
  return {
    title: `Kraft Einheit ${useA ? 'A' : 'B'}`,
    steps: [
      { label: '5 min', text: 'aufwärmen auf Rad oder Crosstrainer' },
      ...exercises.slice(0, count).map((e) => ({ label: `${sets} × ${reps}`, text: `${e} – 90 s Pause` })),
      intensity === 'easy' ? { label: 'Hinweis', text: 'etwas leichter als sonst, Fokus auf saubere Ausführung' } : null
    ]
  };
}

const MAX_SWIM_MIN = 75;
const MAX_STRENGTH_MIN = 60;

// Fester Code je Einheit, unter dem sie auf der Uhr / in der Technogym-App
// gespeichert wird: Sportart-Buchstabe, Typ, Dauer. Beispiele: L-IN-45, R-GA-90,
// S-TE-60, K-A, ER-30. Gleicher Code = identischer Ablauf.
const CODE_SPORT = { swim: 'S', bike: 'R', run: 'L', strength: 'K' };
const CODE_TYPE = { easy: 'GA', moderate: 'TE', hard: 'IN' };

function workoutCode(sport, intensity, minutes, workout) {
  if (intensity === 'rest') return `ER-${Math.min(minutes, 30)}`;
  if (sport === 'strength') {
    const ab = workout.title.endsWith('A') ? 'A' : 'B';
    return intensity === 'easy' ? `K-${ab}-L` : `K-${ab}`;
  }
  return `${CODE_SPORT[sport]}-${CODE_TYPE[intensity]}-${minutes}`;
}

// ---------------------------------------------------------------------------
// Entscheidung
// ---------------------------------------------------------------------------

function suggest(store, opts = {}) {
  const now = new Date();
  const minutes = Math.min(180, Math.max(20, Number(opts.minutes) || 45));
  const wanted = SPORTS[opts.sport] ? opts.sport : null;
  const athlete = store.athlete || {};
  const library = store.workoutLibrary || {};
  const acts = store.activities || [];
  const todayKey = recovery.dayKey(now);
  const yesterdayKey = recovery.dayKey(new Date(now.getTime() - DAY_MS));
  const tomorrowKey = recovery.dayKey(new Date(now.getTime() + DAY_MS));

  const report = analysis.buildAnalysisReport(acts, athlete);
  const rec = recovery.computeRecovery(store.health, now);

  // Tageslasten
  const loadByDay = {};
  for (const act of acts) {
    const t = new Date(act.startDate).getTime();
    if (now.getTime() - t > 29 * DAY_MS) continue;
    const k = recovery.dayKey(new Date(t));
    loadByDay[k] = (loadByDay[k] || 0) + analysis.computeActivityLoad(act, athlete);
  }
  const trainingDays = Object.entries(loadByDay).filter(([k, v]) => k !== todayKey && v > 0).map(([, v]) => v);
  const avgDay = trainingDays.length ? trainingDays.reduce((a, b) => a + b, 0) / trainingDays.length : 0;
  const todayLoad = loadByDay[todayKey] || 0;
  const yesterdayLoad = loadByDay[yesterdayKey] || 0;

  const reasons = [];
  let cap = 'hard';

  // 1) Erholung
  if (rec && rec.status === 'eingeschränkt') {
    cap = minIntensity(cap, rec.score <= -3 ? 'rest' : 'easy');
    reasons.push(`Erholung eingeschränkt (${rec.reasons.join(', ')})`);
  } else if (rec && rec.lastNight && rec.lastNight.total < 6) {
    cap = minIntensity(cap, 'moderate');
    reasons.push('kurze Nacht – heute nichts Hartes');
  } else if (rec && rec.status === 'gut') {
    reasons.push('gut erholt');
  }

  // 2) ACWR
  const acwr = report.acwr.acwr;
  if (acwr !== null && acwr > 1.5) {
    cap = minIntensity(cap, 'easy');
    reasons.push(`Belastung deutlich über deinem Schnitt (ACWR ${acwr.toFixed(2)})`);
  } else if (acwr !== null && acwr > 1.3) {
    cap = minIntensity(cap, 'moderate');
    reasons.push(`Belastung schon erhöht (ACWR ${acwr.toFixed(2)})`);
  } else if (acwr !== null && acwr < 0.8) {
    reasons.push(`du bist unter deinem Trainingsniveau (ACWR ${acwr.toFixed(2)}) – Spielraum nach oben`);
  }

  // 3) Gestern / heute schon trainiert
  if (avgDay > 0 && yesterdayLoad > avgDay * 1.4) {
    cap = minIntensity(cap, 'moderate');
    reasons.push('gestern war ein harter Tag');
  }
  if (todayLoad > 0) {
    cap = minIntensity(cap, todayLoad > avgDay ? 'easy' : 'moderate');
    reasons.push('du hast heute schon trainiert');
  }

  // 4) Plan heute / morgen
  const sessions = (store.plan && store.plan.sessions) || [];
  const plannedToday = sessions.find((s) => s.day === todayKey && s.status === 'planned');
  const plannedTomorrow = sessions.find((s) => s.day === tomorrowKey && s.status === 'planned');
  if (plannedTomorrow && plannedTomorrow.intensity === 'hard') {
    cap = minIntensity(cap, 'moderate');
    reasons.push(`morgen steht ${SPORTS[groupOf(plannedTomorrow.sport)] ? SPORTS[groupOf(plannedTomorrow.sport)].label : plannedTomorrow.sport} intensiv im Plan`);
  }

  // Wunsch-Intensität, wenn nichts dagegen spricht
  let target = 'easy';
  const hardLast48 = (avgDay > 0 && yesterdayLoad > avgDay * 1.4) || todayLoad > 0;
  const hardThisWeek = sessions.filter((s) => s.intensity === 'hard' && s.status === 'done').length;
  if (!hardLast48 && hardThisWeek < 2) target = acwr !== null && acwr < 0.8 ? 'hard' : 'moderate';
  if (minutes >= 100) target = minIntensity(target, 'moderate'); // lange Einheiten eher ruhig
  const intensity = minIntensity(target, cap);

  // 5) Sportart-Verteilung der letzten 14 Tage
  const minutesBy = { swim: 0, bike: 0, run: 0, strength: 0 };
  let strengthCount7 = 0;
  let strengthTotal = 0;
  const lastBy = {};
  for (const act of acts) {
    const g = groupOf(act.type);
    const age = now.getTime() - new Date(act.startDate).getTime();
    if (g === 'strength') strengthTotal++;
    if (age > 14 * DAY_MS || !(g in minutesBy)) continue;
    minutesBy[g] += (act.movingTimeSec || 0) / 60;
    if (g === 'strength' && age <= 7 * DAY_MS) strengthCount7++;
    if (!lastBy[g]) lastBy[g] = recovery.dayKey(new Date(act.startDate));
  }
  const enduranceTotal = minutesBy.swim + minutesBy.bike + minutesBy.run || 1;
  const scores = {};
  for (const g of ['swim', 'bike', 'run']) {
    scores[g] = TRI_SHARE[g] - minutesBy[g] / enduranceTotal; // positiv = zu wenig gemacht
    if (lastBy[g] === todayKey || lastBy[g] === yesterdayKey) scores[g] -= 0.15; // nicht zweimal hintereinander
  }
  scores.strength = strengthCount7 === 0 && minutes <= 60 && intensity !== 'hard' ? 0.2 : -1;
  if (plannedTomorrow) scores[groupOf(plannedTomorrow.sport)] -= 0.1;
  if (minutes > 75) scores.swim -= 0.3; // so lange Schwimmeinheiten sind unüblich

  const ranked = Object.keys(scores).sort((x, y) => scores[y] - scores[x]);
  const primarySport = wanted || ranked[0];

  const sportReason = (g) => {
    if (g === 'strength') return strengthCount7 === 0 ? 'diese Woche noch kein Krafttraining' : null;
    const share = Math.round((minutesBy[g] / enduranceTotal) * 100);
    const targetShare = Math.round(TRI_SHARE[g] * 100);
    if (share + 5 < targetShare) return `${SPORTS[g].label} kam in den letzten 2 Wochen zu kurz (${share} % statt ~${targetShare} %)`;
    return null;
  };

  const ctx = { athlete, swimPace: swimPace(acts), strengthCount: strengthTotal };
  const make = (g, why, forceIntensity, forceMinutes) => {
    const sportIntensity = forceIntensity || intensity;
    let mins = forceMinutes || minutes;
    const extraWhy = [];
    if (g === 'swim' && mins > MAX_SWIM_MIN && sportIntensity !== 'rest') {
      mins = MAX_SWIM_MIN;
      extraWhy.push(`Schwimmen auf ${MAX_SWIM_MIN} min begrenzt – länger ist für eine einzelne Einheit nicht sinnvoll`);
    }
    if (g === 'strength' && mins > MAX_STRENGTH_MIN && sportIntensity !== 'rest') {
      mins = MAX_STRENGTH_MIN;
      extraWhy.push(`Krafttraining auf ${MAX_STRENGTH_MIN} min begrenzt`);
    }
    const w = buildWorkout(g, sportIntensity, mins, ctx);
    const code = workoutCode(g, sportIntensity, mins, w);
    return {
      code,
      device: g === 'strength' && sportIntensity !== 'rest' ? 'technogym' : 'watch',
      created: !!(library[code]),
      sport: sportIntensity === 'rest' ? 'rest' : g,
      sportLabel: sportIntensity === 'rest' ? 'Aktive Erholung' : SPORTS[g].label,
      planType: SPORTS[g].planType,
      intensity: sportIntensity,
      intensityLabel: INTENSITY_LABEL[sportIntensity],
      minutes: mins,
      title: w.title,
      distance: w.distance || null,
      steps: w.steps.filter(Boolean),
      why: [...extraWhy, ...why]
    };
  };

  const primaryWhy = [];
  if (!wanted) {
    const r = sportReason(primarySport);
    if (r) primaryWhy.push(r);
  }
  primaryWhy.push(...reasons);
  if (intensity === 'hard' && !reasons.length) primaryWhy.push('keine harte Einheit in den letzten 48 h');

  // Bei "Ruhe" als Hauptempfehlung: lockere, kurze Alternativen für den Fall, dass du dich doch fit fühlst
  const altPool = intensity === 'rest' ? ranked : ranked.filter((g) => g !== primarySport);
  const alternatives = altPool
    .filter((g) => wanted || scores[g] > -1)
    .slice(0, 2)
    .map((g) => (intensity === 'rest' ? make(g, [], 'easy', Math.min(minutes, 40)) : make(g, [])));

  return {
    minutes,
    intensity,
    primary: make(primarySport, primaryWhy),
    alternatives,
    plannedToday: plannedToday
      ? { sport: plannedToday.sport, intensity: plannedToday.intensity, durationMin: plannedToday.targetDurationMin }
      : null
  };
}

module.exports = { suggest };
