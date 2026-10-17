// Trainingsplan-Engine (Triathlon, mit Saisonziel).
//
// Nachvollziehbare Regeln statt Black Box:
//  1. Saisonphase aus dem Abstand zum Wettkampf: Grundlage → Aufbau →
//     Wettkampfvorbereitung → Tapering → Wettkampfwoche → Regeneration.
//     Jede 4. Woche ist eine Entlastungswoche. Ohne Wettkampf: Grundlage mit
//     Entlastung alle N Wochen (Einstellung).
//  2. Wochenumfang (Minuten) wächst max. um die eingestellte Steigerung (Default
//     10 %) und nur, wenn die Vorwoche zu ≥ 70 % erledigt wurde, die Belastung
//     (ACWR) nicht erhöht und die Erholung nicht eingeschränkt ist. Obergrenze:
//     die verfügbaren Stunden pro Woche.
//  3. Triathlon-Mix nach Distanz (z.B. Olympisch: ~22 % Schwimmen, 43 % Rad,
//     35 % Lauf), lange Einheiten am Wochenende, 80/20-Verteilung (wenige
//     harte Einheiten, Rest locker), Kraft fest 0–3× pro Woche.
//  4. Jede Einheit bekommt einen festen Ablauf mit Zielpuls (siehe
//     spontaneous.js – gleiche Vorlagen und Codes wie "Spontan trainieren").
//  5. Der Plan gilt immer für die laufende Woche. Zu Wochenbeginn wird die
//     Vorwoche ausgewertet und automatisch neu geplant.

const analysis = require('./analysis');
const recovery = require('./recovery');
const workouts = require('./spontaneous');
const performance = require('./performance');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// Trainingslast-Punkte pro Minute (für die Lastschätzung einer geplanten Einheit)
const INTENSITY_PER_MIN = {
  Run: { easy: 5, moderate: 8, hard: 11 },
  Ride: { easy: 3.5, moderate: 6, hard: 8.5 },
  Swim: { easy: 5, moderate: 7.5, hard: 10 },
  WeightTraining: { easy: 3, moderate: 4.5, hard: 6 },
  default: { easy: 4, moderate: 6, hard: 8 }
};

const SESSION_DESCRIPTIONS = {
  easy: { Run: 'Locker in Zone 2', Ride: 'Locker in Zone 2', Swim: 'Technik & Grundlage', WeightTraining: 'Kraft, leichte Variante', default: 'Locker' },
  moderate: { Run: 'Unterschwellige Intervalle', Ride: 'Sweet Spot (unterschwellig)', Swim: 'Ausdauer zügig', WeightTraining: 'Kraft', default: 'Mittel' },
  hard: { Run: 'Intervalle in Zone 4', Ride: 'Intervalle in Zone 5', Swim: 'Tempo-Intervalle', WeightTraining: 'Kraft', default: 'Intensiv' }
};

function describeSession(sport, intensity) {
  const group = SESSION_DESCRIPTIONS[intensity] || SESSION_DESCRIPTIONS.easy;
  return group[sport] || group.default;
}

function getIntensityFactor(sport, intensity) {
  const table = INTENSITY_PER_MIN[sport] || INTENSITY_PER_MIN.default;
  return table[intensity] || table.easy;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

const SPORT_GROUP = { Ride: 'bike', VirtualRide: 'bike', Run: 'run', TrailRun: 'run', Swim: 'swim', WeightTraining: 'strength', Mobility: 'mobility', Yoga: 'mobility' };
const GROUP_TYPE = { bike: 'Ride', run: 'Run', swim: 'Swim', strength: 'WeightTraining', mobility: 'Mobility' };
function groupOf(type) {
  return SPORT_GROUP[type] || 'other';
}

// ---------------------------------------------------------------------------
// Saisonziel & Phasen
// ---------------------------------------------------------------------------

const DISTANCES = {
  sprint: { label: 'Sprintdistanz', share: { swim: 0.22, bike: 0.43, run: 0.35 }, brick: 15 },
  olympic: { label: 'Olympische Distanz', share: { swim: 0.22, bike: 0.43, run: 0.35 }, brick: 20 },
  half: { label: 'Mitteldistanz', share: { swim: 0.18, bike: 0.5, run: 0.32 }, brick: 30 },
  full: { label: 'Langdistanz', share: { swim: 0.16, bike: 0.52, run: 0.32 }, brick: 30 },
  // Laufwettkämpfe: Laufen im Mittelpunkt, Rad/Schwimmen nur als lockeres Ausgleichstraining
  run5k: { label: '5-km-Lauf', type: 'run', share: { swim: 0.1, bike: 0.2, run: 0.7 }, brick: 0, taperWeeks: 1, longCap: 75, raceMin: 25 },
  run10k: { label: '10-km-Lauf', type: 'run', share: { swim: 0.1, bike: 0.2, run: 0.7 }, brick: 0, taperWeeks: 1, longCap: 90, raceMin: 55 },
  runHalf: { label: 'Halbmarathon', type: 'run', share: { swim: 0.08, bike: 0.17, run: 0.75 }, brick: 0, taperWeeks: 2, longCap: 120, raceMin: 120 },
  marathon: { label: 'Marathon', type: 'run', share: { swim: 0.05, bike: 0.15, run: 0.8 }, brick: 0, taperWeeks: 3, longCap: 150, raceMin: 240 },
  none: { label: 'Kein Wettkampf', share: { swim: 0.22, bike: 0.43, run: 0.35 }, brick: 0 }
};

const DEFAULT_GOAL = { name: '', date: null, distance: 'olympic', weeklyHours: 6, strengthPerWeek: 2, mobilityPerWeek: 2, restDays: [0] };

// ---------------------------------------------------------------------------
// Wettkämpfe (A/B/C) und Abwesenheiten
// ---------------------------------------------------------------------------
// A = Saisonhöhepunkt: bestimmt die Periodisierung (Phasen, volles Tapering).
// B = wichtiger Wettkampf: Mini-Tapering (Woche −20 %, Vortag frei), Folgetag frei.
// C = Trainingswettkampf: ersetzt die fordernde Einheit, kein Tapering.
const RACE_TIME_FALLBACK = { sprint: 80, olympic: 150, half: 330, full: 720 };

function getRaces(athlete) {
  return (Array.isArray(athlete.races) ? athlete.races : [])
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && DISTANCES[r.distance] && r.distance !== 'none')
    .map((r) => Object.assign({ priority: 'A' }, r))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function addDaysKey(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Hauptwettkampf: nächster A-Wettkampf (inkl. der Woche danach für die Regeneration)
function mainRace(athlete, refKey) {
  const from = addDaysKey(refKey, -7);
  return getRaces(athlete).find((r) => r.priority === 'A' && r.date >= from) || null;
}

function raceMinutes(distance) {
  return DISTANCES[distance].raceMin || RACE_TIME_FALLBACK[distance] || 150;
}

function isAbsent(athlete, dayKey) {
  return (athlete.absences || []).some((a) => a.from <= dayKey && dayKey <= a.to);
}

function getGoal(athlete, refKey) {
  const g = Object.assign({}, DEFAULT_GOAL, athlete.goal || {});
  if (Array.isArray(athlete.races)) {
    const m = mainRace(athlete, refKey || recovery.dayKey(new Date()));
    g.name = m ? m.name || '' : '';
    g.date = m ? m.date : null;
    g.distance = m ? m.distance : 'none';
    g.targetTimeSec = m ? m.targetTimeSec || null : null;
    g.raceId = m ? m.id : null;
  }
  if (!DISTANCES[g.distance]) g.distance = 'olympic';
  g.weeklyHours = Math.min(25, Math.max(2, Number(g.weeklyHours) || DEFAULT_GOAL.weeklyHours));
  g.strengthPerWeek = Math.min(3, Math.max(0, Math.round(Number(g.strengthPerWeek))));
  if (!Number.isFinite(g.strengthPerWeek)) g.strengthPerWeek = 2;
  g.mobilityPerWeek = Math.min(4, Math.max(0, Math.round(Number(g.mobilityPerWeek))));
  if (!Number.isFinite(g.mobilityPerWeek)) g.mobilityPerWeek = 2;
  g.restDays = Array.isArray(g.restDays) ? g.restDays.filter((d) => d >= 0 && d <= 6) : [0];
  if (g.restDays.length > 3) g.restDays = g.restDays.slice(0, 3);
  return g;
}

const PHASES = {
  base: { label: 'Grundlage', volume: 1.0, quality: 1, text: 'Viel lockere Ausdauer, eine fordernde Einheit pro Woche.' },
  build: { label: 'Aufbau', volume: 1.0, quality: 2, text: 'Umfang hoch, zwei fordernde Einheiten pro Woche.' },
  peak: { label: 'Wettkampfvorbereitung', volume: 1.0, quality: 2, text: 'Wettkampfnahe Intensität und Koppeltraining (Rad + Lauf).' },
  recovery: { label: 'Entlastungswoche', volume: 0.65, quality: 0, text: 'Weniger Umfang, nur locker – der Körper verarbeitet die letzten Wochen.' },
  taper: { label: 'Tapering', volume: 0.7, quality: 1, text: 'Umfang runter, Intensität kurz halten – frisch werden für den Wettkampf.' },
  race: { label: 'Wettkampfwoche', volume: 0.4, quality: 1, text: 'Nur kurze, lockere Einheiten mit ein paar Steigerungen. Viel schlafen!' },
  post: { label: 'Regeneration', volume: 0.4, quality: 0, text: 'Nach dem Wettkampf: nur locker bewegen.' }
};

function mondayKeyOf(dateKey) {
  const d = new Date(dateKey + 'T00:00:00Z');
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day));
  return d.toISOString().slice(0, 10);
}

