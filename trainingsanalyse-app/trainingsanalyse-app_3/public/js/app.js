// Hauptlogik der Trainingsanalyse-App (vanilla JS, keine Frameworks/Build-Step -
// dadurch läuft die App als einfache PWA ohne Build-Pipeline).

const SPORT_LABELS = {
  Run: 'Laufen',
  TrailRun: 'Trail-Laufen',
  Ride: 'Radfahren',
  VirtualRide: 'Rad (virtuell)',
  Swim: 'Schwimmen',
  WeightTraining: 'Krafttraining',
  Walk: 'Gehen',
  Hike: 'Wandern',
  Yoga: 'Yoga',
  Workout: 'Workout'
};

const SPORT_COLOR_VARS = {
  Run: '--series-1',
  TrailRun: '--series-7',
  Ride: '--series-2',
  VirtualRide: '--series-2',
  Swim: '--series-5',
  WeightTraining: '--series-6',
  Walk: '--series-3',
  Hike: '--series-4',
  Yoga: '--series-3',
  Workout: '--series-8'
};

function sportLabel(sport) {
  return SPORT_LABELS[sport] || sport;
}
function sportColorVar(sport) {
  return SPORT_COLOR_VARS[sport] || '--series-8';
}

function riskToClass(riskLevel) {
  if (!riskLevel) return 'muted';
  if (riskLevel.startsWith('hoch')) return 'critical';
  if (riskLevel.startsWith('erhöht')) return 'serious';
  if (riskLevel.startsWith('optimal')) return 'good';
  if (riskLevel.startsWith('niedrig')) return 'warning';
  return 'muted';
}

async function fetchState() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('Konnte Status nicht laden');
  return res.json();
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function renderStravaStatus(state) {
  const box = document.getElementById('strava-status');
  box.innerHTML = '';
  if (state.strava.connected) {
    const lastSync = state.strava.lastSyncAt
      ? new Date(state.strava.lastSyncAt).toLocaleString('de-DE')
      : 'noch nie';
    box.appendChild(
      el('div', { class: 'strava-status' }, [
        el('div', {}, [
          el('span', { class: 'badge status-good' }, [el('span', { class: 'dot' }), 'Strava verbunden']),
          el('div', { class: 'muted', style: 'margin-top:6px' }, `Letzter Sync: ${lastSync}${state.strava.webhookActive ? ' · Auto-Import aktiv' : ''}`)
        ]),
        el('button', { class: 'small', onclick: onSyncClick }, 'Jetzt synchronisieren')
      ])
    );
    if (!state.strava.webhookActive) {
      box.appendChild(
        el('div', { class: 'muted', style: 'margin-top:10px' }, [
          'Automatischer Import bei neuem Strava-Upload ist noch nicht aktiv. ',
          el('a', { href: '#', onclick: onSetupWebhook }, 'Jetzt einrichten')
        ])
      );
    }
  } else {
    box.appendChild(
      el('div', { class: 'strava-status' }, [
        el('div', { class: 'muted' }, 'Noch nicht mit Strava verbunden.'),
        el('a', { class: 'btn primary', href: '/auth/strava' }, 'Mit Strava verbinden')
      ])
    );
  }
}

function renderHealthImportStatus(state) {
  const box = document.getElementById('health-import-status');
  box.innerHTML = '';
  const hc = state.appleHealth;
  const importUrl = `${window.location.origin}/api/import/health?token=${hc.importToken}`;

  const lastImport = hc.lastImportAt
    ? new Date(hc.lastImportAt).toLocaleString('de-DE')
    : 'noch kein Import';

  box.appendChild(
    el('div', {}, [
      el('span', { class: `badge ${hc.lastImportAt ? 'status-good' : 'status-muted'}` }, [
        el('span', { class: 'dot' }),
        hc.importCount > 0 ? `${hc.importCount} Trainings importiert` : 'Noch keine Kurzbefehl-Verbindung'
      ]),
      el('div', { class: 'muted', style: 'margin-top:6px' }, `Letzter Import: ${lastImport}`)
    ])
  );

  box.appendChild(
    el('div', { class: 'form-row', style: 'margin-top:14px' }, [
      el('label', {}, 'Deine persönliche Import-Adresse (im Kurzbefehl verwenden)'),
      el('input', { id: 'health-import-url', type: 'text', readonly: 'true', value: importUrl, onclick: (e) => e.target.select() })
    ])
  );

  box.appendChild(
    el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap;' }, [
      el('button', { class: 'small', onclick: onCopyImportUrl }, 'URL kopieren'),
      el('button', { class: 'small', onclick: onRotateImportToken }, 'Token neu generieren')
    ])
  );
}

async function onCopyImportUrl() {
  const input = document.getElementById('health-import-url');
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    alert('Import-Adresse kopiert.');
  } catch (err) {
    alert('Konnte nicht automatisch kopieren – bitte manuell markieren und kopieren.');
  }
}

