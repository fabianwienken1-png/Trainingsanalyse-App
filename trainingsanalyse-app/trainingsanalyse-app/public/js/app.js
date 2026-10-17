// Hauptlogik der Trainingsanalyse-App (vanilla JS, keine Frameworks/Build-Step -
// dadurch läuft die App als einfache PWA ohne Build-Pipeline).
// Redesign Oktober 2026: vier Tabs (Heute / Plan / Aktivitäten / Analyse),
// Einrichtung (Import, Strava, Backup) liegt in den Einstellungen.

// ---------------------------------------------------------------------------
// Sportarten
// ---------------------------------------------------------------------------

const SPORT_LABELS = {
  Run: 'Laufen',
  TrailRun: 'Trail-Laufen',
  Ride: 'Radfahren',
  VirtualRide: 'Rad (indoor)',
  Swim: 'Schwimmen',
  WeightTraining: 'Krafttraining',
  Walk: 'Gehen',
  Hike: 'Wandern',
  Yoga: 'Yoga',
  Workout: 'Workout'
};

const ICONS = {
  swim: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18c2 0 2-1.5 4-1.5s2 1.5 4 1.5 2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M8 13l3-4 4 3"/><circle cx="17" cy="7" r="2"/></svg>',
  bike: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9L9 6H7"/></svg>',
  run: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="14" cy="4" r="2"/><path d="M6 21l4-6 3 2 1-5 4 3M9 9l3-2 3 3"/></svg>',
  strength: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/></svg>',
  other: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>'
};

// Feste Reihenfolge + Farbe pro Sportart-Gruppe (Triathlon-Fokus)
const SPORT_GROUPS = [
  { key: 'swim', label: 'Schwimmen', short: 'Schwimmen', color: '#5cc8f2', tint: '#16303b', types: ['Swim'] },
  { key: 'bike', label: 'Rad', short: 'Rad', color: '#f28c5c', tint: '#3a2418', types: ['Ride', 'VirtualRide'] },
  { key: 'run', label: 'Lauf', short: 'Lauf', color: '#d4f25c', tint: '#2b3a12', types: ['Run', 'TrailRun'] },
  { key: 'strength', label: 'Kraft', short: 'Kraft', color: '#b79cf2', tint: '#2a2338', types: ['WeightTraining'] },
  { key: 'other', label: 'Sonstiges', short: 'Sonst.', color: '#9a9da3', tint: '#26282c', types: [] }
];

function groupOf(type) {
  return SPORT_GROUPS.find((g) => g.types.includes(type)) || SPORT_GROUPS[SPORT_GROUPS.length - 1];
}

function sportLabel(type) {
  return SPORT_LABELS[type] || type || 'Training';
}

function activityTitle(act) {
  if (act.source === 'manual' && act.name) return act.name;
  const raw = `${act.name || ''} ${act.rawType || ''}`;
  const base = act.type === 'VirtualRide' ? 'Radfahren' : sportLabel(act.type);
  if (/innen|indoor/i.test(raw) || act.type === 'VirtualRide') return `Indoor ${base}`;
  if (act.type === 'Walk' && /spazier/i.test(raw)) return 'Spaziergang';
  return base;
}

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function fmtDuration(sec) {
  const min = Math.round((sec || 0) / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;
}

function fmtNum(n, digits = 1) {
  return n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtKm(m) {
  return `${fmtNum(m / 1000, 1)} km`;
}

function fmtPace(act) {
  const km = (act.distanceMeters || 0) / 1000;
  const sec = act.movingTimeSec || 0;
  if (!km || !sec) return null;
  const g = groupOf(act.type).key;
  const mmss = (s) => {
    const r = Math.round(s);
    return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
  };
  if (g === 'run' || act.type === 'Walk' || act.type === 'Hike') return `${mmss(sec / km)} /km`;
  if (g === 'swim') return `${mmss(sec / (km * 10))} /100 m`;
  if (g === 'bike') return `${fmtNum(km / (sec / 3600), 1)} km/h`;
  return null;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfLocalWeek(d) {
  const day = startOfLocalDay(d);
  const offset = (day.getDay() + 6) % 7; // Mo=0
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset);
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / DAY_MS + 1) / 7);
}