function weeksBetween(fromMonday, toMonday) {
  return Math.round((new Date(toMonday + 'T00:00:00Z') - new Date(fromMonday + 'T00:00:00Z')) / (7 * DAY_MS));
}

function phaseFor(goal, weekStartKey, weekIndex, deloadEvery) {
  if (goal.date && goal.distance !== 'none') {
    const weeksTo = weeksBetween(weekStartKey, mondayKeyOf(goal.date));
    let key;
    const dist = DISTANCES[goal.distance] || {};
    const taperWeeks = dist.taperWeeks || 2;
    if (weeksTo < -1) key = null;
    else if (weeksTo === -1) key = 'post';
    else if (weeksTo === 0) key = 'race';
    else if (weeksTo <= taperWeeks) key = 'taper';
    else if (weeksTo >= taperWeeks + 4 && (weeksTo - taperWeeks) % 4 === 0) key = 'recovery';
    else if (weeksTo <= 8) key = 'peak';
    else if (weeksTo <= 16) key = 'build';
    else key = 'base';
    if (key) {
      const ph = Object.assign({ key, weeksTo }, PHASES[key]);
      if (key === 'taper') {
        // 10 km: 1 Woche, Triathlon/Halbmarathon: 2 Wochen, Marathon: 3 Wochen
        const curve = { 1: [0.65], 2: [0.6, 0.75], 3: [0.55, 0.7, 0.8] }[taperWeeks] || [0.6, 0.75];
        ph.volume = curve[weeksTo - 1] || 0.75;
      }
      if (key === 'peak' && dist.type === 'run') {
        ph.text = 'Wettkampfnahe Intensität: Tempoläufe im Renntempo und lange Läufe.';
      }
      return ph;
    }
  }
  const every = deloadEvery || 4;
  const key = weekIndex > 0 && weekIndex % every === 0 ? 'recovery' : 'base';
  return Object.assign({ key, weeksTo: null }, PHASES[key]);
}

// ---------------------------------------------------------------------------
// Wochenumfang
// ---------------------------------------------------------------------------

function chronicWeeklyMinutes(activities, now) {
  const cutoff = now.getTime() - 28 * DAY_MS;
  let min = 0;
  for (const a of activities) {
    const t = new Date(a.startDate).getTime();
    if (t >= cutoff && t <= now.getTime() && ['swim', 'bike', 'run'].includes(groupOf(a.type))) min += (a.movingTimeSec || 0) / 60;
  }
  return min / 4;
}

