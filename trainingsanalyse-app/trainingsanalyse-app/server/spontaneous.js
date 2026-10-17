// Spontane Trainingsempfehlung außerhalb des festen Wochenplans.
//
// Eingabe: verfügbare Zeit (Minuten) und optional eine Sportart.
// Berücksichtigt: Erholung (Schlaf/HRV/Ruhepuls), ACWR, Belastung von gestern
// und heute, geplante Einheiten heute/morgen und die Sportart-Verteilung der
// letzten 14 Tage (Triathlon-Mix). Ergebnis: eine konkrete Einheit mit Ablauf,
// Pulsbereichen und Begründung, plus Alternativen.

const analysis = require('./analysis');
const recovery = require('./recovery');
const performance = require('./performance');

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

// Zielpuls als einzelne Zahl innerhalb einer Zone (pos 0 = Untergrenze, 1 = Obergrenze)
function bpm(athlete, n, pos = 0.5) {
  const bounds = { 1: [0.5, 0.6], 2: [0.6, 0.7], 3: [0.7, 0.8], 4: [0.8, 0.9], 5: [0.9, 1.0] }[n];
  if (!athlete.maxHR || !athlete.restingHR) return null;
  const hrr = athlete.maxHR - athlete.restingHR;
  return Math.round(athlete.restingHR + hrr * (bounds[0] + (bounds[1] - bounds[0]) * pos));
}

// Schritt mit Zielpuls: z = Zone, pos = Lage in der Zone
function step(a, label, text, z, pos) {
  return { label, text, hr: z ? bpm(a, z, pos) : null, zone: z || null, pos: typeof pos === 'number' ? pos : 0.5 };
}

// Ablauf mit Zielpuls, beim Laufen zusätzlich Tempo (min/km + km/h fürs
// Laufband), beim Rad Watt – sofern Bestzeit bzw. FTP bekannt sind.
function buildWorkout(sport, intensity, minutes, ctx) {
  const w = buildWorkoutBase(sport, intensity, minutes, ctx);
  const t = ctx.targets || {};
  if (intensity !== 'rest' && (sport === 'run' || sport === 'bike')) {
    w.steps = w.steps.map((st) => {
      if (!st || !st.zone) return st;
      const pos = typeof st.pos === 'number' ? st.pos : 0.5;
      if (sport === 'run' && t.tenKSec) {
        const p = performance.paceForZone(t.tenKSec, st.zone, pos);
        return Object.assign({}, st, { pace: p.text, speed: p.kmh });
      }
      if (sport === 'bike' && t.ftp) {
        return Object.assign({}, st, { watts: performance.wattsForZone(t.ftp, st.zone, pos).text });
      }
      return st;
    });
  }
  return w;
}