function fmtRange(start, end) {
  const sameMonth = start.getMonth() === end.getMonth();
  const a = start.toLocaleDateString('de-DE', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  const b = end.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
  return `${a}${sameMonth ? '.' : ''}–${b}`;
}

function relativeTime(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 2) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} min`;
  const d = new Date(iso);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (localKey(d) === localKey(new Date())) return `heute, ${time}`;
  if (localKey(d) === localKey(addDays(new Date(), -1))) return `gestern, ${time}`;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' }) + `, ${time}`;
}

function daysSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / DAY_MS;
}

// ---------------------------------------------------------------------------
// DOM-Helfer
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // nur für feste Icon-Strings
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function mount(id, ...nodes) {
  const box = document.getElementById(id);
  box.innerHTML = '';
  for (const n of nodes) if (n) box.appendChild(n);
  return box;
}

function sportIcon(group, small) {
  return el('div', {
    class: `sport-icon${small ? ' sm' : ''}`,
    style: `background:${group.tint};color:${group.color}`,
    html: ICONS[group.key]
  });
}

// ---------------------------------------------------------------------------
// Daten
// ---------------------------------------------------------------------------

let currentState = null;
let allActivities = [];
let activityTotal = 0;
let lastRefreshAt = 0;

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

class AuthError extends Error {}

// Jede API-Antwort mit 401 → Login-Bildschirm zeigen
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input.url;
  if (res.status === 401 && url.includes('/api/') && !url.includes('/api/login')) showLogin();
  return res;
};

let authEnabled = false;

function showLogin() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-root').hidden = true;
  document.querySelector('.tabbar').hidden = true;
  setTimeout(() => document.getElementById('login-password').focus(), 50);
}

function hideLogin() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-root').hidden = false;
  document.querySelector('.tabbar').hidden = false;
}

function setupLogin() {
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('login-password');
    const err = document.getElementById('login-error');
    const btn = e.submitter || e.target.querySelector('button');
    err.textContent = '';
    btn.disabled = true;
    try {
      const res = await nativeFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Anmeldung fehlgeschlagen.');
      }
      input.value = '';
      hideLogin();
      await refresh();
    } catch (ex) {
      err.textContent = ex.message;
      input.select();
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await nativeFetch('/api/logout', { method: 'POST' });
    showLogin();
  });
}

async function fetchJson(url, errMsg) {
  const res = await fetch(url);
  if (res.status === 401) throw new AuthError('Nicht angemeldet');
  if (!res.ok) throw new Error(errMsg);
  return res.json();
}

async function refresh() {
  const [state, acts] = await Promise.all([
    fetchJson('/api/state', 'Konnte Status nicht laden'),
    fetchJson('/api/activities?limit=5000', 'Konnte Aktivitäten nicht laden')
  ]);
  currentState = state;
  allActivities = acts.activities || [];
  activityTotal = acts.total ?? allActivities.length;
  lastRefreshAt = Date.now();
  renderAll();
}

function renderAll() {
  renderToday();
  renderPlan();
  renderActivities();
  if (activeView === 'analyse') renderAnalysis();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Tab "Heute"
// ---------------------------------------------------------------------------

const FORM_STATES = {
  niedrig: { chip: 'solid-warning', label: 'Unterfordert', text: 'Deine Belastung liegt deutlich unter deinem Schnitt der letzten 4 Wochen. Du kannst wieder steigern.' },
  optimal: { chip: 'solid-good', label: 'Optimal', text: 'Deine Belastung passt gut zu deinem Trainingsniveau. So weitermachen.' },
  'erhöht': { chip: 'solid-warning', label: 'Erhöht', text: 'Du steigerst schneller als gewohnt. Plane bewusst Erholung ein.' },
  hoch: { chip: 'solid-danger', label: 'Zu hoch', text: 'Deutlich mehr Belastung als gewohnt – das Verletzungsrisiko steigt. Nimm etwas raus.' },
  unbekannt: { chip: 'solid-muted', label: 'Noch offen', text: 'Noch zu wenig Trainingshistorie für eine verlässliche Einschätzung.' }
};

function formStateFor(riskLevel) {
  const key = Object.keys(FORM_STATES).find((k) => (riskLevel || '').startsWith(k));
  return FORM_STATES[key || 'unbekannt'];
}

function activitiesInRange(start, end) {
  const s = start.getTime();
  const e = end.getTime();
  return allActivities.filter((a) => {
    const t = new Date(a.startDate).getTime();
    return t >= s && t < e;
  });
}

function renderToday() {
  const now = new Date();
  document.getElementById('today-label').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const a = currentState.analysis;

  // Formstatus
  const fs = formStateFor(a.acwr.riskLevel);
  const acwr = a.acwr.acwr;
  const markerPos = acwr === null ? null : Math.min(100, (acwr / 2) * 100);
  mount('form-card', el('div', { class: 'card form-status' }, [
    el('div', { class: 'card-head', style: 'margin:0' }, [
      el('div', { class: 'head-with-info' }, [el('h2', {}, 'Formstatus'), infoButton('acwr', 'Formstatus')]),
      el('span', { class: `chip ${fs.chip}` }, fs.label)
    ]),
    el('div', { class: 'big-row' }, [
      el('div', { class: 'big' }, acwr === null ? '–' : fmtNum(acwr, 2)),
      el('div', { class: 'explain' }, fs.text)
    ]),
    el('div', {}, [
      el('div', { class: 'zone-scale', role: 'img', 'aria-label': acwr === null ? 'Belastungsverhältnis unbekannt' : `Belastungsverhältnis ${fmtNum(acwr, 2)}, optimal ist 0,8 bis 1,3` }, [
        el('span', { style: 'width:40%;background:#5cc8f2' }),
        el('span', { style: 'width:25%;background:#4ed17a' }),
        el('span', { style: 'width:10%;background:#f5b544' }),
        el('span', { style: 'width:25%;background:#f2685c' }),
        markerPos === null ? null : el('div', { class: 'marker', style: `left:${markerPos}%` })
      ]),
      el('div', { class: 'zone-labels' }, [el('span', {}, 'niedrig'), el('span', {}, 'optimal 0,8–1,3'), el('span', {}, 'hoch')])
    ])
  ]));

  renderRecovery();
  renderSuggestion();

  // Kennzahlen dieser Woche (lokale Kalenderwoche, Mo–So)
  const weekStart = startOfLocalWeek(now);
  const weekActs = activitiesInRange(weekStart, addDays(weekStart, 7));
  const weekSec = weekActs.reduce((s, x) => s + (x.movingTimeSec || 0), 0);
  mount('stat-tiles',
    el('div', { class: 'tile' }, [
      tileLabel('Wochenlast', 'wochenlast'),
      el('div', { class: 'value' }, String(Math.round(a.acwr.acute7))),
      el('div', { class: 'sub' }, 'letzte 7 Tage')
    ]),
    el('div', { class: 'tile' }, [
      tileLabel('Woche', 'woche'),
      el('div', { class: 'value' }, fmtDuration(weekSec).replace(' h', '').replace(' min', '′')),
      el('div', { class: 'sub' }, `${weekSec >= 3600 ? 'Std · ' : ''}${weekActs.length} ${weekActs.length === 1 ? 'Einheit' : 'Einh.'}`)
    ]),
    el('div', { class: 'tile' }, [
      tileLabel('Monotonie', 'monotonie'),
      el('div', { class: 'value' }, fmtNum(a.monotonyStrain.monotony, 1)),
      el('div', { class: 'sub' }, `Strain ${Math.round(a.monotonyStrain.strain)}`)
    ])
  );

  // Woche nach Sportart
  const todayKey = localKey(now);
  const days = [];
  const groupTotals = {};
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const acts = activitiesInRange(d, addDays(d, 1));
    const byGroup = {};
    for (const act of acts) {
      const g = groupOf(act.type).key;
      byGroup[g] = (byGroup[g] || 0) + (act.movingTimeSec || 0) / 60;
      groupTotals[g] = (groupTotals[g] || 0) + (act.movingTimeSec || 0) / 60;
    }
    days.push({ d, byGroup, total: Object.values(byGroup).reduce((s, v) => s + v, 0) });
  }
  const maxDay = Math.max(60, ...days.map((x) => x.total));
  const bars = el('div', { class: 'week-bars' }, days.map((day, i) => {
    const stack = el('div', { class: 'stack', style: `height:${day.total ? Math.max(6, (day.total / maxDay) * 66) : 4}px` },
      SPORT_GROUPS.filter((g) => day.byGroup[g.key]).map((g) =>
        el('span', { style: `height:${(day.byGroup[g.key] / day.total) * 100}%;background:${g.color}` })
      ));
    const label = `${WEEKDAYS_SHORT[i]}: ${day.total ? Math.round(day.total) + ' min' : 'kein Training'}`;
    return el('div', { class: `day${localKey(day.d) === todayKey ? ' today' : ''}`, title: label, 'aria-label': label }, [
      stack,
      el('span', { class: 'lbl' }, WEEKDAYS_SHORT[i])
    ]);
  }));
  const legend = el('div', { class: 'legend' }, SPORT_GROUPS
    .filter((g) => ['swim', 'bike', 'run'].includes(g.key) || groupTotals[g.key])
    .map((g) => el('span', {}, [el('span', { class: 'dot', style: `background:${g.color}` }), `${g.short} ${Math.round(groupTotals[g.key] || 0)}′`])));
  mount('week-card', el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('h2', {}, 'Woche nach Sportart'),
      el('span', { class: 'muted small' }, fmtRange(weekStart, addDays(weekStart, 6)))
    ]),
    bars,
    legend
  ]));

  // Nächste Einheit
  mount('next-session', renderNextSession(now));

  // Sync-Status
  const hc = currentState.appleHealth;
  if (hc.lastImportAt && daysSince(hc.lastImportAt) > SYNC_STALE_DAYS) {
    mount('sync-line', el('div', { class: 'sync-warning', role: 'status' }, [
      el('span', { 'aria-hidden': 'true' }, '!'),
      el('div', {}, [
        `Seit ${Math.floor(daysSince(hc.lastImportAt))} Tagen kein neuer Import. Prüfe, ob die Automation in Health Auto Export noch aktiv ist.`,
        el('div', {}, el('button', { class: 'pill-btn', type: 'button', onclick: openSettings }, 'Import prüfen'))
      ])
    ]));
  } else {
    mount('sync-line', el('div', { class: 'sync-line' }, [
      el('span', { class: 'dot', style: `background:${hc.lastImportAt ? 'var(--good)' : 'var(--muted)'}` }),
      hc.lastImportAt
        ? `Synchronisiert ${relativeTime(hc.lastImportAt)} · ${activityTotal} Trainings`
        : 'Noch kein Import – richte ihn in den Einstellungen ein.'
    ]));
  }
}

// ---------------------------------------------------------------------------
// Erklärungen zu den Kennzahlen (Info-Buttons)
// ---------------------------------------------------------------------------

const INFO_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.01"/></svg>';

function infoButton(key, label) {
  return el('button', {
    class: 'info-btn', type: 'button', 'aria-label': `Erklärung: ${label}`,
    html: INFO_ICON, onclick: () => openInfo(key)
  });
}

function tileLabel(text, key) {
  return el('div', { class: 'label label-row' }, [el('span', {}, text), infoButton(key, text)]);
}

function infoContent(key) {
  const a = currentState.analysis;
  const acwr = a.acwr.acwr;
  const mono = a.monotonyStrain.monotony;
  const strain = Math.round(a.monotonyStrain.strain);
  const acute = Math.round(a.acwr.acute7);
  const chronic = Math.round(a.acwr.chronicWeekly || 0);
  switch (key) {
    case 'acwr':
      return {
        title: 'Formstatus (ACWR)',
        paras: [
          'Das Belastungsverhältnis (Acute:Chronic Workload Ratio) vergleicht deine Trainingslast der letzten 7 Tage mit deinem Wochenschnitt der letzten 4 Wochen.',
          'Unter 0,8: du trainierst weniger als gewohnt, die Form kann nachlassen. 0,8–1,3: optimaler Bereich. 1,3–1,5: du steigerst schnell, achte auf Erholung. Über 1,5: deutlich erhöhtes Verletzungsrisiko.'
        ],
        current: acwr === null
          ? 'Für eine verlässliche Einschätzung fehlt noch Trainingshistorie (mindestens 14 Tage).'
          : `Aktuell ${fmtNum(acwr, 2)}: ${acute} Punkte in den letzten 7 Tagen gegenüber durchschnittlich ${chronic} Punkten pro Woche in den letzten 4 Wochen.`
      };
    case 'wochenlast':
      return {
        title: 'Wochenlast',
        paras: [
          'Die Summe der Trainingslast-Punkte der letzten 7 Tage. Jede Einheit bekommt Punkte aus Dauer und Intensität: Mit Puls (Ø-Herzfrequenz im Verhältnis zu Ruhe- und Maximalpuls) wird nach der TRIMP-Methode gerechnet, ohne Puls grob nach Sportart und Dauer geschätzt.',
          '60 Minuten locker ergeben deutlich weniger Punkte als 60 Minuten hart. So lassen sich unterschiedliche Sportarten und Intensitäten vergleichen.'
        ],
        current: `Aktuell ${acute} Punkte. Dein Wochenschnitt der letzten 4 Wochen liegt bei ${chronic} Punkten.`
      };
    case 'woche':
      return {
        title: 'Diese Woche',
        paras: [
          'Die reine Trainingszeit und die Zahl der Einheiten in der laufenden Kalenderwoche (Montag bis Sonntag).',
          'Anders als die Wochenlast berücksichtigt dieser Wert keine Intensität – eine Stunde lockeres Radeln zählt hier genauso viel wie eine Stunde Intervalle.'
        ],
        current: null
      };
    case 'monotonie':
      return {
        title: 'Monotonie & Strain',
        paras: [
          'Monotonie zeigt, wie gleichmäßig deine Belastung über die letzten 7 Tage verteilt ist (Ø-Tageslast geteilt durch die Schwankung). Über 2: jeder Tag ist ähnlich belastend, ohne echte leichte Tage – das erhöht das Risiko für Übertraining und Infekte. Gut ist etwa 1–1,5: harte und leichte Tage wechseln sich ab.',
          'Strain ist die Gesamtbeanspruchung der Woche: Wochenlast × Monotonie. Viel Training und wenig Abwechslung ergeben einen hohen Strain. Am aussagekräftigsten im Vergleich mit deinen eigenen Wochen – steigt er stark an, plane Erholung ein.'
        ],
        current: `Aktuell Monotonie ${fmtNum(mono, 1)} und Strain ${strain}. ` + (mono > 2
          ? 'Deine Belastung ist sehr gleichförmig – bau bewusst leichtere Tage ein.'
          : mono < 1
            ? 'Wenige Einheiten mit Ruhetagen dazwischen – unkritisch.'
            : 'Gute Abwechslung zwischen härteren und leichteren Tagen.')
      };
    case 'plan': {
      const d = currentState.plan.lastDecision || {};
      return {
        title: 'So entsteht dein Plan',
        paras: [
          'Phasen: Ohne Wettkampf trainierst du in der Grundlage. Mit Wettkampf-Datum durchläuft der Plan Grundlage (mehr als 16 Wochen vorher) → Aufbau → Wettkampfvorbereitung (letzte 8 Wochen, beim Triathlon mit Koppeltraining) → Tapering (10 km: 1 Woche, Triathlon & Halbmarathon: 2 Wochen, Marathon: 3 Wochen) → Wettkampfwoche. Jede 4. Woche ist eine Entlastungswoche.',
          'Umfang: steigt um max. 10 % pro Woche – aber nur, wenn du die Vorwoche zu mindestens 70 % geschafft hast, die Belastung (ACWR) nicht erhöht und deine Erholung nicht eingeschränkt ist. Obergrenze sind deine verfügbaren Stunden.',
          'Verteilung: Triathlon-Mix nach Distanz bzw. bei Laufzielen 3–5 Läufe plus lockeres Rad/Schwimmen als Ausgleich, lange Einheiten am Wochenende, nur 1–2 fordernde Einheiten pro Woche (80/20-Prinzip), Kraft fest eingeplant. Jeden Montag wird die Vorwoche ausgewertet und automatisch neu geplant.'
        ],
        current: d.reason || null
      };
    }
    case 'erholung': {
      const rec = currentState.recovery;
      return {
        title: 'Erholung',
        paras: [
          'Schlaf ist der wichtigste Erholungsfaktor: Im Tiefschlaf repariert der Körper Muskeln und baut Trainingsreize in Leistung um. Ausdauersportler brauchen meist 7–9 Stunden.',
          'Die Einschätzung kombiniert deinen Schlaf der letzten 7 Nächte, die letzte Nacht und – falls vorhanden – Herzfrequenzvariabilität (HRV) und Ruhepuls im Vergleich zu deinem eigenen 4-Wochen-Schnitt. Eine niedrige HRV oder ein erhöhter Ruhepuls deuten auf Ermüdung, Stress oder einen beginnenden Infekt hin.',
          'Bei eingeschränkter Erholung reduziert der Wochenplan die Belastung automatisch leicht.',
          'Nächte ohne Aufzeichnung (z.B. Uhr nicht getragen) werden einfach ausgelassen: Sie zählen nicht als 0 Stunden, die Durchschnitte werden nur aus den aufgezeichneten Nächten gebildet.'
        ],
        current: !rec ? null : rec.reasons.length
          ? `Aktuell: ${rec.reasons.join(', ')}.`
          : `Aktuell keine Auffälligkeiten${rec.sleepAvg7 !== null ? ` – Ø ${fmtHours(rec.sleepAvg7)} h Schlaf in den letzten 7 Nächten` : ''}.`
      };
    }
    default:
      return null;
  }
}

function openInfo(key) {
  const info = infoContent(key);
  if (!info) return;
  document.getElementById('info-title').textContent = info.title;
  mount('info-body',
    ...info.paras.map((t) => el('p', { class: 'info-text' }, t)),
    info.current ? el('div', { class: 'info-current' }, info.current) : null
  );
  document.getElementById('info-dialog').showModal();
}

// ---------------------------------------------------------------------------
// Erholung (Schlaf, HRV, Ruhepuls)
// ---------------------------------------------------------------------------

const RECOVERY_STATES = {
  gut: { chip: 'solid-good', label: 'Gut erholt' },
  normal: { chip: 'solid-muted', label: 'Normal' },
  'eingeschränkt': { chip: 'solid-warning', label: 'Eingeschränkt' }
};

function fmtHours(h) {
  if (h === null || h === undefined) return '–';
  const min = Math.round(h * 60);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

function recoveryMetric(label, value, sub) {
  return el('div', { class: 'rec-metric' }, [
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, value),
    sub ? el('div', { class: 'sub' }, sub) : null
  ]);
}

function renderRecovery() {
  const rec = currentState.recovery;
  if (!rec) {
    mount('recovery-card', el('button', { class: 'card next-card', type: 'button', onclick: openSettings, style: 'width:100%;text-align:left;color:inherit' }, [
      el('div', { class: 'sport-icon', style: 'background:#23203a;color:#9b8cf2', html: MOON_ICON }),
      el('div', { class: 'txt' }, [
        el('div', { class: 't1' }, 'Schlaf & Erholung'),
        el('div', { class: 't2' }, 'Noch keine Schlafdaten – jetzt verbinden')
      ]),
      chevron()
    ]));
    return;
  }
  const st = RECOVERY_STATES[rec.status] || RECOVERY_STATES.normal;
  const ln = rec.lastNight;
  const phases = ln ? [ln.deep ? `Tief ${fmtHours(ln.deep)}` : null, ln.rem ? `REM ${fmtHours(ln.rem)}` : null].filter(Boolean).join(' · ') : '';
  const metrics = [
    recoveryMetric('Ø 7 Nächte', rec.sleepAvg7 !== null ? `${fmtHours(rec.sleepAvg7)} h` : '–', rec.sleepAvg28 !== null ? `4 Wo.: ${fmtHours(rec.sleepAvg28)} h` : null),
    rec.hrv ? recoveryMetric('HRV', `${Math.round(rec.hrv.latest)} ms`, rec.hrv.baseline ? `Ø ${Math.round(rec.hrv.baseline)} ms` : null) : null,
    rec.restingHR ? recoveryMetric('Ruhepuls', `${Math.round(rec.restingHR.latest)}`, rec.restingHR.baseline ? `Ø ${Math.round(rec.restingHR.baseline)}` : null) : null
  ].filter(Boolean);
  mount('recovery-card', el('div', { class: 'card recovery' }, [
    el('div', { class: 'card-head', style: 'margin-bottom:10px' }, [
      el('div', { class: 'head-with-info' }, [el('h2', {}, 'Erholung'), infoButton('erholung', 'Erholung')]),
      el('span', { class: `chip ${st.chip}` }, st.label)
    ]),
    el('div', { class: 'rec-main' }, [
      el('div', { class: 'sport-icon', style: 'background:#23203a;color:#9b8cf2', html: MOON_ICON }),
      ln
        ? el('div', {}, [
          el('div', { class: 'muted small' }, 'Schlaf letzte Nacht'),
          el('div', { class: 'rec-big' }, [`${fmtHours(ln.total)}`, el('span', { class: 'unit' }, ' h')]),
          phases ? el('div', { class: 'muted small' }, phases) : null
        ])
        : el('div', {}, [
          el('div', { class: 'muted small' }, 'Schlaf letzte Nacht'),
          el('div', { class: 'rec-missing' }, 'Nicht aufgezeichnet'),
          rec.lastRecorded
            ? el('div', { class: 'muted small' }, `Zuletzt: ${fmtHours(rec.lastRecorded.total)} h in der Nacht zum ${new Date(rec.lastRecorded.day + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}`)
            : null
        ])
    ]),
    el('div', { class: 'rec-metrics', style: `grid-template-columns:repeat(${metrics.length}, minmax(0,1fr))` }, metrics),
    rec.status === 'eingeschränkt' && rec.reasons.length
      ? el('div', { class: 'rec-note' }, `${rec.reasons.join(', ')}. Heute lieber locker trainieren.`)
      : null
  ]));
}

const INTENSITY_LABELS = { easy: 'locker', moderate: 'mittel', hard: 'hart' };

function dismissedKey(id) { return `dismiss-suggestion-${id}`; }
function isDismissed(id) {
  try { return localStorage.getItem(dismissedKey(id)) === '1'; } catch (e) { return false; }
}
function dismiss(id) {
  try { localStorage.setItem(dismissedKey(id), '1'); } catch (e) { /* egal */ }
}

function renderSuggestion() {
  const sug = currentState.planSuggestion;
  if (!sug || isDismissed(sug.sessionId)) {
    mount('plan-suggestion');
    return;
  }
  const g = groupOf(sug.sport);
  mount('plan-suggestion', el('div', { class: 'card suggestion' }, [
    el('div', { class: 'card-head', style: 'margin-bottom:8px' }, [el('h2', {}, 'Vorschlag für heute')]),
    el('p', { class: 'info-text', style: 'margin-bottom:12px' }, `${sug.reason} Statt der ${INTENSITY_LABELS[sug.current.intensity] || ''}en Einheit lieber locker trainieren.`),
    el('div', { class: 'swap' }, [
      el('div', { class: 'swap-item old' }, [
        el('span', { class: 'sport-bar', style: `background:${g.color};min-height:34px` }),
        el('div', {}, [el('div', { class: 'small muted' }, 'Geplant'), el('div', { class: 't' }, `${sportLabel(sug.sport)} · ${INTENSITY_LABELS[sug.current.intensity]} · ${sug.current.durationMin} min`)])
      ]),
      el('div', { class: 'swap-arrow', 'aria-hidden': 'true' }, '↓'),
      el('div', { class: 'swap-item' }, [
        el('span', { class: 'sport-bar', style: `background:${g.color};min-height:34px` }),
        el('div', {}, [el('div', { class: 'small muted' }, 'Vorschlag'), el('div', { class: 't' }, `${sportLabel(sug.sport)} · locker · ${sug.proposed.durationMin} min`)])
      ])
    ]),
    el('div', { class: 'session-actions', style: 'margin-top:14px' }, [
      el('button', { type: 'button', class: 'accept', onclick: () => onAdjustSession(sug.sessionId, 'easy', sug.reason) }, 'Übernehmen'),
      el('button', { type: 'button', class: 'ghost', onclick: () => { dismiss(sug.sessionId); renderSuggestion(); } }, 'Wie geplant')
    ])
  ]));
}

async function onAdjustSession(sessionId, action, reason) {
  try {
    const res = await fetch('/api/plan/adjust-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action, reason })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Unbekannter Fehler');
    }
    await refresh();
  } catch (err) {
    alert('Anpassung fehlgeschlagen: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Spontan trainieren
// ---------------------------------------------------------------------------

const SPONTAN_MINUTES = [30, 45, 60, 90, 120];
const SPONTAN_SPORTS = [
  { key: '', label: 'Vorschlag' },
  { key: 'swim', label: 'Schwimmen', color: '#5cc8f2' },
  { key: 'bike', label: 'Rad', color: '#f28c5c' },
  { key: 'run', label: 'Lauf', color: '#d4f25c' },
  { key: 'strength', label: 'Kraft', color: '#b79cf2' }
];
const INTENSITY_CHIP = { rest: 'solid-muted', easy: 'outline-good', moderate: 'solid-warning', hard: 'solid-danger' };
const spontan = { minutes: 45, sport: '', reqId: 0 };

function loadSpontanPrefs() {
  try {
    const m = Number(localStorage.getItem('spontan-minutes'));
    if (SPONTAN_MINUTES.includes(m)) spontan.minutes = m;
  } catch (e) { /* egal */ }
}

function renderSpontanChips() {
  mount('spontan-minutes', ...SPONTAN_MINUTES.map((m) => el('button', {
    class: 'filter-chip', type: 'button', 'aria-pressed': String(spontan.minutes === m),
    onclick: () => {
      spontan.minutes = m;
      try { localStorage.setItem('spontan-minutes', String(m)); } catch (e) { /* egal */ }
      renderSpontanChips();
      loadSpontan();
    }
  }, m >= 60 ? `${m / 60 % 1 ? (m / 60).toString().replace('.', ',') : m / 60} h` : `${m} min`)));
  mount('spontan-sport', ...SPONTAN_SPORTS.map((sp) => el('button', {
    class: 'filter-chip', type: 'button', 'aria-pressed': String(spontan.sport === sp.key),
    onclick: () => { spontan.sport = sp.key; renderSpontanChips(); loadSpontan(); }
  }, [sp.color ? el('span', { class: 'dot', style: `background:${sp.color}` }) : null, sp.label])));
}

function openSpontan() {
  renderSpontanChips();
  document.getElementById('spontan-dialog').showModal();
  loadSpontan();
}

async function loadSpontan() {
  const id = ++spontan.reqId;
  const box = document.getElementById('spontan-result');
  box.style.opacity = '0.5';
  try {
    const params = new URLSearchParams({ minutes: String(spontan.minutes) });
    if (spontan.sport) params.set('sport', spontan.sport);
    const data = await fetchJson('/api/suggest?' + params.toString(), 'Vorschlag konnte nicht geladen werden');
    if (id !== spontan.reqId) return;
    renderSpontanResult(data);
  } catch (err) {
    if (id === spontan.reqId) mount('spontan-result', el('div', { class: 'card muted' }, err.message));
  } finally {
    if (id === spontan.reqId) box.style.opacity = '1';
  }
}

function spontanIcon(w) {
  if (w.sport === 'rest') return el('div', { class: 'sport-icon', style: 'background:#23203a;color:#9b8cf2', html: MOON_ICON });
  const g = SPORT_GROUPS.find((x) => x.key === w.sport) || SPORT_GROUPS[SPORT_GROUPS.length - 1];
  return sportIcon(g);
}

function workoutCard(w, whyTitle = 'Warum dieser Vorschlag?') {
  const meta = [`${w.minutes} min`, w.distance ? `ca. ${w.distance.toLocaleString('de-DE')} m` : null].filter(Boolean).join(' · ');
  return el('div', { class: 'card spontan-card' }, [
    el('div', { class: 'spontan-head' }, [
      spontanIcon(w),
      el('div', { class: 'txt' }, [
        el('div', { class: 'small muted' }, w.sportLabel),
        el('div', { class: 'spontan-title' }, w.title),
        el('div', { class: 'small muted' }, meta)
      ]),
      el('span', { class: `chip ${INTENSITY_CHIP[w.intensity] || 'solid-muted'}` }, w.intensityLabel)
    ]),
    codeRow(w),
    el('ol', { class: 'steps' }, w.steps.map((st) => el('li', {}, [
      el('span', { class: 'step-label' }, [
        st.label,
        st.hr ? el('span', { class: 'step-hr', 'aria-label': `Zielpuls ${st.hr}` }, [el('span', { class: 'heart', 'aria-hidden': 'true' }, '♥'), ` ${st.hr}`]) : null,
        !st.hr && st.zone ? el('span', { class: 'step-hr muted' }, `Zone ${st.zone}`) : null
      ]),
      el('span', { class: 'step-text' }, st.text)
    ]))),
    w.steps.some((st) => st.hr) ? null : (w.sport === 'strength' ? null : el('p', { class: 'muted small', style: 'margin:12px 0 0' }, 'Trag Maximal- und Ruhepuls in den Einstellungen ein, dann siehst du hier zu jedem Abschnitt den Zielpuls.')),
    w.sport === 'swim' && w.steps.some((st) => st.hr) ? el('p', { class: 'muted small', style: 'margin:12px 0 0' }, 'Im Wasser liegt der Puls bei gleicher Anstrengung meist 10–15 Schläge niedriger als an Land – die Zielwerte sind deshalb niedriger angesetzt.') : null,
    w.why && w.why.length ? el('div', { class: 'why' }, [
      el('div', { class: 'small muted', style: 'margin-bottom:6px' }, whyTitle),
      el('ul', {}, w.why.map((r) => el('li', {}, r.charAt(0).toUpperCase() + r.slice(1))))
    ]) : null
  ]);
}

function renderSpontanResult(data) {
  const w = data.primary;
  const nodes = [];
  if (data.plannedToday) {
    nodes.push(el('div', { class: 'rec-note', style: 'margin:0' },
      `Heute steht schon ${sportLabel(data.plannedToday.sport)} (${INTENSITY_LABELS[data.plannedToday.intensity] || ''}, ${data.plannedToday.durationMin} min) im Plan. Wenn du nur einmal trainierst, hat die Plan-Einheit Vorrang.`));
  }
  nodes.push(workoutCard(w));
  if (data.alternatives && data.alternatives.length) {
    nodes.push(el('h3', { class: 'section-title', style: 'margin-top:4px' }, w.sport === 'rest' ? 'Falls du dich doch fit fühlst' : 'Alternativen'));
    for (const alt of data.alternatives) {
      nodes.push(el('button', {
        class: 'card next-card', type: 'button', style: 'width:100%;text-align:left;color:inherit',
        onclick: () => { spontan.sport = alt.sport; renderSpontanChips(); loadSpontan(); }
      }, [
        spontanIcon(alt),
        el('div', { class: 'txt' }, [
          el('div', { class: 't1' }, `${alt.code}${alt.created ? ' ✓' : ''} · ${alt.sportLabel} · ${alt.intensityLabel} · ${alt.minutes} min`),
          el('div', { class: 't2', style: 'font-size:15px' }, alt.title)
        ]),
        chevron()
      ]));
    }
  }
  mount('spontan-result', ...nodes);
}

const DEVICE_LABEL = { watch: 'Apple Watch', technogym: 'Technogym-App' };

function codeRow(w) {
  if (!w.code) return null;
  const lib = (currentState && currentState.workoutLibrary) || {};
  const created = !!lib[w.code];
  const where = DEVICE_LABEL[w.device] || 'Uhr';
  const hint = w.device === 'technogym'
    ? `Einmalig in der Technogym-App unter „Ihre Workouts“ → + anlegen und „${w.code}“ nennen. Beim nächsten Mal nur noch nach dem Code suchen.`
    : `Einmalig in der Fitness-App auf dem iPhone anlegen: Trainings → Sportart → Timer-Symbol → „Eigene“ → +, Name „${w.code}“. Danach findest du es direkt auf der Watch.`;
  return el('div', { class: 'code-box' }, [
    el('div', { class: 'code-row' }, [
      el('span', { class: 'code-badge' }, w.code),
      created
        ? el('button', { class: 'code-status ok', type: 'button', title: 'Markierung entfernen', onclick: () => setLibrary(w, false) }, `✓ Auf ${where === 'Apple Watch' ? 'der Watch' : 'Technogym'} angelegt`)
        : el('button', { class: 'code-status', type: 'button', onclick: () => setLibrary(w, true) }, 'Als angelegt markieren')
    ]),
    created ? null : el('div', { class: 'code-hint' }, hint)
  ]);
}

async function setLibrary(w, created) {
  try {
    const res = await fetch('/api/workout-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: w.code, created, title: `${w.sportLabel} · ${w.title}`, device: w.device })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Unbekannter Fehler');
    currentState.workoutLibrary = body.library;
    if (document.getElementById('spontan-dialog').open) loadSpontan();
    if (document.getElementById('session-detail-dialog').open && openSessionId) {
      await refresh();
      openSessionDetail(openSessionId);
    }
    renderLibrary();
  } catch (err) {
    alert('Speichern fehlgeschlagen: ' + err.message);
  }
}

function renderLibrary() {
  const lib = (currentState && currentState.workoutLibrary) || {};
  const codes = Object.keys(lib).sort();
  if (!codes.length) {
    mount('workout-library', el('p', { class: 'muted small', style: 'margin:0' }, 'Noch keine Einheiten gespeichert. Markiere bei „Spontan trainieren“ eine Einheit als angelegt, dann erscheint sie hier.'));
    return;
  }
  mount('workout-library', el('div', { class: 'lib-list' }, codes.map((c) => el('div', { class: 'lib-item' }, [
    el('span', { class: 'code-badge sm' }, c),
    el('div', { class: 'txt' }, [
      el('div', { class: 'small' }, lib[c].title || ''),
      el('div', { class: 'small muted' }, DEVICE_LABEL[lib[c].device] || '')
    ]),
    el('button', { class: 'reset-btn', type: 'button', onclick: () => setLibrary({ code: c }, false) }, 'Entfernen')
  ]))), el('p', { class: 'muted small', style: 'margin:12px 0 0' }, 'Code-Schema: S = Schwimmen, R = Rad, L = Lauf, K = Kraft · GA = locker, TE = Tempo, IN = Intervalle · Zahl = Minuten. K-A/K-B = Krafteinheit A/B, „-L“ = leichte Variante.'));
}

const MOON_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';

function planWeekInfo() {
  const plan = currentState.plan;
  if (!plan || !plan.currentWeekStart || !plan.sessions || !plan.sessions.length) return { exists: false };
  const [y, m, d] = plan.currentWeekStart.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end = addDays(start, 7);
  const today = startOfLocalDay(new Date());
  return { exists: true, start, end, stale: today >= end, future: today < start };
}

function renderNextSession(now) {
  const info = planWeekInfo();
  const goPlan = () => { location.hash = '#plan'; };
  if (!info.exists || info.stale) {
    return el('button', { class: 'card next-card', type: 'button', onclick: goPlan, style: 'width:100%;text-align:left;color:inherit' }, [
      el('div', { class: 'sport-icon', style: 'background:#2b3a12;color:var(--accent)', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' }),
      el('div', { class: 'txt' }, [
        el('div', { class: 't1' }, 'Trainingsplan'),
        el('div', { class: 't2' }, info.exists ? 'Plan ist abgelaufen – neue Woche planen' : 'Noch kein Plan – jetzt erstellen')
      ]),
      chevron()
    ]);
  }
  const todayKey = localKey(now);
  const next = currentState.plan.sessions.find((s) => s.status === 'planned' && s.day >= todayKey);
  if (!next) {
    return el('div', { class: 'card next-card' }, [
      el('div', { class: 'sport-icon', style: 'background:#16301f;color:var(--good)', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>' }),
      el('div', { class: 'txt' }, [el('div', { class: 't1' }, 'Diese Woche'), el('div', { class: 't2' }, 'Keine offenen Einheiten mehr')])
    ]);
  }
  const g = groupOf(next.sport);
  const goNext = () => { location.hash = '#plan'; setTimeout(() => openSessionDetail(next.id), 50); };
  const [y, m, d] = next.day.split('-').map(Number);
  const dayDate = new Date(y, m - 1, d);
  const when = next.day === todayKey ? 'Heute' : dayDate.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  return el('button', { class: 'card next-card', type: 'button', onclick: next.kind === 'race' ? goPlan : goNext, style: 'width:100%;text-align:left;color:inherit' }, [
    next.kind === 'race' ? el('div', { class: 'sport-icon', style: 'background:#3a2e12;color:#f5b544', html: FLAG_ICON }) : sportIcon(g),
    el('div', { class: 'txt' }, [
      el('div', { class: 't1' }, `Als Nächstes · ${when}`),
      el('div', { class: 't2' }, next.kind === 'race'
        ? next.description
        : `${next.workout ? next.workout.title : sportLabel(next.sport)} · ${next.targetDurationMin} min${planTargetHr(next) ? ` · ♥ ${planTargetHr(next)}` : ''}`)
    ]),
    chevron()
  ]);
}

function chevron() {
  return el('span', { 'aria-hidden': 'true', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9a9da3" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>' });
}

// ---------------------------------------------------------------------------
// Tab "Plan"
// ---------------------------------------------------------------------------

const FLAG_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>';
const PHASE_CHIP = { base: 'solid-muted', build: 'solid-warning', peak: 'solid-danger', recovery: 'outline-good', taper: 'outline-good', race: 'solid-warning', post: 'outline-good' };

function renderPlan() {
  const info = planWeekInfo();
  const label = document.getElementById('plan-week-label');
  const sessionsBox = document.getElementById('plan-sessions');
  sessionsBox.innerHTML = '';
  const plan = currentState.plan;
  const d = plan.lastDecision || {};
  const goal = currentState.goal || {};

  if (!info.exists) {
    label.textContent = '';
    mount('plan-summary', el('div', { class: 'card empty-state' }, [
      'Für diese Woche ist nichts mehr geplant (z.B. nur noch Ruhetage).',
      el('button', { class: 'primary-btn', type: 'button', onclick: () => openSettings('goal') }, 'Saisonziel & Trainingszeit einstellen')
    ]));
    return;
  }
  label.textContent = `KW ${isoWeek(info.start)} · ${fmtRange(info.start, addDays(info.start, 6))}`;

  const sessions = plan.sessions.filter((s) => s.kind !== 'race');
  const total = sessions.length;
  const done = sessions.filter((s) => s.status === 'done').length;
  const plannedMin = sessions.reduce((a, s) => a + s.targetDurationMin, 0);
  const doneMin = sessions.filter((s) => s.status === 'done').reduce((a, s) => a + s.targetDurationMin, 0);
  const countdown = d.weeksToRace !== null && d.weeksToRace !== undefined && d.weeksToRace > 0
    ? `noch ${d.weeksToRace} ${d.weeksToRace === 1 ? 'Woche' : 'Wochen'} bis ${goal.name || 'zum Wettkampf'}`
    : d.weeksToRace === 0 ? 'Wettkampfwoche!' : (goal.date ? '' : 'kein Wettkampf eingetragen');

  mount('plan-summary', el('div', { class: 'card' }, [
    el('div', { class: 'card-head', style: 'margin:0 0 10px' }, [
      el('div', { class: 'head-with-info' }, [el('h2', {}, 'Diese Woche'), infoButton('plan', 'Trainingsplan')]),
      el('span', { class: `chip ${PHASE_CHIP[d.phase] || 'solid-muted'}` }, d.phaseLabel || 'Grundlage')
    ]),
    el('div', { class: 'plan-stats' }, [
      el('div', {}, [el('div', { class: 'label' }, 'Einheiten'), el('div', { class: 'value' }, `${done}/${total}`)]),
      el('div', {}, [el('div', { class: 'label' }, 'Umfang'), el('div', { class: 'value' }, `${fmtHours(doneMin / 60)}/${fmtHours(plannedMin / 60)} h`)])
    ]),
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Wochenfortschritt', 'aria-valuemin': '0', 'aria-valuemax': String(plannedMin), 'aria-valuenow': String(doneMin) },
      el('span', { style: `width:${plannedMin ? (doneMin / plannedMin) * 100 : 0}%` })),
    countdown ? el('div', { class: 'plan-countdown' }, [el('span', { 'aria-hidden': 'true', html: FLAG_ICON.replace('width="22" height="22"', 'width="16" height="16"') }), countdown]) : null,
    d.phaseText ? el('div', { class: 'plan-reason' }, d.phaseText) : null,
    !goal.date ? el('button', { class: 'link-btn', type: 'button', style: 'margin-top:10px', onclick: () => openSettings('goal') }, 'Wettkampf eintragen') : null
  ]));

  const todayKey = localKey(new Date());
  const usedDays = new Set();
  for (const s of plan.sessions) {
    usedDays.add(s.weekday);
    const dd = Number(s.day.split('-')[2]);
    const g = groupOf(s.sport);
    const isToday = s.day === todayKey;

    if (s.kind === 'race') {
      sessionsBox.appendChild(el('div', { class: `session-row${isToday ? ' today' : ''}` }, [
        el('div', { class: 'session-day' }, [el('span', { class: 'wd' }, s.weekday), el('span', { class: 'dn' }, String(dd))]),
        el('div', { class: 'session-card race' }, [
          el('div', { class: 'session-main' }, [
            el('div', { class: 'sport-icon sm', style: 'background:#3a2e12;color:#f5b544', html: FLAG_ICON }),
            el('div', { class: 'session-text' }, [el('div', { class: 'title' }, 'Wettkampf'), el('div', { class: 'desc' }, s.description)])
          ])
        ])
      ]));
      continue;
    }

    let footer = null;
    let chip = null;
    if (s.status === 'done') {
      chip = el('span', { class: 'chip outline-good' }, 'Erledigt');
      footer = el('button', { class: 'reset-btn', type: 'button', onclick: () => onSetSessionStatus(s.id, 'planned') }, 'Zurücksetzen');
    } else if (s.status === 'missed') {
      chip = el('span', { class: 'chip outline-danger' }, 'Ausgelassen');
      footer = el('button', { class: 'reset-btn', type: 'button', onclick: () => onSetSessionStatus(s.id, 'planned') }, 'Zurücksetzen');
    } else if (s.day <= todayKey) {
      footer = el('div', { class: 'session-actions' }, [
        el('button', { type: 'button', onclick: () => onSetSessionStatus(s.id, 'done') }, 'Erledigt'),
        el('button', { type: 'button', class: 'ghost', onclick: () => onSetSessionStatus(s.id, 'missed') }, 'Ausgelassen')
      ]);
    }
    if (s.status === 'planned') {
      const extra = s.adjusted
        ? el('div', { class: 'adjust-row' }, [
          el('span', { class: 'chip solid-muted' }, 'angepasst'),
          el('button', { class: 'reset-btn', type: 'button', onclick: () => onAdjustSession(s.id, 'undo') },
            `Rückgängig (${INTENSITY_LABELS[s.original && s.original.intensity] || ''} · ${s.original ? s.original.targetDurationMin : ''} min)`)
        ])
        : s.intensity && s.intensity !== 'easy' && s.sport !== 'WeightTraining'
          ? el('button', { class: 'reset-btn', type: 'button', onclick: () => onAdjustSession(s.id, 'easy', 'Manuell auf locker gesetzt') }, 'Lockerer machen')
          : null;
      footer = footer ? el('div', {}, [footer, extra]) : extra;
    }

    const w = s.workout;
    const kindTag = { long: 'lang', quality: INTENSITY_LABELS[s.intensity], brick: 'Koppel', strength: null, easy: null }[s.kind];
    sessionsBox.appendChild(el('div', { class: `session-row${isToday ? ' today' : ''}` }, [
      el('div', { class: 'session-day' }, [el('span', { class: 'wd' }, s.weekday), el('span', { class: 'dn' }, String(dd))]),
      el('div', { class: `session-card ${s.status}` }, [
        el('button', { class: 'session-main session-open', type: 'button', onclick: () => openSessionDetail(s.id), 'aria-label': `${w ? w.title : sportLabel(s.sport)} – Ablauf anzeigen` }, [
          el('span', { class: 'sport-bar', style: `background:${g.color}` }),
          el('div', { class: 'session-text' }, [
            el('div', { class: 'title' }, [w ? w.title : sportLabel(s.sport), kindTag ? el('span', { class: `kind-tag ${s.intensity}` }, kindTag) : null]),
            el('div', { class: 'desc' }, [
              `${s.targetDurationMin} min`,
              w && w.distance ? ` · ca. ${w.distance.toLocaleString('de-DE')} m` : '',
              w ? el('span', { class: 'code-inline' }, ` · ${w.code}${w.created ? ' ✓' : ''}`) : '',
              planTargetHr(s) ? el('span', { class: 'plan-hr' }, [el('span', { class: 'heart', 'aria-hidden': 'true' }, ' ♥'), ` ${planTargetHr(s)}`]) : null
            ])
          ]),
          chip || chevron()
        ]),
        footer
      ])
    ]));
  }
  const restDays = (goal.restDays || []).map((i) => WEEKDAYS_SHORT[i]);
  const notes = [];
  if (restDays.length) notes.push(`Ruhetag${restDays.length > 1 ? 'e' : ''}: ${restDays.join(', ')}`);
  if (d.partialWeek) notes.push('Plan wurde unter der Woche erstellt und gilt ab diesem Tag');
  if (notes.length) sessionsBox.appendChild(el('div', { class: 'small muted', style: 'padding:4px' }, notes.join(' · ')));
}

let openSessionId = null;
function openSessionDetail(id) {
  openSessionId = id;
  const s = (currentState.plan.sessions || []).find((x) => x.id === id);
  if (!s || !s.workout) return;
  const g = groupOf(s.sport);
  const why = [];
  if (s.kind === 'long') why.push('Lange, lockere Einheit – baut deine Grundlagenausdauer für den Wettkampf auf');
  if (s.kind === 'quality') why.push(s.intensity === 'hard' ? 'Intensiver Reiz für VO2max und Tempohärte – die Pausen locker halten' : 'Tempo-Reiz an der Schwelle – fordernd, aber kontrolliert');
  if (s.kind === 'brick') why.push('Koppeltraining: gewöhnt die Beine an den Wechsel vom Rad zum Laufen');
  if (s.kind === 'easy') why.push('Lockere Einheit – fördert die Erholung und den Fettstoffwechsel');
  if (s.kind === 'strength') why.push('Kraft beugt Verletzungen vor und verbessert die Laufökonomie');
  if (s.adjusted && s.adjustReason) why.push(s.adjustReason);
  const w = {
    sport: g.key, sportLabel: `${s.weekday}, ${new Date(s.day + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })} · ${sportLabel(s.sport)}`,
    title: s.workout.title, intensity: s.intensity, intensityLabel: INTENSITY_LABELS[s.intensity] || '',
    minutes: s.targetDurationMin, distance: s.workout.distance, steps: s.workout.steps,
    code: s.workout.code, device: s.workout.device, created: s.workout.created, why
  };
  document.getElementById('session-detail-title').textContent = s.workout.title;
  mount('session-detail-body', workoutCard(w, 'Wozu diese Einheit?'));
  const dlg = document.getElementById('session-detail-dialog');
  if (!dlg.open) dlg.showModal();
}

// Zielpuls einer Plan-Einheit (Hauptteil) – gleiche Formel wie auf dem Server (Karvonen)
function planTargetHr(session) {
  if (session.workout) return session.workout.mainHr || null;
  const a = currentState && currentState.athlete;
  if (!a || !a.maxHR || !a.restingHR || session.sport === 'WeightTraining') return null;
  const [lo, hi, pos] = { easy: [0.6, 0.7, 0.5], moderate: [0.7, 0.8, 0.6], hard: [0.8, 0.9, 0.5] }[session.intensity] || [0.6, 0.7, 0.5];
  const swimOffset = session.sport === 'Swim' ? -0.05 : 0;
  return Math.round(a.restingHR + (a.maxHR - a.restingHR) * (lo + (hi - lo) * pos + swimOffset));
}

async function onSetSessionStatus(sessionId, status) {
  try {
    const res = await fetch('/api/plan/session-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Unbekannter Fehler');
    }
    await refresh();
  } catch (err) {
    alert('Status konnte nicht gespeichert werden: ' + err.message);
  }
}

async function onRegeneratePlan() {
  const btn = document.getElementById('regenerate-plan-btn');
  btn.disabled = true;
  btn.textContent = 'Plane…';
  if (!confirm('Die restliche Woche ab heute neu verteilen? Erledigte Einheiten bleiben erhalten.')) { btn.disabled = false; btn.textContent = 'Neu planen'; return; }
  try {
    const res = await fetch('/api/plan/regenerate', { method: 'POST' });
    if (!res.ok) throw new Error('Server-Fehler');
    await refresh();
    location.hash = '#plan';
  } catch (err) {
    alert('Plan-Erstellung fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Neu planen';
  }
}

// ---------------------------------------------------------------------------
// Tab "Aktivitäten"
// ---------------------------------------------------------------------------

const activityFilter = { q: '', group: '' };
const PAGE_SIZE = 30;
let activityVisibleCount = PAGE_SIZE;

function renderSportChips() {
  const box = document.getElementById('sport-chips');
  box.innerHTML = '';
  const options = [{ key: '', label: 'Alle' }, ...SPORT_GROUPS];
  for (const g of options) {
    box.appendChild(el('button', {
      class: 'filter-chip', type: 'button',
      'aria-pressed': String(activityFilter.group === g.key),
      onclick: () => {
        activityFilter.group = g.key;
        activityVisibleCount = PAGE_SIZE;
        renderSportChips();
        renderActivities();
      }
    }, [g.color ? el('span', { class: 'dot', style: `background:${g.color}` }) : null, g.label]));
  }
}

function filteredActivities() {
  const q = activityFilter.q.trim().toLowerCase();
  return allActivities.filter((a) => {
    if (activityFilter.group && groupOf(a.type).key !== activityFilter.group) return false;
    if (!q) return true;
    const hay = `${activityTitle(a)} ${a.name || ''} ${a.rawType || ''} ${sportLabel(a.type)}`.toLowerCase();
    return hay.includes(q);
  });
}

function groupHeading(act, now) {
  const t = new Date(act.startDate);
  const thisWeek = startOfLocalWeek(now);
  if (t >= thisWeek) return 'Diese Woche';
  if (t >= addDays(thisWeek, -7)) return 'Letzte Woche';
  return t.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

function renderActivities() {
  const oldest = allActivities.length ? allActivities[allActivities.length - 1] : null;
  document.getElementById('activity-count-label').textContent = oldest
    ? `${activityTotal} Trainings seit ${new Date(oldest.startDate).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}`
    : '';

  const box = document.getElementById('activities-list');
  const more = document.getElementById('activities-loadmore');
  box.innerHTML = '';
  more.innerHTML = '';

  const list = filteredActivities();
  if (!list.length) {
    box.appendChild(el('div', { class: 'empty-state' },
      activityFilter.q || activityFilter.group ? 'Keine passenden Aktivitäten gefunden.' : 'Noch keine Aktivitäten importiert.'));
    return;
  }

  const now = new Date();
  let lastHeading = null;
  for (const act of list.slice(0, activityVisibleCount)) {
    const heading = groupHeading(act, now);
    if (heading !== lastHeading) {
      box.appendChild(el('div', { class: 'group-title' }, heading));
      lastHeading = heading;
    }
    box.appendChild(activityCard(act));
  }
  if (list.length > activityVisibleCount) {
    more.appendChild(el('button', {
      class: 'pill-btn', type: 'button',
      onclick: () => { activityVisibleCount += PAGE_SIZE; renderActivities(); }
    }, `Mehr anzeigen (${activityVisibleCount} von ${list.length})`));
  }
}

function activityCard(act) {
  const g = groupOf(act.type);
  const hasDist = act.distanceMeters > 50;
  const showDistMain = hasDist && ['run', 'bike', 'swim'].includes(g.key) && act.type !== 'VirtualRide';
  const main = showDistMain ? fmtKm(act.distanceMeters) : fmtDuration(act.movingTimeSec);
  const subParts = [];
  if (showDistMain) {
    subParts.push(fmtDuration(act.movingTimeSec));
    const pace = fmtPace(act);
    if (pace) subParts.push(pace);
  } else {
    if (hasDist) subParts.push(fmtKm(act.distanceMeters));
    if (act.averageHeartrate) subParts.push(`♥ ${Math.round(act.averageHeartrate)}`);
  }
  return el('button', { class: 'activity-card', type: 'button', onclick: () => openActivityDetail(act) }, [
    sportIcon(g, true),
    el('div', { class: 'txt' }, [
      el('div', { class: 'name' }, activityTitle(act) + (act.source === 'manual' ? ' · manuell' : '')),
      el('div', { class: 'when' }, fmtWhen(act.startDate))
    ]),
    el('div', { class: 'nums' }, [
      el('div', { class: 'main-num' }, main),
      subParts.length ? el('div', { class: 'sub-num' }, subParts.join(' · ')) : null
    ])
  ]);
}

let detailActivity = null;

function openActivityDetail(act) {
  detailActivity = act;
  document.getElementById('activity-detail-title').textContent = activityTitle(act);
  const items = [
    ['Dauer', fmtDuration(act.movingTimeSec)],
    act.distanceMeters > 50 ? ['Distanz', fmtKm(act.distanceMeters)] : null,
    fmtPace(act) ? [groupOf(act.type).key === 'bike' ? 'Ø Tempo' : 'Ø Pace', fmtPace(act)] : null,
    act.averageHeartrate ? ['Ø Herzfrequenz', `${Math.round(act.averageHeartrate)} bpm`] : null,
    act.maxHeartrate ? ['Max. Herzfrequenz', `${Math.round(act.maxHeartrate)} bpm`] : null,
    act.activeEnergyKcal ? ['Aktive Energie', `${Math.round(act.activeEnergyKcal)} kcal`] : null,
    act.elevationGainMeters ? ['Höhenmeter', `${Math.round(act.elevationGainMeters)} m`] : null
  ].filter(Boolean);
  const sourceLabel = { manual: 'manuell eingetragen', apple_health: 'Apple Health', strava: 'Strava' }[act.source] || act.source || '–';
  mount('activity-detail-body',
    el('div', { class: 'muted small', style: 'margin-bottom:14px' },
      new Date(act.startDate).toLocaleString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ` · ${sourceLabel}`),
    el('div', { class: 'detail-grid' }, items.map(([l, v]) => el('div', {}, [el('div', { class: 'label' }, l), el('div', { class: 'value' }, v)])))
  );
  document.getElementById('activity-detail-dialog').showModal();
}

async function onDeleteActivity() {
  if (!detailActivity) return;
  if (!confirm('Diese Aktivität wirklich aus der App löschen?')) return;
  try {
    const res = await fetch(`/api/activities?id=${encodeURIComponent(detailActivity.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Unbekannter Fehler');
    }
    document.getElementById('activity-detail-dialog').close();
    await refresh();
  } catch (err) {
    alert('Löschen fehlgeschlagen: ' + err.message);
  }
}