function computeWeekVolume(store, goal, phase, ctx) {
  const athlete = store.athlete;
  const availMin = goal.weeklyHours * 60;
  const strengthMin = strengthCountFor(goal, phase) * 45;
  const enduranceCap = Math.max(90, availMin - strengthMin);
  const cap = athlete.weeklyIncreaseCap ?? 0.1;
  const prev = store.plan.lastDecision && store.plan.lastDecision.baseMinutes;
  const reasons = [];
  let base;

  // Belastungssignal: Form (Fitness − Ermüdung in % der Fitness), sonst ACWR
  const fp = ctx.formPct;
  const overloaded = fp !== null && fp !== undefined ? fp < -30 : ctx.acwr !== null && ctx.acwr > 1.5;
  const elevated = fp !== null && fp !== undefined ? fp < -20 : ctx.acwr !== null && ctx.acwr > 1.3;
  if (prev) {
    if (overloaded) {
      base = prev * 0.85;
      reasons.push(fp !== null && fp !== undefined ? `Ermüdung deutlich über deiner Fitness (Form ${fp} %) – Umfang −15 %` : 'Belastung war zuletzt deutlich erhöht – Umfang −15 %');
    } else if (ctx.recoveryStatus === 'eingeschränkt') {
      base = prev;
      reasons.push('Erholung eingeschränkt – Umfang wird gehalten');
    } else if (elevated) {
      base = prev;
      reasons.push(fp !== null && fp !== undefined ? `Ermüdung erhöht (Form ${fp} %) – Umfang wird gehalten` : 'Belastung leicht erhöht – Umfang wird gehalten');
    } else if (ctx.rpe && ctx.rpe.overloaded) {
      base = prev;
      reasons.push(`Training fühlte sich zuletzt sehr anstrengend an (Ø ${ctx.rpe.weekAvg.toFixed(1).replace('.', ',')}/10) – Umfang wird gehalten`);
    } else if (ctx.rpe && ctx.rpe.easyTooHard) {
      base = prev;
      reasons.push(`Lockere Einheiten fühlten sich zu schwer an (Ø ${ctx.rpe.easyAvg.toFixed(1).replace('.', ',')}/10) – Umfang wird gehalten`);
    } else if (ctx.completionRate !== null && ctx.completionRate < 70) {
      base = prev;
      reasons.push(`Nur ${Math.round(ctx.completionRate)} % der letzten Woche geschafft – Umfang wird gehalten`);
    } else {
      base = prev * (1 + cap);
      reasons.push(`Steigerung um ${Math.round(cap * 100)} %`);
    }
  } else {
    const chronic = chronicWeeklyMinutes(store.activities, ctx.now);
    base = Math.max(chronic * 1.1, enduranceCap * 0.5);
    reasons.push(chronic * 1.1 >= enduranceCap * 0.5
      ? 'Start auf Basis deiner letzten 4 Wochen'
      : 'Start mit der Hälfte deiner verfügbaren Zeit, dann schrittweise mehr');
  }

  base = Math.min(enduranceCap, Math.max(120, base));
  if (base >= enduranceCap - 1) {
    const i = reasons.findIndex((r) => r.startsWith('Steigerung') || r.startsWith('Start'));
    const msg = `Obergrenze deiner verfügbaren ${goal.weeklyHours} h erreicht`;
    if (i >= 0) reasons[i] = msg; else reasons.push(msg);
  }
  if (phase.volume < 1) reasons.push(`diese Woche bewusst auf ${Math.round(phase.volume * 100)} % reduziert`);

  let target = base * phase.volume;
  if (ctx.recoveryStatus === 'eingeschränkt' && !reasons[0].startsWith('Erholung')) {
    target *= 0.9;
    reasons.push('Erholung eingeschränkt – diese Woche −10 %');
  } else if (ctx.rpe && ctx.rpe.overloaded && ctx.rpe.weekAvg >= 8.5) {
    target *= 0.9;
    reasons.push('sehr hohe gefühlte Anstrengung – diese Woche −10 %');
  }
  return { baseMinutes: Math.round(base), enduranceMinutes: Math.round(target), reasons };
}

function strengthCountFor(goal, phase) {
  if (['race', 'post'].includes(phase.key)) return Math.min(goal.strengthPerWeek, phase.key === 'post' ? 1 : 0);
  if (['recovery', 'taper'].includes(phase.key)) return Math.min(goal.strengthPerWeek, 1);
  return goal.strengthPerWeek;
}

// ---------------------------------------------------------------------------
// Einheiten zusammenstellen
// ---------------------------------------------------------------------------

const BUCKETS = {
  swim: [30, 45, 60, 75],
  bike: [30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240],
  run: [15, 20, 30, 40, 45, 50, 60, 75, 90, 105, 120, 150],
  strength: [30, 45, 60]
};
const MIN_DURATION = { swim: 30, bike: 45, run: 30 };

function toBucket(sport, minutes) {
  const list = BUCKETS[sport];
  return list.reduce((best, v) => (Math.abs(v - minutes) < Math.abs(best - minutes) ? v : best), list[0]);
}

function sessionCounts(enduranceMinutes, type) {
  const h = enduranceMinutes / 60;
  if (type === 'run') {
    // Laufziel: 3–5 Läufe, dazu 0–2 lockere Ausgleichseinheiten
    if (h < 3) return { swim: 0, bike: 1, run: 3 };
    if (h < 5) return { swim: 1, bike: 1, run: 4 };
    if (h < 8) return { swim: 1, bike: 2, run: 5 };
    return { swim: 2, bike: 2, run: 5 };
  }
  if (h < 3) return { swim: 1, bike: 1, run: 1 };
  if (h < 4) return { swim: 1, bike: 1, run: 2 };
  if (h < 6) return { swim: 2, bike: 2, run: 2 };
  if (h < 9) return { swim: 2, bike: 2, run: 3 };
  return { swim: 3, bike: 3, run: 3 };
}

