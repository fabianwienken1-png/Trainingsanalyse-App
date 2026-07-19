// Kapselt die komplette Strava-API-Anbindung: OAuth-Connect-Flow,
// Token-Refresh, Aktivitäten abrufen und Webhook-Subscription verwalten.
// Nutzt ausschließlich das in Node 18+ eingebaute `fetch` - keine Abhängigkeiten.

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Umgebungsvariable ${name} fehlt. Bitte .env prüfen (siehe .env.example).`
    );
  }
  return val;
}

function getAuthUrl(redirectUri, state) {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: state || ''
  });
  return `${STRAVA_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET');
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava Token-Exchange fehlgeschlagen (${res.status}): ${text}`);
  }
  return res.json(); // { access_token, refresh_token, expires_at, athlete: {...} }
}

async function refreshAccessToken(refreshToken) {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET');
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava Token-Refresh fehlgeschlagen (${res.status}): ${text}`);
  }
  return res.json(); // { access_token, refresh_token, expires_at }
}

// Stellt sicher, dass store.strava.accessToken gültig ist (Refresh falls nötig).
// Mutiert das übergebene store-Objekt und gibt den gültigen Access Token zurück.
async function ensureValidToken(store, saveFn) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!store.strava.refreshToken) {
    throw new Error('Strava ist nicht verbunden.');
  }
  if (store.strava.accessToken && store.strava.expiresAt - nowSec > 120) {
    return store.strava.accessToken; // noch mind. 2 Minuten gültig
  }
  const refreshed = await refreshAccessToken(store.strava.refreshToken);
  store.strava.accessToken = refreshed.access_token;
  store.strava.refreshToken = refreshed.refresh_token;
  store.strava.expiresAt = refreshed.expires_at;
  if (saveFn) saveFn(store);
  return store.strava.accessToken;
}

async function apiGet(store, saveFn, pathname, query) {
  const token = await ensureValidToken(store, saveFn);
  const url = new URL(STRAVA_API_BASE + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API Fehler ${pathname} (${res.status}): ${text}`);
  }
  return res.json();
}

async function fetchActivitiesSince(store, saveFn, afterEpochSeconds) {
  let page = 1;
  const perPage = 100;
  const all = [];
  // Strava paginiert; wir holen so lange weiter, bis eine Seite leer ist.
  // Sicherheitslimit von 10 Seiten (=1000 Aktivitäten) pro Sync-Lauf.
  while (page <= 10) {
    const batch = await apiGet(store, saveFn, '/athlete/activities', {
      after: afterEpochSeconds,
      per_page: perPage,
      page
    });
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

async function fetchActivityDetail(store, saveFn, activityId) {
  return apiGet(store, saveFn, `/activities/${activityId}`);
}

// Wandelt eine Strava-Activity (Summary oder Detail) in unser internes,
// schlankes Format um. Wir behalten nur, was die Analyse-Engine braucht.
function normalizeActivity(raw) {
  return {
    id: `strava_${raw.id}`,
    stravaId: raw.id,
    source: 'strava',
    name: raw.name || raw.type,
    type: raw.type || raw.sport_type || 'Workout', // z.B. Run, Ride, Swim, WeightTraining
    startDate: raw.start_date_local || raw.start_date, // ISO-String
    movingTimeSec: raw.moving_time || 0,
    elapsedTimeSec: raw.elapsed_time || 0,
    distanceMeters: raw.distance || 0,
    elevationGainMeters: raw.total_elevation_gain || 0,
    averageHeartrate: raw.average_heartrate || null,
    maxHeartrate: raw.max_heartrate || null,
    averageWatts: raw.average_watts || null,
    sufferScore: raw.suffer_score || null, // Stravas eigener Relative-Effort-Wert (falls verfügbar)
    averageSpeedMs: raw.average_speed || null
  };
}

async function createWebhookSubscription(callbackUrl, verifyToken) {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET');
  const res = await fetch(`${STRAVA_API_BASE}/push_subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: verifyToken
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Webhook-Subscription fehlgeschlagen (${res.status}): ${JSON.stringify(body)}`);
  }
  return body; // { id }
}

async function listWebhookSubscriptions() {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET');
  const url = new URL(`${STRAVA_API_BASE}/push_subscriptions`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Konnte Webhook-Subscriptions nicht abrufen (${res.status})`);
  return res.json();
}

async function deleteWebhookSubscription(subscriptionId) {
  const clientId = requireEnv('STRAVA_CLIENT_ID');
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET');
  const url = new URL(`${STRAVA_API_BASE}/push_subscriptions/${subscriptionId}`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('client_secret', clientSecret);
  const res = await fetch(url, { method: 'DELETE' });
  return res.ok;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  ensureValidToken,
  fetchActivitiesSince,
  fetchActivityDetail,
  normalizeActivity,
  createWebhookSubscription,
  listWebhookSubscriptions,
  deleteWebhookSubscription
};