function setupActivityUi() {
  renderSportChips();
  let debounce = null;
  document.getElementById('activity-search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      activityFilter.q = e.target.value;
      activityVisibleCount = PAGE_SIZE;
      renderActivities();
    }, 200);
  });
  setupGoalForm();
  const sdDialog = document.getElementById('session-detail-dialog');
  document.getElementById('close-session-detail-btn').addEventListener('click', () => sdDialog.close());
  loadSpontanPrefs();
  const spDialog = document.getElementById('spontan-dialog');
  document.getElementById('open-spontan-btn').addEventListener('click', openSpontan);
  document.getElementById('close-spontan-btn').addEventListener('click', () => spDialog.close());
  const infoDialog = document.getElementById('info-dialog');
  document.getElementById('close-info-btn').addEventListener('click', () => infoDialog.close());
  infoDialog.addEventListener('click', (e) => { if (e.target === infoDialog) infoDialog.close(); });
  const detail = document.getElementById('activity-detail-dialog');
  document.getElementById('close-activity-detail-btn').addEventListener('click', () => detail.close());
  document.getElementById('delete-activity-btn').addEventListener('click', onDeleteActivity);

  const dialog = document.getElementById('add-activity-dialog');
  document.getElementById('open-add-activity-btn').addEventListener('click', () => {
    document.getElementById('add-activity-form').reset();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('activity-date').value = now.toISOString().slice(0, 16);
    dialog.showModal();
  });
  document.getElementById('close-add-activity-btn').addEventListener('click', () => dialog.close());
  document.getElementById('add-activity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dateVal = document.getElementById('activity-date').value;
    const payload = {
      name: document.getElementById('activity-name').value || null,
      type: document.getElementById('activity-type').value,
      startDate: dateVal ? new Date(dateVal).toISOString() : null,
      durationMin: Number(document.getElementById('activity-duration').value),
      distanceKm: numOrNull(document.getElementById('activity-distance').value),
      averageHeartrate: numOrNull(document.getElementById('activity-hr').value)
    };
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Unbekannter Fehler');
      }
      dialog.close();
      await refresh();
    } catch (err) {
      alert('Aktivität konnte nicht gespeichert werden: ' + err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Tab "Analyse"
// ---------------------------------------------------------------------------

function renderAnalysis() {
  if (!currentState) return;
  renderLoadChart(document.getElementById('load-chart'), currentState.analysis.dailyLoadSeries, 28);
  const sleep = currentState.sleepSeries || [];
  if (sleep.some((p) => p.total)) {
    renderSleepChart(document.getElementById('sleep-chart'), sleep, 7);
  } else {
    mount('sleep-chart', el('div', { class: 'muted small' }, 'Noch keine Schlafdaten. In den Einstellungen unter „Schlaf & Erholung“ steht, wie du sie verbindest.'));
  }

  const thisWeek = startOfLocalWeek(new Date());
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    const acts = activitiesInRange(start, addDays(start, 7));
    const segments = SPORT_GROUPS.map((g) => ({
      name: g.short, color: g.color,
      value: acts.filter((a) => groupOf(a.type).key === g.key).reduce((s, a) => s + (a.movingTimeSec || 0) / 3600, 0)
    }));
    weeks.push({
      label: i === 0 ? 'jetzt' : `KW${isoWeek(start)}`,
      total: segments.reduce((s, x) => s + x.value, 0),
      segments
    });
  }
  renderVolumeChart(document.getElementById('volume-chart'), weeks);
  mount('volume-legend', ...SPORT_GROUPS.map((g) => el('span', {}, [el('span', { class: 'dot', style: `background:${g.color}` }), g.label])));

  const flags = currentState.analysis.flags || [];
  const box = mount('flags');
  if (!flags.length) {
    box.appendChild(el('div', { class: 'muted small' }, 'Keine Auffälligkeiten – die Belastung sieht ausgeglichen aus.'));
  } else {
    for (const f of flags) {
      box.appendChild(el('div', { class: `flag ${f.level}` }, [el('span', { class: 'icon', 'aria-hidden': 'true' }, f.level === 'warnung' ? '!' : 'i'), f.message]));
    }
  }
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

const SYNC_STALE_DAYS = 3;

function openSettings(section) {
  document.getElementById('settings-dialog').showModal();
  if (section === 'goal') setTimeout(() => document.getElementById('goal-section').scrollIntoView({ block: 'start' }), 50);
}

// Saisonziel-Formular
let goalRestDays = [0];
function renderGoalForm() {
  const g = currentState.goal || {};
  const form = document.getElementById('goal-form');
  if (!form.contains(document.activeElement)) {
    document.getElementById('goal-name').value = g.name || '';
    document.getElementById('goal-date').value = g.date || '';
    document.getElementById('goal-distance').value = g.distance || 'olympic';
    document.getElementById('goal-hours').value = g.weeklyHours || 6;
    document.getElementById('goal-strength').value = String(g.strengthPerWeek ?? 2);
    goalRestDays = Array.isArray(g.restDays) ? [...g.restDays] : [0];
  }
  renderRestDayChips();
}

function renderRestDayChips() {
  mount('goal-restdays', ...WEEKDAYS_SHORT.map((wd, i) => el('button', {
    class: 'filter-chip', type: 'button', 'aria-pressed': String(goalRestDays.includes(i)),
    onclick: () => {
      if (goalRestDays.includes(i)) goalRestDays = goalRestDays.filter((d) => d !== i);
      else if (goalRestDays.length < 3) goalRestDays = [...goalRestDays, i];
      renderRestDayChips();
    }
  }, wd)));
}

function setupGoalForm() {
  document.getElementById('goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const goal = {
      name: document.getElementById('goal-name').value.trim(),
      date: document.getElementById('goal-date').value || null,
      distance: document.getElementById('goal-distance').value,
      weeklyHours: Number(document.getElementById('goal-hours').value) || 6,
      strengthPerWeek: Number(document.getElementById('goal-strength').value),
      restDays: goalRestDays
    };
    if (goal.date && goal.date < localKey(new Date())) {
      if (!confirm('Das Datum liegt in der Vergangenheit. Trotzdem speichern?')) return;
    }
    btn.disabled = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal })
      });
      if (!res.ok) throw new Error('Server-Fehler');
      document.activeElement && document.activeElement.blur();
      await refresh();
      btn.textContent = 'Gespeichert ✓ – Plan aktualisiert';
      setTimeout(() => { btn.textContent = 'Speichern & Woche neu planen'; }, 2000);
    } catch (err) {
      alert('Speichern fehlgeschlagen: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function renderSettings() {
  renderLibrary();
  renderGoalForm();
  const a = currentState.athlete;
  const form = document.getElementById('settings-form');
  if (!form.contains(document.activeElement)) {
    document.getElementById('setting-maxhr').value = a.maxHR || '';
    document.getElementById('setting-restinghr').value = a.restingHR || '';
    document.getElementById('setting-gender').value = a.gender || 'unspecified';
    document.getElementById('setting-cap').value = Math.round((a.weeklyIncreaseCap || 0.1) * 100);
    document.getElementById('setting-deload').value = a.deloadEveryNWeeks || 4;
    document.getElementById('setting-sessions').value = a.sessionsPerWeekDefault || 4;
  }

  renderHrHints(a);

  // Health Auto Export
  const hc = currentState.appleHealth;
  const importUrl = `${window.location.origin}/api/import/health-auto-export?token=${hc.importToken}`;
  const stale = !hc.lastImportAt || daysSince(hc.lastImportAt) > SYNC_STALE_DAYS;
  mount('health-import-status',
    el('div', { class: 'status-row' }, [
      el('span', { class: 'dot', style: `background:${!hc.lastImportAt ? 'var(--muted)' : stale ? 'var(--warning)' : 'var(--good)'}` }),
      !hc.lastImportAt ? 'Noch kein Import' : stale ? 'Import überfällig' : 'Import aktiv'
    ]),
    el('div', { class: 'muted small', style: 'margin-top:4px' },
      hc.lastImportAt ? `Letzter Import ${relativeTime(hc.lastImportAt)} · ${activityTotal} Trainings in der App` : 'Richte in Health Auto Export eine REST-API-Automation mit dieser Adresse ein:'),
    el('div', { class: 'url-box', id: 'health-import-url' }, importUrl),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'secondary-btn', type: 'button', onclick: () => copyText(importUrl) }, 'Adresse kopieren'),
      el('button', { class: 'secondary-btn', type: 'button', onclick: onRotateImportToken }, 'Neuer Token')
    ]),
    el('p', { class: 'muted small', style: 'margin-bottom:0' }, 'In Health Auto Export: Datentyp „Workouts“, Format JSON v2, Routendaten aus.')
  );

  // Schlaf & Erholung (zweite Automation)
  const hm = currentState.healthMetrics || {};
  const hmStale = !hm.lastImportAt || daysSince(hm.lastImportAt) > SYNC_STALE_DAYS;
  mount('health-metrics-status',
    el('div', { class: 'status-row' }, [
      el('span', { class: 'dot', style: `background:${!hm.lastImportAt ? 'var(--muted)' : hmStale ? 'var(--warning)' : 'var(--good)'}` }),
      !hm.lastImportAt ? 'Noch keine Schlafdaten' : hmStale ? 'Schlafdaten veraltet' : 'Schlafdaten aktiv'
    ]),
    hm.lastImportAt ? el('div', { class: 'muted small', style: 'margin-top:4px' }, `Letzte Übertragung ${relativeTime(hm.lastImportAt)}`) : null,
    el('p', { class: 'small', style: 'color:var(--text-2);line-height:1.45;margin-bottom:0' }, 'Lege in Health Auto Export eine zweite REST-API-Automation mit derselben Adresse wie oben an: Datentyp „Gesundheitsmetriken“, darin nur „Schlafanalyse“, „Herzfrequenzvariabilität“ und „Ruhepuls“ auswählen, Schlafdaten zusammenfassen, Format JSON v2, Datumsbereich „Seit dem letzten Sync“.')
  );

  // Strava
  const st = currentState.strava;
  if (st.connected) {
    mount('strava-status',
      el('div', { class: 'status-row' }, [el('span', { class: 'dot', style: 'background:var(--good)' }), 'Verbunden']),
      el('div', { class: 'muted small', style: 'margin:4px 0 12px' },
        `Letzter Sync: ${st.lastSyncAt ? relativeTime(st.lastSyncAt) : 'noch nie'}${st.webhookActive ? ' · Auto-Import aktiv' : ''}`),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'secondary-btn', type: 'button', onclick: onSyncClick }, 'Jetzt synchronisieren'),
        st.webhookActive ? null : el('button', { class: 'secondary-btn', type: 'button', onclick: onSetupWebhook }, 'Auto-Import einrichten')
      ])
    );
  } else {
    mount('strava-status',
      el('div', { class: 'muted small', style: 'margin-bottom:12px' }, 'Nicht verbunden. Nur nötig, wenn du Daten direkt aus Strava holen willst (kostenpflichtige API).'),
      el('a', { class: 'secondary-btn', href: '/auth/strava', style: 'display:flex;align-items:center;justify-content:center;text-decoration:none' }, 'Mit Strava verbinden')
    );
  }
}

