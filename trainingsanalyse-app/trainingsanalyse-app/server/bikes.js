'use strict';

// Fahrräder: km je Rad und Service-Intervalle (km und/oder Monate).
//
// athlete.bikes = [{
//   id, name, startKm, since (YYYY-MM-DD), retired,
//   defaultFor: 'outdoor' | 'indoor' | 'both' | null,
//   services: [{ id, name, intervalKm|null, intervalMonths|null, lastKm, lastDate, history: [{date, km}] }]
// }]
// Rad-Einheiten ohne eigene Zuordnung (activity.bikeId) zählen für das
// Standard-Rad ihrer Art (draußen/indoor) ab dessen Startdatum.
// activity.bikeId = 'none' heißt: bewusst keinem Rad zugeordnet.

const { dayKeyOf } = require('./analysis');

const BIKE_TYPES = ['Ride', 'VirtualRide'];

const SERVICE_PRESETS = [
  { name: 'Kette reinigen & ölen', intervalKm: 300, intervalMonths: null },
  { name: 'Kette prüfen / wechseln', intervalKm: 3000, intervalMonths: null },
  { name: 'Bremsbeläge prüfen', intervalKm: 1500, intervalMonths: 6 },
  { name: 'Reifen prüfen', intervalKm: 4000, intervalMonths: 12 },
  { name: 'Inspektion', intervalKm: 5000, intervalMonths: 12 }
];

function isBikeActivity(a) {
  return BIKE_TYPES.includes(a.type);
}

function isIndoor(a) {
  if (a.type === 'VirtualRide') return true;
  return /innen|indoor/i.test(`${a.name || ''} ${a.rawType || ''}`);
}

function matchesDefault(bike, a) {
  if (!bike.defaultFor || bike.retired) return false;
  if (bike.defaultFor === 'both') return true;
  return bike.defaultFor === (isIndoor(a) ? 'indoor' : 'outdoor');
}

// Welches Rad gilt für diese Aktivität? (id oder null)
function bikeIdFor(bikes, a) {
  if (!isBikeActivity(a)) return null;
  if (a.bikeId === 'none') return null;
  if (a.bikeId) return bikes.some((b) => b.id === a.bikeId) ? a.bikeId : null;
  const day = dayKeyOf(new Date(a.startDate));
  const def = bikes.find((b) => matchesDefault(b, a) && day >= (b.since || '0000'));
  return def ? def.id : null;
}

function round1(x) { return Math.round(x * 10) / 10; }