function composeSessions(goal, phase, enduranceMinutes, weekIndex) {
  const dist = DISTANCES[goal.distance];
  const isRun = dist.type === 'run';
  const counts = sessionCounts(enduranceMinutes / Math.max(0.4, phase.volume), dist.type); // Anzahl nach Grundumfang, nicht nach Entlastung
  const list = [];

  for (const sport of ['swim', 'bike', 'run']) {
    let minutes = enduranceMinutes * dist.share[sport];
    let n = counts[sport];
    const brick = sport === 'run' && phase.key === 'peak' && dist.brick > 0;
    if (brick) minutes -= dist.brick;
    while (n > 1 && minutes / n < MIN_DURATION[sport]) n--;
    if (n === 0 || minutes < MIN_DURATION[sport] * 0.75) continue;

    let longShare = sport === 'bike' ? (n === 2 ? 0.6 : 0.45) : sport === 'run' ? (n === 2 ? 0.55 : 0.4) : 0;
    if (isRun) longShare = sport === 'run' ? (n <= 3 ? 0.42 : 0.32) : 0; // Laufziel: nur der lange Lauf, kein langes Rad
    const hasLong = n >= 2 && longShare > 0 && !['race', 'post'].includes(phase.key);
    let longMin = hasLong ? minutes * longShare : 0;
    if (hasLong && isRun && sport === 'run') longMin = Math.min(longMin, dist.longCap);
    const restEach = (minutes - longMin) / (hasLong ? n - 1 : n);

    if (hasLong) list.push({ sport, kind: 'long', intensity: 'easy', minutes: toBucket(sport, Math.max(MIN_DURATION[sport], longMin)) });
    for (let i = 0; i < (hasLong ? n - 1 : n); i++) {
      list.push({ sport, kind: 'easy', intensity: 'easy', minutes: toBucket(sport, Math.max(MIN_DURATION[sport], restEach)) });
    }
    if (brick) list.push({ sport: 'run', kind: 'brick', intensity: 'moderate', minutes: toBucket('run', dist.brick) });
  }

  // Fordernde Einheiten (80/20): auf nicht-lange Rad-/Lauf-Einheiten verteilen
  const order = isRun ? ['run', 'run'] : weekIndex % 2 === 0 ? ['run', 'bike'] : ['bike', 'run'];
  let q = phase.quality;
  const qualityIntensity = {
    base: ['moderate'], build: ['hard', 'moderate'], peak: ['hard', 'hard'], taper: ['hard'], race: ['hard']
  }[phase.key] || [];
  for (let i = 0; q > 0 && i < 4; i++) {
    const sport = order[i % 2];
    const cand = list.find((s) => s.sport === sport && s.kind === 'easy');
    if (!cand) continue;
    cand.kind = 'quality';
    cand.intensity = qualityIntensity[phase.quality - q] || 'moderate';
    const maxQ = sport === 'run' ? (isRun && goal.distance !== 'run10k' ? 75 : 60) : 90;
    if (['taper', 'race'].includes(phase.key)) cand.minutes = toBucket(sport, Math.min(cand.minutes, sport === 'run' ? 40 : 60));
    else cand.minutes = toBucket(sport, Math.min(Math.max(cand.minutes, sport === 'run' ? 40 : 60), maxQ));
    q--;
  }
  // Laufziel: der lange Lauf bleibt die längste Laufeinheit der Woche
  if (isRun) {
    const long = list.find((s) => s.sport === 'run' && s.kind === 'long');
    const others = list.filter((s) => s.sport === 'run' && s.kind !== 'long');
    if (long && others.length) {
      const maxOther = Math.max(...others.map((s) => s.minutes));
      if (long.minutes <= maxOther) long.minutes = toBucket('run', Math.min(dist.longCap, maxOther + 15));
    }
  }
  // Schwimmen: in Aufbau/Vorbereitung eine zügige Einheit
  if (['build', 'peak'].includes(phase.key)) {
    const swims = list.filter((s) => s.sport === 'swim');
    if (swims.length >= 2) swims[1].intensity = 'moderate';
  }
  // Wettkampfwoche: alles kurz
  if (phase.key === 'race') {
    for (const s of list) s.minutes = toBucket(s.sport, Math.min(s.minutes, s.sport === 'bike' ? 60 : 30));
  }

  const strength = strengthCountFor(goal, phase);
  for (let i = 0; i < strength; i++) {
    list.push({ sport: 'strength', kind: 'strength', intensity: ['recovery', 'taper', 'post'].includes(phase.key) ? 'easy' : 'moderate', minutes: 45, variant: i % 2 === 0 ? 'A' : 'B' });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Auf Wochentage verteilen
// ---------------------------------------------------------------------------

const PREFERRED_DAYS = {
  long_bike: [5, 6, 4, 3, 2, 1, 0],
  long_run: [6, 5, 3, 2, 4, 1, 0],
  brick: [],
  quality_run: [1, 2, 3, 4, 0],
  quality_bike: [3, 2, 1, 4, 0],
  easy_swim: [0, 2, 4, 1, 3, 5, 6],
  easy_run: [2, 4, 1, 3, 0, 5, 6],
  easy_bike: [2, 4, 1, 3, 0, 5, 6],
  strength: [0, 2, 4, 1, 3, 5, 6]
};

function placeSessions(list, goal, firstDay) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => d >= firstDay && !goal.restDays.includes(d));
  const byDay = new Map(days.map((d) => [d, []]));
  const placed = [];
  const isHard = (s) => s.kind === 'quality' || s.kind === 'long' || s.kind === 'brick';

  const rank = { long: 0, brick: 1, quality: 2, easy: 3, strength: 4 };
  const sorted = [...list].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.sport === 'bike' ? -1 : 1));

  const ok = (s, d, strict) => {
    const daySessions = byDay.get(d);
    if (!daySessions) return false;
    const limit = s.kind === 'brick' ? 3 : 2;
    if (daySessions.length >= limit) return false;
    if (daySessions.some((x) => x.sport === s.sport && s.kind !== 'brick')) return false;
    if (!strict) return true;
    if (s.kind === 'quality') {
      // keine zwei harten Tage hintereinander
      for (const nd of [d - 1, d + 1]) if ((byDay.get(nd) || []).some(isHard)) return false;
      if (daySessions.some(isHard) || daySessions.some((x) => x.kind === 'strength')) return false;
    }
    if (s.kind === 'strength') {
      if (daySessions.some((x) => x.kind === 'quality' || x.kind === 'long')) return false;
      if ((byDay.get(d + 1) || []).some((x) => x.kind === 'quality')) return false;
      if ([...byDay.values()].flat().some((x) => x.kind === 'strength' && Math.abs(x._day - d) < 2)) return false;
    }
    if (s.kind === 'easy' && daySessions.some((x) => x.kind === 'long')) return false;
    return true;
  };

  for (const s of sorted) {
    let day = null;
    if (s.kind === 'brick') {
      // Koppellauf direkt nach der längsten Radeinheit
      const bikes = placed.filter((x) => x.sport === 'bike').sort((a, b) => b.minutes - a.minutes);
      day = bikes.length ? bikes[0]._day : null;
      if (day === null) continue;
    }
    if (day === null) {
      const key = s.kind === 'strength' ? 'strength' : `${s.kind === 'brick' ? 'quality' : s.kind}_${s.sport}`;
      const prefs = PREFERRED_DAYS[key] || PREFERRED_DAYS[`easy_${s.sport}`] || [0, 1, 2, 3, 4, 5, 6];
      day = prefs.find((d) => ok(s, d, true));
      if (day === undefined) day = prefs.find((d) => ok(s, d, false));
      if (day === undefined) day = null;
    }
    if (day === null) continue; // passt nicht mehr in die (Rest-)Woche
    s._day = day;
    byDay.get(day).push(s);
    placed.push(s);
  }
  return placed.sort((a, b) => a._day - b._day || rank[a.kind] - rank[b.kind]);
}

// ---------------------------------------------------------------------------
// Woche planen
// ---------------------------------------------------------------------------