async function onRotateImportToken() {
  if (!confirm('Neuen Token erzeugen? Der alte Kurzbefehl funktioniert danach nicht mehr, bis du die URL dort aktualisierst.')) return;
  await fetch('/api/import/health/rotate-token', { method: 'POST' });
  await refresh();
}

function renderStats(state) {
  const grid = document.getElementById('stat-grid');
  grid.innerHTML = '';
  const a = state.analysis;

  const acwrClass = riskToClass(a.acwr.riskLevel);
  grid.appendChild(
    el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label' }, 'Wochenlast (7 Tage)'),
      el('div', { class: 'value' }, Math.round(a.acwr.acute7).toString()),
      el('div', { class: `delta ${a.trend === 'steigend' ? 'up' : 'down'}` }, `Trend: ${a.trend}`)
    ])
  );
  grid.appendChild(
    el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label' }, 'ACWR · Belastungsverhältnis'),
      el('div', { class: 'value' }, a.acwr.acwr !== null ? a.acwr.acwr.toFixed(2) : '–'),
      el('span', { class: `badge status-${acwrClass}`, style: 'margin-top:6px' }, [
        el('span', { class: 'dot' }),
        a.acwr.riskLevel
      ]),
      el('div', { class: `meter ${acwrClass}` }, [
        el('div', {
          class: 'fill',
          style: `width:${Math.min(100, ((a.acwr.acwr || 0) / 2) * 100)}%`
        })
      ])
    ])
  );
  grid.appendChild(
    el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label' }, 'Diese Woche'),
      el('div', { class: 'value' }, `${a.thisWeek.sessionCount}`),
      el('div', { class: 'delta' }, `Einheiten · ${Math.round(a.thisWeek.totalDurationMin)} Min`)
    ])
  );
  grid.appendChild(
    el('div', { class: 'stat-tile' }, [
      el('div', { class: 'label' }, 'Monotonie / Strain'),
      el('div', { class: 'value' }, a.monotonyStrain.monotony.toFixed(1)),
      el('div', { class: 'delta' }, `Strain: ${Math.round(a.monotonyStrain.strain)}`)
    ])
  );
}

function renderFlags(state) {
  const box = document.getElementById('flags');
  box.innerHTML = '';
  const flags = state.analysis.flags;
  if (!flags.length) {
    box.appendChild(el('div', { class: 'muted' }, 'Keine besonderen Auffälligkeiten – Belastung sieht ausgeglichen aus.'));
    return;
  }
  for (const f of flags) {
    box.appendChild(el('div', { class: `flag ${f.level}` }, [el('span', { class: 'icon' }, f.level === 'warnung' ? '!' : 'i'), f.message]));
  }
}

function renderChart(state) {
  const container = document.getElementById('load-chart');
  renderLoadChart(container, state.analysis.dailyLoadSeries, 28);
}

function renderPlan(state) {
  const box = document.getElementById('plan-sessions');
  const reasonBox = document.getElementById('plan-reason');
  box.innerHTML = '';
  reasonBox.innerHTML = '';

  const plan = state.plan;
  if (!plan.sessions || plan.sessions.length === 0) {
    box.appendChild(
      el('div', { class: 'empty-state' }, [
        'Noch kein Plan vorhanden.',
        el('div', { style: 'margin-top:10px' }, [
          el('button', { class: 'primary', onclick: onRegeneratePlan }, 'Plan jetzt erstellen')
        ])
      ])
    );
    return;
  }

  if (plan.lastDecision) {
    const d = plan.lastDecision;
    reasonBox.appendChild(
      el('div', { class: 'plan-reason' }, [
        el('strong', {}, `Woche ${plan.weekIndex}${d.isDeload ? ' · Deload-Woche' : ''}: `),
        d.reason
      ])
    );
  }

  document.getElementById('plan-week-label').textContent = plan.currentWeekStart
    ? `Woche ab ${new Date(plan.currentWeekStart).toLocaleDateString('de-DE')}`
    : '';

  for (const s of plan.sessions) {
    const d = new Date(s.day + 'T00:00:00');
    box.appendChild(
      el('div', { class: `session status-${s.status}` }, [
        el('div', { class: 'day-badge' }, [
          s.weekday,
          el('strong', {}, d.getDate().toString().padStart(2, '0'))
        ]),
        el('span', { class: 'sport-dot', style: `background:var(${sportColorVar(s.sport)})` }),
        el('div', { class: 'info' }, [
          el('div', { class: 'title' }, sportLabel(s.sport)),
          el('div', { class: 'desc' }, s.description)
        ]),
        el('div', { class: 'meta' }, [`${s.targetDurationMin} Min`, el('div', {}, `~${Math.round(s.targetLoad)} Pkt.`)])
      ])
    );
  }
}

