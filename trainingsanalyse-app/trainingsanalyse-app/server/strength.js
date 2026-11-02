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

// Technogym-Steckgewichte springen meist in 2,5- bzw. 5-kg-Schritten
function roundKg(kg) {
  return Math.round(kg / 2.5) * 2.5;
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
    oneRM: oneRM ? Math.round(oneRM) : null,
    ref: ref ? { weight: ref.weight, reps: ref.reps, date: ref.date } : null,
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
    oneRM: oneRM ? Math.round(oneRM) : null,
    ref: ref ? { weight: ref.weight, reps: ref.reps, date: ref.date } : null,
    sets: [{ label: `${ACCESSORY.sets} Sätze`, reps: ACCESSORY.reps, pct: pctText(ACCESSORY.pct), kg: kgRange(oneRM, ACCESSORY.pct), rir: rirText(ACCESSORY.rir) }]
  };
}

// Referenzsatz speichern (weight/reps) oder löschen (weight null)
function saveReference(athlete, key, weight, reps, now = new Date()) {
  if (!EXERCISES[key]) throw new Error('Unbekannte Übung.');
  athlete.strength = athlete.strength || {};
  if (weight === null || weight === undefined || weight === '') {
    delete athlete.strength[key];
    return null;
  }
  const w = Number(weight);
  const r = Math.round(Number(reps));
  if (!(w > 0 && w <= 500)) throw new Error('Gewicht zwischen 0 und 500 kg angeben.');
  if (!(r >= 1 && r <= 12)) throw new Error('Wiederholungen zwischen 1 und 12 angeben (darüber wird die Schätzung ungenau).');
  const oneRM = Math.round(estimateOneRM(w, r) * 10) / 10;
  athlete.strength[key] = { weight: w, reps: r, oneRM, date: now.toISOString().slice(0, 10) };
  return athlete.strength[key];
}

module.exports = { EXERCISES, SCHEMES, schemeFor, mainExercise, accessoryExercise, estimateOneRM, saveReference, roundKg };