function buildWeek(store, weekStartKey, firstDay, opts = {}) {
  const now = opts.now || new Date();
  const athlete = store.athlete;
  const goal = getGoal(athlete, weekStartKey);
  const weekIndex = (store.plan.weekIndex || 0) + (opts.newWeek ? 1 : 0);
  let phase = phaseFor(goal, weekStartKey, weekIndex, athlete.deloadEveryNWeeks);
  // Keine Entlastungswoche als allererste geplante Woche
  if (phase.key === 'recovery' && !(store.plan.lastDecision && store.plan.lastDecision.baseMinutes)) {
    phase = Object.assign({}, phase, PHASES.base, { key: 'base' });
  }
  const report = analysis.buildAnalysisReport(store.activities, athlete);
  const rec = recovery.computeRecovery(store.health, now);
  // Entlastung nach Erholungsdaten vorziehen: HRV-Trend unter der Normalspanne
  // UND (Erholung eingeschränkt ODER Training fühlt sich zu schwer an)
  const rpeNow = performance.rpeSignal(store, now);
  const lastPhase = store.plan.lastDecision && store.plan.lastDecision.phase;
  if (['base', 'build', 'peak'].includes(phase.key) && lastPhase !== 'recovery' && rec && rec.hrv && rec.hrv.state === 'niedrig'
    && (rec.status === 'eingeschränkt' || rpeNow.overloaded || rpeNow.easyTooHard)) {
    phase = Object.assign({}, phase, PHASES.recovery, {
      key: 'recovery',
      text: 'Vorgezogene Entlastung: Dein HRV-Trend liegt unter deiner Normalspanne und die Belastung zeigt Spuren – diese Woche weniger Umfang, nur locker.'
    });
  }
  const ctx = { now, acwr: report.acwr.acwr, formPct: report.fitness && report.fitness.reliable ? report.fitness.formPct : null, recoveryStatus: rec ? rec.status : null, completionRate: opts.completionRate ?? null, rpe: performance.rpeSignal(store, now) };

  const vol = Object.assign({}, opts.volume || computeWeekVolume(store, goal, phase, ctx));
  vol.reasons = [...(vol.reasons || [])];
  const weekStart = new Date(weekStartKey + 'T00:00:00Z');
  const dayKeyAt = (i) => addDaysKey(weekStartKey, i);

  // Krank / Urlaub: diese Tage bleiben frei
  const absentDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => isAbsent(athlete, dayKeyAt(d)));
  // Wiedereinstieg nach Krankheit oder längerer Pause
  const recentAbs = (athlete.absences || []).filter((a) => a.to >= addDaysKey(weekStartKey, -3) && a.to <= addDaysKey(weekStartKey, 5));
  const sickReturn = recentAbs.some((a) => a.type === 'krank');
  const longBreak = recentAbs.some((a) => a.type !== 'krank' && (new Date(a.to) - new Date(a.from)) / DAY_MS >= 6);
  let qualityCap = null;
  if (sickReturn) {
    vol.enduranceMinutes *= 0.8;
    qualityCap = 1;
    vol.reasons.push('Wiedereinstieg nach Krankheit – ruhiger Start (−20 %, max. eine fordernde Einheit)');
  } else if (longBreak) {
    vol.enduranceMinutes *= 0.85;
    vol.reasons.push('nach längerer Pause behutsam wieder einsteigen (−15 %)');
  }

  // Wettkämpfe dieser Woche
  const raceGoal = Object.assign({}, goal);
  const restSet = new Set(goal.restDays);
  const raceEntries = [];
  const weekEndKey = dayKeyAt(6);
  for (const r of getRaces(athlete)) {
    const isMain = r.id === goal.raceId && phase.key === 'race';
    if (r.date < weekStartKey || r.date > weekEndKey) {
      // B-Wettkampf am Wochenende davor: Montag frei
      if (r.priority === 'B' && r.date >= addDaysKey(weekStartKey, -2) && r.date < weekStartKey) restSet.add(0);
      continue;
    }
    if (r.id === goal.raceId && !isMain) continue;
    const day = Math.round((new Date(r.date + 'T00:00:00Z') - weekStart) / DAY_MS);
    raceEntries.push({ race: r, day });
    restSet.add(day);
    if (r.priority !== 'C') restSet.add(day - 1);
    if (r.priority === 'B') {
      restSet.add(day + 1);
      if (!isMain) {
        vol.enduranceMinutes *= 0.8;
        vol.reasons.push(`Mini-Tapering für ${r.name || DISTANCES[r.distance].label} (B-Wettkampf, −20 %)`);
      }
    }
    if (r.priority === 'C') vol.reasons.push(`${r.name || DISTANCES[r.distance].label} ersetzt die fordernde Einheit (C-Wettkampf)`);
  }
  for (const d of absentDays) restSet.add(d);
  raceGoal.restDays = [...restSet].filter((d) => d >= 0 && d <= 6);

  const freeDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !goal.restDays.includes(d));
  const remainingDays = freeDays.filter((d) => d >= firstDay && !absentDays.includes(d)).length;
  const scale = freeDays.length ? remainingDays / freeDays.length : 1;
  if (absentDays.length) vol.reasons.push(`${absentDays.length} ${absentDays.length === 1 ? 'Tag' : 'Tage'} krank/Urlaub – frei gehalten`);
  const enduranceMinutes = Math.round(vol.enduranceMinutes * scale);

  let composed = composeSessions(goal, phase, enduranceMinutes, weekIndex);
  // Wettkämpfe ersetzen fordernde Einheiten; nach Krankheit max. eine
  let dropQuality = raceEntries.filter((e) => e.race.id !== goal.raceId).length;
  const qCount = composed.filter((c) => c.kind === 'quality').length;
  if (qualityCap !== null) dropQuality = Math.max(dropQuality, qCount - qualityCap);
  for (const c of composed) if (dropQuality > 0 && c.kind === 'quality') { c.kind = 'easy'; c.intensity = 'easy'; dropQuality--; }
  // B-Wettkampf (nicht Hauptziel) in dieser Woche: kein langer Lauf/keine lange Ausfahrt – das Rennen ist der lange Reiz
  if (raceEntries.some((e) => e.race.priority === 'B' && e.race.id !== goal.raceId)) {
    for (const c of composed) if (c.kind === 'long') { c.kind = 'easy'; c.minutes = toBucket(c.sport, Math.min(c.minutes, c.sport === 'bike' ? 75 : 45)); }
  }
  // Angefangene Woche: Krafteinheiten anteilig
  if (scale < 1) {
    let allowed = Math.round(composed.filter((c) => c.sport === 'strength').length * scale);
    composed = composed.filter((c) => c.sport !== 'strength' || allowed-- > 0);
  }
  // Bereits erledigte Einheiten dieser Woche (beim Neuplanen) anrechnen
  if (opts.kept && opts.kept.length) {
    const keptStrength = opts.kept.filter((k) => k.sport === 'WeightTraining').length;
    let dropStrength = keptStrength;
    composed = composed.filter((c) => !(c.sport === 'strength' && dropStrength-- > 0));
    let keptQuality = opts.kept.filter((k) => k.kind === 'quality' || k.intensity === 'hard').length;
    for (const c of composed) if (keptQuality > 0 && c.kind === 'quality') { c.kind = 'easy'; c.intensity = 'easy'; keptQuality--; }
  }
  const placed = placeSessions(composed, raceGoal, firstDay);

  // Dehnen & Mobilität: bevorzugt an Tagen mit langer oder harter Einheit
  let mobility = ['race', 'post'].includes(phase.key) ? Math.min(1, goal.mobilityPerWeek) : goal.mobilityPerWeek;
  if (scale < 1) mobility = Math.round(mobility * scale);
  if (opts.kept) mobility -= opts.kept.filter((k) => k.sport === 'Mobility').length;
  const dayScore = (d) => {
    const list = placed.filter((p) => p._day === d);
    if (list.some((p) => p.kind === 'long')) return 0;
    if (list.some((p) => p.kind === 'quality' || p.kind === 'brick')) return 1;
    return list.length ? 2 : 3;
  };
  const mobDays = [...new Set(placed.map((p) => p._day))]
    .filter((d) => d >= firstDay && !raceEntries.some((e) => e.day === d))
    .sort((x, y) => dayScore(x) - dayScore(y) || y - x)
    .slice(0, Math.max(0, mobility));
  for (const d of mobDays) {
    placed.push({ sport: 'mobility', kind: 'mobility', intensity: 'easy', minutes: dayScore(d) === 0 ? 20 : 15, _day: d });
  }
  placed.sort((x, y) => x._day - y._day || (x.kind === 'mobility') - (y.kind === 'mobility'));
  for (const e of raceEntries) {
    if (e.day >= firstDay && e.day <= 6) {
      placed.push({ sport: 'race', kind: 'race', intensity: 'hard', minutes: raceMinutes(e.race.distance), _day: e.day, race: e.race });
    }
  }
  placed.sort((x, y) => x._day - y._day || (x.kind === 'mobility') - (y.kind === 'mobility'));

  const sessions = placed.map((s, i) => {
    const day = new Date(weekStart.getTime() + s._day * DAY_MS).toISOString().slice(0, 10);
    if (s.sport === 'race') {
      const r = s.race;
      const type = DISTANCES[r.distance].type === 'run' ? 'Laufwettkampf' : 'Triathlon';
      const prioText = { A: 'Saisonhöhepunkt', B: 'B-Wettkampf', C: 'Trainingswettkampf – locker angehen, als harte Einheit nutzen' }[r.priority] || '';
      return {
        id: `race_${day}_${r.id || ''}`, day, weekday: WEEKDAYS[s._day], sport: type, kind: 'race', intensity: 'hard',
        priority: r.priority, raceId: r.id || null, raceDistance: r.distance,
        targetDurationMin: s.minutes, targetLoad: round1(s.minutes * 9),
        description: `${r.name || 'Wettkampf'} – ${DISTANCES[r.distance].label}${prioText ? ` (${prioText})` : ''}. Viel Erfolg!`,
        status: 'planned', matchedActivityId: null
      };
    }
    const type = GROUP_TYPE[s.sport];
    return {
      id: `s_${day}_${s.sport}_${i}_${Date.now().toString(36)}`,
      day,
      weekday: WEEKDAYS[s._day],
      sport: type,
      kind: s.kind,
      variant: s.variant || null,
      intensity: s.intensity,
      targetDurationMin: s.minutes,
      targetLoad: round1(s.minutes * getIntensityFactor(type, s.intensity)),
      description: s.sport === 'mobility' ? 'Dehnen & Mobilität' : describeSession(type, s.intensity),
      status: 'planned',
      matchedActivityId: null
    };
  });

  const weeksText = phase.weeksTo !== null && phase.weeksTo > 0
    ? ` · noch ${phase.weeksTo} ${phase.weeksTo === 1 ? 'Woche' : 'Wochen'} bis ${goal.name || DISTANCES[goal.distance].label}`
    : '';
  const decision = {
    generatedAt: now.toISOString(),
    phase: phase.key,
    phaseLabel: phase.label,
    phaseText: phase.text,
    weeksToRace: phase.weeksTo,
    goalName: goal.name || null,
    distance: goal.distance,
    baseMinutes: vol.baseMinutes,
    targetMinutes: enduranceMinutes + sessions.filter((s) => s.sport === 'WeightTraining').reduce((a, s) => a + s.targetDurationMin, 0),
    plannedMinutes: sessions.filter((s) => s.kind !== 'mobility').reduce((a, s) => a + s.targetDurationMin, 0),
    isDeload: ['recovery', 'taper', 'race', 'post'].includes(phase.key),
    reason: `${phase.label}${weeksText}. ${vol.reasons.join(' · ')}.`,
    acwr: report.acwr,
    completionRate: ctx.completionRate,
    partialWeek: firstDay > 0
  };
  return { sessions, decision, weekIndex, volume: vol };
}

