// Krafttraining: Satzvorgaben in % vom 1RM, Wdh.-Reserve (RIR) und – falls ein
// Referenzsatz je Übung eingetragen ist – konkrete Gewichte in kg.
//
// Das 1RM wird nie getestet, sondern aus einem fordernden Satz geschätzt
// (Epley: Gewicht × (1 + Wdh./30), zuverlässig bis ca. 10 Wdh.). Gespeichert in
// athlete.strength[key] = { weight, reps, oneRM, date }.

const EXERCISES = {
  legpress: { name: 'Beinpresse', type: 'main' },
  legcurl: { name: 'Beinbeuger (Leg Curl)', type: 'main' },
  latpull: { name: 'Latzug', type: 'main' },
  legpress1: { name: 'Beinpresse einbeinig', type: 'main', note: 'je Bein' },
  calfraise: { name: 'Wadenheben (Beinpresse)', type: 'main' },
  row: { name: 'Rudern (Low Row)', type: 'main' },
  backext: { name: 'Rückenstrecker', type: 'accessory' },
  abs: { name: 'Bauchmaschine', type: 'accessory' },
  abductor: { name: 'Abduktoren', type: 'accessory' },
  rotation: { name: 'Rumpfrotation', type: 'accessory', note: 'je Seite' }
};

// Schema je Trainingsphase. Ausdauersportler: wenig Wiederholungen, hohe Last,
// klar vor dem Muskelversagen (2 Wdh. Reserve) – Kraft ohne viel Ermüdung/Masse.
const SCHEMES = {
  base: { sets: 3, reps: '6', pct: [75, 80], rir: 2, why: 'Grundlage: Technik festigen, Last langsam steigern' },
  build: { sets: 4, reps: '5', pct: [80, 85], rir: 2, why: 'Aufbau: Maximalkraft – wenige, schwere Wiederholungen' },
  peak: { sets: 3, reps: '4', pct: [85, 85], rir: 2, why: 'Vorbereitung: Kraft halten, weniger Sätze für frische Beine' },
  light: { sets: 2, reps: '6', pct: [65, 70], rir: 4, why: 'Leichte Variante: Spannung halten, nicht ausbelasten' }
};
const ACCESSORY = { sets: 2, reps: '10–12', pct: [60, 65], rir: 2 };

function schemeFor(phase, light) {
  if (light || ['recovery', 'taper', 'race', 'post'].includes(phase)) return SCHEMES.light;
  return SCHEMES[phase] || SCHEMES.base;
}

function estimateOneRM(weight, reps) {
  if (!(weight > 0) || !(reps >= 1)) return null;
  if (reps === 1) return weight;
  return weight * (1 + Math.min(reps, 12) / 30);
}

// Biostrength-Geräte stellen den Widerstand elektronisch ein → auf 1 kg runden
function roundKg(kg) {
  return Math.round(kg);
}

function fmtKg(kg) {
  return `${String(roundKg(kg)).replace('.', ',')} kg`;
}

function kgRange(oneRM, pct) {
  if (!oneRM) return null;
  const lo = roundKg((oneRM * pct[0]) / 100);
  const hi = roundKg((oneRM * pct[1]) / 100);
  return lo === hi ? fmtKg(lo) : `${String(lo).replace('.', ',')}–${fmtKg(hi)}`;
}

function pctText(pct) {
  return pct[0] === pct[1] ? `${pct[0]} %` : `${pct[0]}–${pct[1]} %`;
}

function rirText(rir) {
  return rir >= 3 ? `${rir}+ Wdh. Reserve` : `${rir} Wdh. Reserve`;
}