function buildWorkoutBase(sport, intensity, minutes, ctx) {
  const a = ctx.athlete;
  const D = minutes;
  // Standard-Zielpulse
  const WARM = [2, 0.3];      // einlaufen / einrollen
  const BASE = [2, 0.5];      // Grundlage
  const REST = [1, 0.6];      // Pausen zwischen Intervallen
  const COOL = [1, 0.25];     // ausrollen / auslaufen

  if (intensity === 'rest') {
    return {
      title: 'Aktive Erholung',
      steps: [
        step(a, `${Math.min(D, 30)} min`, 'lockerer Spaziergang oder sehr lockeres Radeln', 1, 0),
        step(a, '10–15 min', 'Mobility: Hüftbeuger, Waden, Brustwirbelsäule, Faszienrolle')
      ]
    };
  }

  if (sport === 'run') {
    if (intensity === 'easy') {
      const main = Math.max(10, D - 10);
      return {
        title: 'Lockerer Dauerlauf',
        steps: [
          step(a, '5 min', `einlaufen, sehr locker – ${zone(a, 2)}`, ...WARM),
          step(a, `${main} min`, `gleichmäßig in ${zone(a, 2)} – Unterhaltung muss möglich sein`, ...BASE),
          D >= 40 ? step(a, '4 × 20 s', 'Steigerungsläufe, locker schnell – zu kurz für einen Zielpuls, nach Gefühl') : null,
          D >= 40 ? step(a, 'je 1 min', `dazwischen gehen/traben – ${zone(a, 1)}`, ...REST) : null,
          step(a, '5 min', `locker auslaufen – ${zone(a, 1)}`, ...COOL)
        ]
      };
    }
    if (intensity === 'moderate') {
      const block = Math.min(20, Math.max(6, Math.floor((D - 25) / 2)));
      const extra = D - 15 - (2 * block + 3) - 7;
      return {
        title: 'Tempodauerlauf',
        steps: [
          step(a, '15 min', `einlaufen – ${zone(a, 2)}`, ...WARM),
          step(a, `2 × ${block} min`, `zügig – ${zone(a, 3)}`, 3, 0.6),
          step(a, '3 min', `Pause dazwischen: traben – ${zone(a, 1)}`, ...REST),
          extra >= 5 ? step(a, `${extra} min`, `ruhig weiter – ${zone(a, 2)}`, ...BASE) : null,
          step(a, `${extra >= 5 ? 7 : Math.max(5, extra + 7)} min`, `locker auslaufen – ${zone(a, 1)}`, ...COOL)
        ]
      };
    }
    const reps = D >= 55 ? 5 : D >= 45 ? 4 : 3;
    const extra = D - 15 - reps * 5 - 10;
    return {
      title: 'Intervalle',
      steps: [
        step(a, '15 min', `einlaufen – ${zone(a, 2)}, am Ende 3 kurze Steigerungen`, ...WARM),
        step(a, `${reps} × 3 min`, `schnell – ${zone(a, 4)}`, 4, 0.5),
        step(a, 'je 2 min', `Pause dazwischen: traben – ${zone(a, 1)}`, ...REST),
        extra >= 5 ? step(a, `${extra} min`, `ruhig – ${zone(a, 2)}`, ...BASE) : null,
        step(a, `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, `locker auslaufen – ${zone(a, 1)}`, ...COOL)
      ]
    };
  }

  if (sport === 'bike') {
    if (intensity === 'easy') {
      return {
        title: 'Grundlagenausdauer Rad',
        steps: [
          step(a, '10 min', `locker einrollen – ${zone(a, 2)}`, ...WARM),
          step(a, `${Math.max(10, D - 15)} min`, `gleichmäßig – ${zone(a, 2)}, Trittfrequenz 85–95`, ...BASE),
          step(a, '5 min', `locker ausrollen – ${zone(a, 1)}`, ...COOL)
        ]
      };
    }
    if (intensity === 'moderate') {
      const reps = D >= 75 ? 4 : D >= 55 ? 3 : 2;
      const extra = D - 15 - reps * 12 - 10;
      return {
        title: 'Sweet Spot',
        steps: [
          step(a, '15 min', `einrollen – ${zone(a, 2)}`, ...WARM),
          step(a, `${reps} × 8 min`, `kräftig – ${zone(a, 3)}, oberer Bereich`, 3, 0.75),
          step(a, 'je 4 min', `Pause dazwischen: locker treten – ${zone(a, 1)}`, ...REST),
          extra >= 5 ? step(a, `${extra} min`, `gleichmäßig – ${zone(a, 2)}`, ...BASE) : null,
          step(a, `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, `locker ausrollen – ${zone(a, 1)}`, ...COOL)
        ]
      };
    }
    const reps = D >= 60 ? 5 : 4;
    const extra = D - 15 - reps * 6 - 10;
    return {
      title: 'VO2max-Intervalle',
      steps: [
        step(a, '15 min', `einrollen – ${zone(a, 2)}, am Ende 2 × 30 s antreten`, ...WARM),
        step(a, `${reps} × 3 min`, `hart – ${zone(a, 5)}`, 5, 0.3),
        step(a, 'je 3 min', `Pause dazwischen: sehr locker treten – ${zone(a, 1)}`, ...REST),
        extra >= 5 ? step(a, `${extra} min`, `gleichmäßig – ${zone(a, 2)}`, ...BASE) : null,
        step(a, `${extra >= 5 ? 10 : Math.max(5, extra + 10)} min`, `locker ausrollen – ${zone(a, 1)}`, ...COOL)
      ]
    };
  }

  if (sport === 'swim') {
    // Im Wasser liegt der Puls bei gleicher Anstrengung meist 10–15 Schläge niedriger
    // als an Land – daher eher die unteren Bereiche der Zonen.
    const totalM = roundTo(((D - 5) * 60) / ctx.swimPace * 100, 100); // ~5 min Pausen
    if (intensity === 'easy') {
      const main = Math.max(200, totalM - 300 - 300 - 200);
      return {
        title: 'Technik & Grundlage',
        distance: totalM,
        steps: [
          step(a, '300 m', 'einschwimmen, locker, gemischte Lagen erlaubt', 1, 0.5),
          step(a, '6 × 50 m', 'Technik: Abschlagschwimmen, Faustschwimmen, Zählen der Züge – 15 s Pause', 1, 0.7),
          step(a, `${main} m`, 'gleichmäßig locker kraulen, Fokus auf lange Züge', 2, 0.2),
          step(a, '200 m', 'ausschwimmen', 1, 0.25)
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
          step(a, '400 m', 'einschwimmen, davon 100 m Technik', 1, 0.6),
          step(a, `${reps} × 100 m`, 'zügig, gleichmäßiges Tempo – 20 s Pause am Beckenrand', 3, 0.2),
          left >= 200 && totalM - 600 - reps * 100 >= 150 ? step(a, `${left} m`, 'locker, gleichmäßig', 2, 0.2) : null,
          step(a, '200 m', 'ausschwimmen', 1, 0.25)
        ]
      };
    }
    const reps = Math.max(6, Math.min(12, Math.floor((totalM - 700) / 50)));
    return {
      title: 'Tempo-Intervalle',
      distance: totalM,
      steps: [
        step(a, '400 m', 'einschwimmen, am Ende 4 × 25 m Steigerung', 1, 0.6),
        step(a, `${reps} × 50 m`, 'schnell – 30 s Pause am Beckenrand', 4, 0.2),
        step(a, '200 m', 'locker', 2, 0.1),
        step(a, '100 m', 'ausschwimmen', 1, 0.25)
      ]
    };
  }

  // Dehnen & Mobilität (nach langen/harten Einheiten oder am Abend)
  if (sport === 'mobility') {
    const long = D >= 20;
    const items = [
      ['2 min', 'locker mobilisieren: Arm- und Hüftkreisen, Schulterrollen'],
      ['2 × 45 s je Seite', 'Hüftbeuger im Ausfallschritt-Kniestand'],
      ['2 × 45 s je Seite', 'Wade an der Wand, Knie gestreckt und leicht gebeugt'],
      ['2 × 45 s je Seite', 'Oberschenkel hinten: Bein auf Erhöhung, Rücken gerade'],
      ['60 s je Seite', 'Gesäß: Taube oder Bein überkreuzt im Liegen'],
      ['60 s', 'Brustwirbelsäule: offenes Buch, Seite wechseln'],
      long ? ['2 min', 'Faszienrolle Waden und Oberschenkel außen'] : null,
      long ? ['60 s', 'Kindhaltung, ruhig in den Bauch atmen'] : null
    ].filter(Boolean);
    return {
      title: long ? 'Dehnen & Mobilität' : 'Kurz dehnen',
      steps: items.map(([label, text]) => ({ label, text, hr: null, zone: null }))
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
const CODE_SPORT = { swim: 'S', bike: 'R', run: 'L', strength: 'K', mobility: 'M' };
const CODE_TYPE = { easy: 'GA', moderate: 'TE', hard: 'IN' };

function workoutCode(sport, intensity, minutes, workout) {
  if (intensity === 'rest') return `ER-${Math.min(minutes, 30)}`;
  if (sport === 'mobility') return `M-${minutes}`;
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

  const ctx = { athlete, swimPace: swimPace(acts), strengthCount: strengthTotal, targets: performance.targetsFor(store) };
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

module.exports = { suggest, buildWorkout, workoutCode, swimPace, MAX_SWIM_MIN, MAX_STRENGTH_MIN };