function todayIndex(weekStartKey, now) {
  const todayKey = recovery.dayKey(now);
  return Math.max(0, Math.min(6, Math.round((new Date(todayKey + 'T00:00:00Z') - new Date(weekStartKey + 'T00:00:00Z')) / DAY_MS)));
}

// Sorgt dafür, dass immer ein Plan für die laufende Woche existiert. Zu
// Wochenbeginn wird die Vorwoche ausgewertet (→ Historie) und neu geplant.
// Gibt true zurück, wenn sich der Plan geändert hat.
function ensureCurrentPlan(store, now = new Date()) {
  const thisMonday = analysis.startOfWeek(now).toISOString().slice(0, 10);
  const plan = store.plan;
  if (plan.currentWeekStart === thisMonday && plan.version === 2) return false;

  let completionRate = null;
  if (plan.currentWeekStart && plan.currentWeekStart < thisMonday && plan.sessions.length) {
    const evalResult = evaluatePreviousWeek(store);
    if (evalResult) {
      plan.history.unshift(evalResult);
      plan.history = plan.history.slice(0, 26);
      completionRate = evalResult.completionRate;
    }
  }
  // Alter (v1-)Plan oder Plan für eine zukünftige Woche: Steigerungsbasis neu bestimmen
  if (plan.version !== 2) plan.lastDecision = null;

  const firstDay = todayIndex(thisMonday, now);
  const isNewWeek = plan.currentWeekStart !== thisMonday;
  const week = buildWeek(store, thisMonday, firstDay, { now, completionRate, newWeek: isNewWeek && plan.version === 2 });
  plan.currentWeekStart = thisMonday;
  plan.weekIndex = week.weekIndex;
  plan.sessions = week.sessions;
  plan.lastDecision = week.decision;
  plan.version = 2;
  return true;
}