function renderHrHints(a) {
  const manual = (src) => src === 'manual';
  mount('maxhr-hint', manual(a.maxHRSource)
    ? el('span', {}, ['Von dir eingetragen · ', el('button', { class: 'link-btn', type: 'button', onclick: () => resetHrAuto('maxHR') }, 'wieder automatisch')])
    : el('span', {}, 'Automatisch: höchster Wert aus deinen Trainings, der von mindestens einem zweiten Training bestätigt wird – einzelne Messfehler zählen nicht.'));
  const upd = a.restingHRUpdatedAt ? ` · zuletzt ${new Date(a.restingHRUpdatedAt).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}` : '';
  mount('restinghr-hint', manual(a.restingHRSource)
    ? el('span', {}, ['Von dir eingetragen · ', el('button', { class: 'link-btn', type: 'button', onclick: () => resetHrAuto('restingHR') }, 'wieder automatisch')])
    : el('span', {}, `Automatisch: Ø der letzten 14 Tage von deiner Watch, wöchentlich aktualisiert${upd}.`));
}

async function resetHrAuto(key) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key + 'Auto']: true })
    });
    if (!res.ok) throw new Error('Server-Fehler');
    await refresh();
  } catch (err) {
    alert('Zurücksetzen fehlgeschlagen: ' + err.message);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert('Adresse kopiert.');
  } catch (err) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('health-import-url'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    alert('Bitte die markierte Adresse manuell kopieren.');
  }
}