function renderActivities(state) {
  const box = document.getElementById('activities-table');
  box.innerHTML = '';
  if (!state.recentActivities.length) {
    box.appendChild(el('div', { class: 'empty-state' }, 'Noch keine Aktivitäten importiert.'));
    return;
  }
  const table = el('table', { class: 'data-table' });
  const thead = el('tr', {}, [
    el('th', {}, 'Datum'),
    el('th', {}, 'Sportart'),
    el('th', {}, 'Dauer'),
    el('th', {}, 'Distanz'),
    el('th', {}, 'Ø HF'),
    el('th', {}, '')
  ]);
  table.appendChild(el('thead', {}, thead));
  const tbody = el('tbody');
  for (const act of state.recentActivities.slice(0, 10)) {
    const dateStr = new Date(act.startDate).toLocaleDateString('de-DE');
    const durationMin = Math.round(act.movingTimeSec / 60);
    const km = (act.distanceMeters / 1000).toFixed(1);
    tbody.appendChild(
      el('tr', {}, [
        el('td', {}, dateStr),
        el('td', {}, sportLabel(act.type)),
        el('td', {}, `${durationMin} Min`),
        el('td', {}, act.distanceMeters ? `${km} km` : '–'),
        el('td', {}, act.averageHeartrate ? `${Math.round(act.averageHeartrate)}` : '–'),
        el('td', {}, [
          el('button', { class: 'small danger', onclick: () => onDeleteActivity(act.id) }, '✕')
        ])
      ])
    );
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

async function onDeleteActivity(id) {
  if (!confirm('Diese Aktivität wirklich aus der App löschen? (Wird beim nächsten Health-Sync nicht automatisch neu angelegt, außer du löschst sie auch dort erneut und syncst nochmal.)')) return;
  try {
    const res = await fetch(`/api/activities?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Unbekannter Fehler');
    }
    await refresh();
  } catch (err) {
    alert('Löschen fehlgeschlagen: ' + err.message);
  }
}

function renderSettingsForm(state) {
  const a = state.athlete;
  document.getElementById('setting-maxhr').value = a.maxHR || '';
  document.getElementById('setting-restinghr').value = a.restingHR || '';
  document.getElementById('setting-gender').value = a.gender || 'unspecified';
  document.getElementById('setting-cap').value = Math.round((a.weeklyIncreaseCap || 0.1) * 100);
  document.getElementById('setting-deload').value = a.deloadEveryNWeeks || 4;
  document.getElementById('setting-sessions').value = a.sessionsPerWeekDefault || 4;
}

let currentState = null;

async function refresh() {
  currentState = await fetchState();
  renderHealthImportStatus(currentState);
  renderStravaStatus(currentState);
  renderStats(currentState);
  renderFlags(currentState);
  renderChart(currentState);
  renderPlan(currentState);
  renderActivities(currentState);
  renderSettingsForm(currentState);
}

async function onSyncClick() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Synchronisiere...';
  try {
    await fetch('/api/sync', { method: 'POST' });
    await refresh();
  } catch (err) {
    alert('Sync fehlgeschlagen: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onSetupWebhook(e) {
  e.preventDefault();
  try {
    const res = await fetch('/api/webhook/setup', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Unbekannter Fehler');
    alert('Webhook eingerichtet – neue Strava-Uploads werden jetzt automatisch importiert.');
    await refresh();
  } catch (err) {
    alert('Webhook-Setup fehlgeschlagen: ' + err.message + '\n\nHinweis: dafür muss die App bereits über eine öffentliche HTTPS-URL erreichbar sein (siehe README).');
  }
}

async function onRegeneratePlan() {
  const btn = document.getElementById('regenerate-plan-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Erstelle Plan...';
  }
  try {
    await fetch('/api/plan/regenerate', { method: 'POST' });
    await refresh();
  } catch (err) {
    alert('Plan-Erstellung fehlgeschlagen: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Neue Woche planen';
    }
  }
}

function setupSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  document.getElementById('open-settings-btn').addEventListener('click', () => dialog.showModal());
  document.getElementById('close-settings-btn').addEventListener('click', () => dialog.close());
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      maxHR: numOrNull(document.getElementById('setting-maxhr').value),
      restingHR: numOrNull(document.getElementById('setting-restinghr').value),
      gender: document.getElementById('setting-gender').value,
      weeklyIncreaseCap: Number(document.getElementById('setting-cap').value) / 100,
      deloadEveryNWeeks: Number(document.getElementById('setting-deload').value),
      sessionsPerWeekDefault: Number(document.getElementById('setting-sessions').value)
    };
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    dialog.close();
    await refresh();
  });
}

function numOrNull(v) {
  const n = Number(v);
  return v === '' || Number.isNaN(n) ? null : n;
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('strava_connected')) {
    history.replaceState({}, '', '/');
  }
  if (params.get('strava_error')) {
    alert('Strava-Verbindung fehlgeschlagen: ' + params.get('strava_error'));
    history.replaceState({}, '', '/');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  checkUrlParams();
  setupSettingsDialog();
  document.getElementById('regenerate-plan-btn').addEventListener('click', onRegeneratePlan);
  try {
    await refresh();
  } catch (err) {
    document.getElementById('app-root').innerHTML = `<div class="empty-state">Fehler beim Laden: ${err.message}</div>`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