// Vorgabe für eine Hauptübung: 1–2 Aufwärmsätze + Arbeitssätze
function mainExercise(key, scheme, athlete) {
  const ex = EXERCISES[key];
  const ref = athlete && athlete.strength && athlete.strength[key];
  const oneRM = ref && ref.oneRM;
  const warmups = scheme === SCHEMES.light
    ? [{ label: 'Aufwärmen', reps: '8', pct: [50, 50] }]
    : [{ label: 'Aufwärmen', reps: '8', pct: [50, 50] }, { label: 'Aufwärmen', reps: '3', pct: [70, 70] }];
  const sets = [
    ...warmups.map((w) => ({ label: w.label, reps: w.reps, pct: pctText(w.pct), kg: kgRange(oneRM, w.pct), warmup: true })),
    { label: `${scheme.sets} Sätze`, reps: scheme.reps, pct: pctText(scheme.pct), kg: kgRange(oneRM, scheme.pct), rir: rirText(scheme.rir) }
  ];
  return {
    label: `${scheme.sets} × ${scheme.reps}`,
    text: `${ex.name}${ex.note ? ` (${ex.note})` : ''} – 2–3 min Pause`,
    exercise: key,
    oneRM: oneRM ? half(oneRM) : null,
    ref: refInfo(ref),
    sets
  };
}

function accessoryExercise(key, athlete) {
  const ex = EXERCISES[key];
  const ref = athlete && athlete.strength && athlete.strength[key];
  const oneRM = ref && ref.oneRM;
  return {
    label: `${ACCESSORY.sets} × ${ACCESSORY.reps}`,
    text: `${ex.name}${ex.note ? ` (${ex.note})` : ''} – 60–90 s Pause`,
    exercise: key,
    oneRM: oneRM ? half(oneRM) : null,
    ref: refInfo(ref),
    sets: [{ label: `${ACCESSORY.sets} Sätze`, reps: ACCESSORY.reps, pct: pctText(ACCESSORY.pct), kg: kgRange(oneRM, ACCESSORY.pct), rir: rirText(ACCESSORY.rir) }]
  };
}

function half(v) { return Math.round(v * 2) / 2; }

function refInfo(ref) {
  if (!ref) return null;
  return { source: ref.source || 'set', weight: ref.weight || null, reps: ref.reps || null, date: ref.date };
}

// 1RM speichern: gemessen ({oneRM}, z.B. Biostrength-Test) oder aus einem
// Satz geschätzt ({weight, reps}). Alles leer = Eintrag löschen.
function saveReference(athlete, key, input, now = new Date()) {
  if (!EXERCISES[key]) throw new Error('Unbekannte Übung.');
  athlete.strength = athlete.strength || {};
  const empty = (v) => v === null || v === undefined || v === '';
  const date = now.toISOString().slice(0, 10);
  if (!empty(input.oneRM)) {
    const v = Number(String(input.oneRM).replace(',', '.'));
    if (!(v > 0 && v <= 500)) throw new Error('1RM zwischen 0 und 500 kg angeben.');
    athlete.strength[key] = { source: 'test', oneRM: Math.round(v * 10) / 10, date };
    return athlete.strength[key];
  }
  if (empty(input.weight)) {
    delete athlete.strength[key];
    return null;
  }
  const w = Number(String(input.weight).replace(',', '.'));
  const r = Math.round(Number(input.reps));
  if (!(w > 0 && w <= 500)) throw new Error('Gewicht zwischen 0 und 500 kg angeben.');
  if (!(r >= 1 && r <= 12)) throw new Error('Wiederholungen zwischen 1 und 12 angeben (darüber wird die Schätzung ungenau).');
  const oneRM = Math.round(estimateOneRM(w, r) * 10) / 10;
  athlete.strength[key] = { source: 'set', weight: w, reps: r, oneRM, date };
  return athlete.strength[key];
}

// Übersicht für die Einstellungen (Einheit A / B)
function overview(athlete) {
  const st = (athlete && athlete.strength) || {};
  const group = (keys) => keys.map((k) => ({ key: k, name: EXERCISES[k].name, note: EXERCISES[k].note || null, oneRM: st[k] ? half(st[k].oneRM) : null, ref: refInfo(st[k]) }));
  return {
    A: group(['legpress', 'legcurl', 'latpull', 'backext', 'abs']),
    B: group(['legpress1', 'calfraise', 'row', 'abductor', 'rotation'])
  };
}

module.exports = { half, EXERCISES, SCHEMES, schemeFor, mainExercise, accessoryExercise, estimateOneRM, saveReference, overview, roundKg };