// "Neu planen": erledigte/vergangene Einheiten bleiben, ab heute wird neu verteilt.
function replanCurrentWeek(store, now = new Date()) {
  if (ensureCurrentPlan(store, now)) return store.plan;
  const plan = store.plan;
  const todayKey = recovery.dayKey(now);
  for (const s of plan.sessions) {
    if (s.status === 'planned' && s.day < todayKey && isAbsent(store.athlete, s.day)) s.status = 'absent';
  }
  const keep = plan.sessions.filter((s) => s.day < todayKey || s.status !== 'planned');
  const firstDay = todayIndex(plan.currentWeekStart, now);
  // gleicher Grundumfang wie bisher in dieser Woche (keine erneute Steigerung)
  const prevBase = plan.lastDecision && plan.lastDecision.baseMinutes;
  const goal = getGoal(store.athlete, plan.currentWeekStart);
  const phase = phaseFor(goal, plan.currentWeekStart, plan.weekIndex || 0, store.athlete.deloadEveryNWeeks);
  const volume = prevBase
    ? { baseMinutes: prevBase, enduranceMinutes: Math.round(Math.min(prevBase, goal.weeklyHours * 60) * phase.volume), reasons: ['Woche neu verteilt'] }
    : null;
  const week = buildWeek(store, plan.currentWeekStart, firstDay, { now, volume: volume || undefined, kept: keep });
  const keptDays = new Set(keep.filter((s) => s.day === todayKey).map((s) => s.sport));
  plan.sessions = [...keep, ...week.sessions.filter((s) => !(s.day === todayKey && keptDays.has(s.sport)))]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  plan.lastDecision = Object.assign(week.decision, { baseMinutes: prevBase || week.decision.baseMinutes });
  return plan;
}

// ---------------------------------------------------------------------------
// Auswertung der Vorwoche
// ---------------------------------------------------------------------------

// Einheit gilt als erledigt, wenn am selben Tag (±1 Tag) ein Training derselben
// Sportart-Gruppe importiert wurde (Rad = Rad oder Indoor-Rad usw.).
function evaluatePreviousWeek(store) {
  const { plan, activities, athlete } = store;
  if (!plan.currentWeekStart || plan.sessions.length === 0) return null;
  const weekStart = new Date(plan.currentWeekStart + 'T00:00:00Z');
  const used = new Set();
  const evaluated = plan.sessions.map((session) => {
    if (session.manualOverride) return session;
    if (session.status !== 'planned') return session;
    if (session.kind === 'race') return { ...session, status: 'done' };
    if (isAbsent(athlete, session.day)) return { ...session, status: 'absent' };
    const sessionDate = new Date(session.day + 'T00:00:00Z');
    const match = activities.find((act) => {
      if (used.has(act.id)) return false;
      const actDate = new Date(analysis.dayKeyOf(new Date(act.startDate)) + 'T00:00:00Z');
      const diffDays = Math.abs((actDate.getTime() - sessionDate.getTime()) / DAY_MS);
      return diffDays <= 1 && groupOf(act.type) === groupOf(session.sport);
    });
    if (match) used.add(match.id);
    return { ...session, status: match ? 'done' : 'missed', matchedActivityId: match ? match.id : null };
  });
  const counted = evaluated.filter((s) => s.kind !== 'mobility' && s.status !== 'absent'); // Dehnen und Krank/Urlaub zählen nicht
  const doneCount = counted.filter((s) => s.status === 'done').length;
  const completionRate = counted.length > 0 ? doneCount / counted.length : 1;
  const summary = analysis.computeWeeklySummary(activities, athlete, weekStart);
  return { weekStart: plan.currentWeekStart, sessions: evaluated, completionRate: round1(completionRate * 100), summary, phase: plan.lastDecision ? plan.lastDecision.phase : null };
}

// Laufende Woche: Status "erledigt" automatisch setzen, sobald das passende
// Training importiert ist (nur für vergangene/heutige Einheiten, ohne manuellen Status).
function autoMarkDone(store, now = new Date()) {
  const plan = store.plan;
  if (!plan.sessions || !plan.sessions.length) return false;
  const todayKey = recovery.dayKey(now);
  const usedIds = new Set(plan.sessions.map((s) => s.matchedActivityId).filter(Boolean));
  let changed = false;
  for (const s of plan.sessions) {
    if (s.status !== 'planned' || s.manualOverride || s.day > todayKey) continue;
    const match = store.activities.find((a) => !usedIds.has(a.id)
      && analysis.dayKeyOf(new Date(a.startDate)) === s.day
      && groupOf(a.type) === groupOf(s.sport)
      && (a.movingTimeSec || 0) >= Math.min(15, s.targetDurationMin * 0.4) * 60);
    if (match) {
      s.status = 'done';
      s.matchedActivityId = match.id;
      usedIds.add(match.id);
      changed = true;
    }
  }
  return changed;
}