async function onRotateImportToken() {
  if (!confirm('Neuen Token erzeugen? Die Automation in Health Auto Export funktioniert danach erst wieder, wenn du dort die neue Adresse einträgst.')) return;
  await fetch('/api/import/health/rotate-token', { method: 'POST' });
  await refresh();
}

async function onSyncClick(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Synchronisiere…';
  try {
    await fetch('/api/sync', { method: 'POST' });
    await refresh();
  } catch (err) {
    alert('Sync fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onSetupWebhook() {
  try {
    const res = await fetch('/api/webhook/setup', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Unbekannter Fehler');
    alert('Auto-Import eingerichtet – neue Strava-Uploads werden jetzt automatisch übernommen.');
    await refresh();
  } catch (err) {
    alert('Einrichtung fehlgeschlagen: ' + err.message);
  }
}

function setupSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  document.getElementById('open-settings-btn').addEventListener('click', openSettings);
  document.getElementById('close-settings-btn').addEventListener('click', () => dialog.close());
  document.getElementById('dedupe-btn').addEventListener('click', onCheckDuplicates);
  document.getElementById('export-backup-btn').addEventListener('click', () => {
    window.location.href = '/api/backup';
  });
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const payload = {
      maxHR: numOrNull(document.getElementById('setting-maxhr').value),
      restingHR: numOrNull(document.getElementById('setting-restinghr').value),
      gender: document.getElementById('setting-gender').value,
      weeklyIncreaseCap: Number(document.getElementById('setting-cap').value) / 100,
      deloadEveryNWeeks: Number(document.getElementById('setting-deload').value),
      sessionsPerWeekDefault: Number(document.getElementById('setting-sessions').value)
    };
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Server-Fehler');
      document.activeElement && document.activeElement.blur();
      await refresh();
      if (btn) {
        btn.textContent = 'Gespeichert ✓';
        setTimeout(() => { btn.textContent = 'Speichern'; }, 1500);
      }
    } catch (err) {
      alert('Speichern fehlgeschlagen: ' + err.message);
    }
  });
}