function addMonths(dayKey, months) {
  const d = new Date(dayKey + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

function serviceStatus(sv, bikeKm, today) {
  let due = false;
  let soon = false;
  let kmLeft = null;
  let daysLeft = null;
  let pct = 0;
  if (sv.intervalKm) {
    const used = bikeKm - (Number(sv.lastKm) || 0);
    kmLeft = Math.round(sv.intervalKm - used);
    pct = Math.max(pct, used / sv.intervalKm);
  }
  if (sv.intervalMonths && sv.lastDate) {
    const dueDate = addMonths(sv.lastDate, sv.intervalMonths);
    daysLeft = daysBetween(today, dueDate);
    const total = Math.max(1, daysBetween(sv.lastDate, dueDate));
    pct = Math.max(pct, (total - daysLeft) / total);
  }
  if ((kmLeft !== null && kmLeft <= 0) || (daysLeft !== null && daysLeft <= 0)) due = true;
  else if (pct >= 0.9) soon = true;
  return { kmLeft, daysLeft, pct: Math.round(Math.max(0, pct) * 100), due, soon };
}

function bikeStats(s, today) {
  const bikes = s.athlete.bikes || [];
  const totals = {};
  const rides = {};
  for (const b of bikes) { totals[b.id] = Number(b.startKm) || 0; rides[b.id] = 0; }
  for (const a of s.activities || []) {
    const id = bikeIdFor(bikes, a);
    if (!id) continue;
    totals[id] += (a.distanceMeters || 0) / 1000;
    rides[id]++;
  }
  return bikes.map((b) => {
    const km = round1(totals[b.id]);
    const services = (b.services || []).map((sv) => Object.assign({}, sv, { history: (sv.history || []).slice(0, 5) }, serviceStatus(sv, km, today)));
    return Object.assign({}, b, { km, rides: rides[b.id], services });
  });
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function cleanInterval(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, n));
}

function makeService(input, bikeKm, today) {
  const name = String(input.name || '').trim().slice(0, 40);
  const intervalKm = cleanInterval(input.intervalKm, 50, 50000);
  const intervalMonths = cleanInterval(input.intervalMonths, 1, 60);
  if (!name) throw new Error('Bitte einen Namen für den Service angeben.');
  if (!intervalKm && !intervalMonths) throw new Error('Bitte ein Intervall in km oder Monaten angeben.');
  return { id: newId('sv'), name, intervalKm, intervalMonths, lastKm: round1(bikeKm), lastDate: today, history: [] };
}

function pinRides(s, bikes) {
  for (const a of s.activities || []) {
    if (!isBikeActivity(a) || a.bikeId) continue;
    const id = bikeIdFor(bikes, a);
    if (id) a.bikeId = id;
  }
}

// Führt eine Aktion aus und verändert s.athlete.bikes / s.activities. Wirft bei Fehlern.
function applyAction(s, body, today) {
  const bikes = Array.isArray(s.athlete.bikes) ? s.athlete.bikes : [];
  s.athlete.bikes = bikes;
  const kmOf = (id) => (bikeStats(s, today).find((b) => b.id === id) || {}).km || 0;

  if (body.action === 'save') {
    const input = body.bike || {};
    const name = String(input.name || '').trim().slice(0, 40);
    if (!name) throw new Error('Bitte einen Namen für das Rad angeben.');
    const startKm = Math.max(0, Math.round(Number(input.startKm) || 0));
    const indoor = input.kind === 'indoor';
    const kind = indoor ? 'indoor' : 'outdoor';
    const taken = bikes.some((b) => !b.retired && (b.defaultFor === kind || b.defaultFor === 'both'));
    const bike = {
      id: newId('bk'), name, startKm, since: today, retired: false,
      defaultFor: taken ? null : kind,
      services: []
    };
    // Standard-Services: bei Indoor-Rädern nur Kette & Inspektion
    const presets = input.presets === false ? [] : SERVICE_PRESETS.filter((p) => !indoor || /Kette reinigen|Inspektion/.test(p.name));
    for (const p of presets) bike.services.push(makeService(p, startKm, today));
    bikes.push(bike);
    return;
  }

  const bike = bikes.find((b) => b.id === body.id);
  if (!bike) throw new Error('Rad nicht gefunden.');
  // Vor Änderungen an Standard/Ausmustern bisherige Fahrten fest zuordnen,
  // damit sie nicht zu einem anderen Rad "umziehen".
  if (['default', 'undefault', 'retire', 'unretire'].includes(body.action)) pinRides(s, bikes);
  bike.services = bike.services || [];

  switch (body.action) {
    case 'rename': {
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) throw new Error('Bitte einen Namen angeben.');
      bike.name = name;
      if (body.startKm !== undefined && body.startKm !== '') bike.startKm = Math.max(0, Math.round(Number(body.startKm) || 0));
      if (body.since !== undefined) {
        // leer = alle bisherigen Fahrten übernehmen
        if (body.since && !/^\d{4}-\d{2}-\d{2}$/.test(body.since)) throw new Error('Ungültiges Datum.');
        bike.since = body.since || '0000-01-01';
      }
      break;
    }
    case 'default': {
      const kind = ['outdoor', 'indoor', 'both'].includes(body.kind) ? body.kind : 'outdoor';
      for (const b of bikes) {
        if (b.id === bike.id) continue;
        if (kind === 'both' || b.defaultFor === 'both' || b.defaultFor === kind) {
          if (b.defaultFor === 'both' && kind !== 'both') b.defaultFor = kind === 'indoor' ? 'outdoor' : 'indoor';
          else b.defaultFor = null;
        }
      }
      bike.since = today;
      bike.defaultFor = kind;
      bike.retired = false;
      break;
    }
    case 'undefault':
      bike.defaultFor = null;
      break;
    case 'retire':
      bike.retired = true;
      bike.defaultFor = null;
      break;
    case 'unretire':
      bike.retired = false;
      break;
    case 'delete':
      s.athlete.bikes = bikes.filter((b) => b.id !== bike.id);
      for (const a of s.activities || []) if (a.bikeId === bike.id) delete a.bikeId;
      break;
    case 'addService':
      bike.services.push(makeService(body.service || {}, kmOf(bike.id), today));
      break;
    case 'deleteService':
      bike.services = bike.services.filter((sv) => sv.id !== body.serviceId);
      break;
    case 'editService': {
      const sv = bike.services.find((x) => x.id === body.serviceId);
      if (!sv) throw new Error('Service nicht gefunden.');
      const input = body.service || {};
      const intervalKm = cleanInterval(input.intervalKm, 50, 50000);
      const intervalMonths = cleanInterval(input.intervalMonths, 1, 60);
      if (!intervalKm && !intervalMonths) throw new Error('Bitte ein Intervall in km oder Monaten angeben.');
      if (input.name) sv.name = String(input.name).trim().slice(0, 40) || sv.name;
      sv.intervalKm = intervalKm;
      sv.intervalMonths = intervalMonths;
      break;
    }
    case 'resetService': {
      const sv = bike.services.find((x) => x.id === body.serviceId);
      if (!sv) throw new Error('Service nicht gefunden.');
      const km = kmOf(bike.id);
      sv.history = [{ date: today, km: Math.round(km) }].concat(sv.history || []).slice(0, 20);
      sv.lastKm = round1(km);
      sv.lastDate = today;
      break;
    }
    default:
      throw new Error('Unbekannte Aktion.');
  }
}

// Fällige / bald fällige Services aktiver Räder (für die Startseite)
function serviceAlerts(stats) {
  const out = [];
  for (const b of stats) {
    if (b.retired) continue;
    for (const sv of b.services) {
      if (sv.due || sv.soon) out.push({ bikeId: b.id, bikeName: b.name, serviceId: sv.id, name: sv.name, due: sv.due, kmLeft: sv.kmLeft, daysLeft: sv.daysLeft });
    }
  }
  return out.sort((a, b) => (b.due - a.due));
}

module.exports = { bikeStats, applyAction, serviceAlerts, isBikeActivity, bikeIdFor, SERVICE_PRESETS };