// Ablauf, Code und Zielpulse für die Anzeige (nicht gespeichert, damit sich
// Änderungen an Max-/Ruhepuls sofort auswirken)
function decorateSessions(store) {
  const athlete = store.athlete;
  const ctxBase = { athlete, swimPace: workouts.swimPace(store.activities || []), targets: performance.targetsFor(store) };
  const lib = store.workoutLibrary || {};
  const mainGoal = getGoal(athlete, store.plan.currentWeekStart || recovery.dayKey(new Date()));
  const phaseKey = store.plan.lastDecision && store.plan.lastDecision.phase;
  let raceCtx = null;
  if (['runHalf', 'marathon'].includes(mainGoal.distance)) {
    const info = performance.raceInfo(store, { distance: mainGoal.distance, targetTimeSec: mainGoal.targetTimeSec });
    if (info && info.racePace) raceCtx = { racePace: info.racePace, basis: info.target ? `Zielzeit ${info.target}` : `Prognose ${info.predicted}` };
  }
  return (store.plan.sessions || []).map((s) => {
    const g = groupOf(s.sport);
    if (!['swim', 'bike', 'run', 'strength', 'mobility'].includes(g)) return s;
    const ctx = Object.assign({}, ctxBase, { strengthCount: s.variant === 'B' ? 1 : 0 });
    const w = workouts.buildWorkout(g, s.intensity, s.targetDurationMin, ctx);
    let title = w.title;
    if (s.kind === 'long') title = g === 'bike' ? 'Lange Ausfahrt' : g === 'run' ? 'Langer Lauf' : title;
    if (s.kind === 'brick') title = 'Koppellauf';
    const code = workouts.workoutCode(g, s.intensity, s.targetDurationMin, w);
    const steps = w.steps.filter(Boolean);
    // Halbmarathon/Marathon: lange Läufe in Aufbau/Vorbereitung mit Abschnitt im Renntempo
    if (s.kind === 'long' && g === 'run' && raceCtx && ['build', 'peak'].includes(phaseKey)) {
      const share = phaseKey === 'peak' ? 0.3 : 0.15;
      const n = Math.max(10, Math.round((s.targetDurationMin * share) / 5) * 5);
      const idx = steps.findIndex((x) => /auslaufen/.test(x.text));
      steps.splice(idx >= 0 ? idx : steps.length, 0, {
        label: `davon ${n} min`, zone: null, hr: null,
        text: `am Ende des Hauptteils im Renntempo ${raceCtx.racePace} /km (${raceCtx.basis}) – so gewöhnst du dich an das Tempo mit müden Beinen`
      });
    }
    if (s.kind === 'brick') {
      steps.unshift({ label: 'direkt', text: 'unmittelbar nach dem Rad loslaufen – Schuhe wechseln, keine Pause. Die ersten Minuten fühlen sich schwer an, das ist normal und genau der Trainingsreiz.', hr: null, zone: null });
    }
    const main = steps.filter((x) => x.hr).sort((a, b) => b.hr - a.hr)[0];
    const mainT = steps.filter((x) => x.zone && (x.pace || x.watts)).sort((a, b) => b.zone - a.zone || (b.pos || 0) - (a.pos || 0))[0];
    return Object.assign({}, s, {
      workout: {
        title, code, device: g === 'strength' ? 'technogym' : 'watch', created: !!lib[code],
        distance: w.distance || null, steps, mainHr: main ? main.hr : null,
        mainPace: mainT && mainT.pace ? mainT.pace : null, mainWatts: mainT && mainT.watts ? mainT.watts : null
      }
    });
  });
}

// Für Abwärtskompatibilität (alter Button "Neue Woche planen")
function generateNextWeekPlan(store) {
  return replanCurrentWeek(store);
}

// ---------------------------------------------------------------------------
// Tägliche Anpassung an die Erholung
// ---------------------------------------------------------------------------

// Liefert einen Vorschlag, die heutige (oder morgige) Einheit zu entschärfen,
// wenn die Erholung eingeschränkt ist oder die letzte Nacht sehr kurz war und
// eine harte Einheit ansteht. todayKey = 'YYYY-MM-DD' in Nutzer-Zeitzone.
function suggestAdjustment(store, rec, todayKey) {
  if (!store.plan || !Array.isArray(store.plan.sessions)) return null;
  const session = store.plan.sessions.find(
    (s) => s.day === todayKey && s.status === 'planned' && !s.adjusted && s.intensity !== 'easy' && !['race', 'mobility'].includes(s.kind)
  );
  if (!session) return null;
  // Gestern als (fast) maximal anstrengend bewertet?
  const yesterday = new Date(new Date(todayKey + 'T12:00:00Z').getTime() - DAY_MS).toISOString().slice(0, 10);
  const heavyYesterday = (store.activities || []).find((a) => a.rpe >= 9 && analysis.dayKeyOf(new Date(a.startDate)) === yesterday);
  const shortNight = rec && rec.lastNight && rec.lastNight.total < 6;
  const limited = rec && rec.status === 'eingeschränkt';
  const hrvLow = rec && rec.hrv && rec.hrv.todayLow;
  const trigger = limited || ((shortNight || heavyYesterday || hrvLow) && session.intensity === 'hard');
  if (!trigger) return null;
  const easy = easyVersion(session);
  const reason = limited
    ? `Deine Erholung ist eingeschränkt: ${rec.reasons.join(', ')}.`
    : hrvLow && !shortNight && !heavyYesterday
      ? `Deine HRV liegt heute deutlich unter deinem Normalbereich (${rec.hrv.range ? rec.hrv.range.join('–') + ' ms' : ''}) – Zeichen für Ermüdung oder Stress.`
      : shortNight
      ? `Du hast letzte Nacht nur ${Math.floor(rec.lastNight.total)}:${String(Math.round((rec.lastNight.total % 1) * 60)).padStart(2, '0')} h geschlafen.`
      : `Du hast dein Training gestern mit ${heavyYesterday.rpe}/10 bewertet – heute besser locker.`;
  return {
    sessionId: session.id,
    sport: session.sport,
    current: { intensity: session.intensity, durationMin: session.targetDurationMin, description: session.description },
    proposed: { intensity: 'easy', durationMin: easy.targetDurationMin, description: easy.description },
    reason
  };
}

function easyVersion(session) {
  const durationMin = Math.max(20, Math.round((session.targetDurationMin * 0.7) / 5) * 5);
  return {
    intensity: 'easy',
    targetDurationMin: durationMin,
    targetLoad: round1(durationMin * getIntensityFactor(session.sport, 'easy')),
    description: describeSession(session.sport, 'easy')
  };
}

// action: 'easy' (locker statt hart) oder 'undo' (ursprüngliche Einheit wiederherstellen)
function adjustSession(store, sessionId, action, reason) {
  const session = (store.plan.sessions || []).find((s) => s.id === sessionId);
  if (!session) return { error: 'Einheit nicht gefunden (evtl. wurde inzwischen neu geplant).' };
  if (action === 'easy') {
    if (session.adjusted) return { session };
    session.original = {
      intensity: session.intensity,
      targetDurationMin: session.targetDurationMin,
      targetLoad: session.targetLoad,
      description: session.description
    };
    Object.assign(session, easyVersion(session), { adjusted: true, adjustReason: reason || 'Angepasst wegen eingeschränkter Erholung' });
    return { session };
  }
  if (action === 'undo') {
    if (session.original) Object.assign(session, session.original);
    delete session.original;
    delete session.adjusted;
    delete session.adjustReason;
    return { session };
  }
  return { error: 'Unbekannte Aktion.' };
}

module.exports = {
  generateNextWeekPlan, ensureCurrentPlan, replanCurrentWeek, evaluatePreviousWeek, autoMarkDone,
  decorateSessions, suggestAdjustment, adjustSession, getGoal, getRaces, mainRace, isAbsent, raceMinutes, addDaysKey, phaseFor, DISTANCES, PHASES
};