async function onCheckDuplicates() {
  const box = document.getElementById('dedupe-result');
  box.innerHTML = '';
  let data;
  try {
    data = await fetchJson('/api/activities/duplicates', 'Prüfung fehlgeschlagen');
  } catch (err) {
    alert(err.message);
    return;
  }
  if (!data.count) {
    box.appendChild(el('p', { class: 'muted small', style: 'margin-bottom:0' }, 'Keine doppelten Einträge gefunden.'));
    return;
  }
  const doubles = data.items.filter((i) => i.reason === 'doppelt').length;
  const short = data.count - doubles;
  const summary = [doubles ? `${doubles} doppelt` : null, short ? `${short} unter 1 Minute` : null].filter(Boolean).join(', ');
  const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin:12px 0' },
    data.items.slice(0, 50).map((i) => el('div', { class: 'small', style: 'display:flex;justify-content:space-between;gap:8px' }, [
      el('span', {}, `${activityTitle(i.activity)} · ${fmtWhen(i.activity.startDate)}`),
      el('span', { class: 'muted' }, i.reason === 'doppelt' ? fmtDuration(i.activity.movingTimeSec) : 'zu kurz')
    ])));
  box.appendChild(el('p', { class: 'small', style: 'margin-bottom:0' }, `${data.count} ${data.count === 1 ? 'Eintrag' : 'Einträge'} gefunden (${summary}). Vom jeweiligen Doppel bleibt der Eintrag mit den vollständigeren Daten erhalten.`));
  box.appendChild(list);
  if (data.count > 50) box.appendChild(el('p', { class: 'muted small' }, `… und ${data.count - 50} weitere`));
  box.appendChild(el('button', {
    class: 'primary-btn', type: 'button',
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const res = await fetch('/api/activities/dedupe', { method: 'POST' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Unbekannter Fehler');
        box.innerHTML = '';
        box.appendChild(el('p', { class: 'small', style: 'margin-bottom:0;color:var(--good)' }, `${body.removed} ${body.removed === 1 ? 'Eintrag' : 'Einträge'} entfernt ✓`));
        await refresh();
      } catch (err) {
        alert('Bereinigung fehlgeschlagen: ' + err.message);
      }
    }
  }, `${data.count === 1 ? 'Eintrag' : data.count + ' Einträge'} entfernen`));
}

function numOrNull(v) {
  const n = Number(v);
  return v === '' || Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const VIEWS = ['heute', 'plan', 'aktivitaeten', 'analyse'];
let activeView = 'heute';

function showView() {
  const wanted = location.hash.replace('#', '');
  const view = VIEWS.includes(wanted) ? wanted : 'heute';
  const changed = view !== activeView;
  activeView = view;
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).hidden = v !== view;
  }
  document.querySelectorAll('.tabbar a').forEach((a) => {
    if (a.dataset.tab === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (changed) window.scrollTo(0, 0);
  if (view === 'analyse') renderAnalysis();
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('strava_connected')) history.replaceState({}, '', '/');
  if (params.get('strava_error')) {
    alert('Strava-Verbindung fehlgeschlagen: ' + params.get('strava_error'));
    history.replaceState({}, '', '/');
  }
}

function showLoadError(err) {
  const root = document.getElementById('app-root');
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'error-state' }, [
    el('h2', { style: 'font-family:var(--font-num);font-size:26px;margin:0 0 8px' }, 'Daten konnten nicht geladen werden'),
    el('p', { class: 'muted' }, `${err.message}. Wenn die App länger nicht genutzt wurde, kann der Server ein paar Sekunden zum Aufwachen brauchen.`),
    el('button', { class: 'primary-btn', type: 'button', onclick: () => location.reload() }, 'Erneut versuchen')
  ]));
}

document.addEventListener('DOMContentLoaded', async () => {
  checkUrlParams();
  setupSettingsDialog();
  setupActivityUi();
  document.getElementById('regenerate-plan-btn').addEventListener('click', onRegeneratePlan);
  window.addEventListener('hashchange', showView);
  showView();

  setupLogin();
  try {
    const st = await nativeFetch('/api/auth-status').then((r) => r.json());
    authEnabled = !!st.enabled;
    document.getElementById('logout-row').hidden = !authEnabled;
    if (!st.authenticated) {
      showLogin();
    } else {
      await refresh();
    }
  } catch (err) {
    if (!(err instanceof AuthError)) showLoadError(err);
  }

  // Beim Zurückkehren in die App (z.B. nach einem Training) Daten auffrischen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentState && Date.now() - lastRefreshAt > 60000) {
      refresh().catch(() => {});
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
