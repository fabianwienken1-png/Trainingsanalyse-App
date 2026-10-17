// Automatisches Backup: einmal pro Woche eine JSON-Kopie aller Daten in ein
// privates GitHub-Repository (Ordner backups/).
//
// Aktiv, sobald bei Render zwei Umgebungsvariablen gesetzt sind:
//   GITHUB_BACKUP_REPO  = "benutzer/repo-name" (privates Repo)
//   GITHUB_BACKUP_TOKEN = Fine-grained Token mit "Contents: Read and write" nur für dieses Repo
// Ausgelöst wird es nebenbei bei normalen Aufrufen (Keep-alive-Ping, App öffnen),
// also ohne eigenen Zeitplan-Dienst.

const https = require('https');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;
let running = false;
let lastAttempt = 0;

function enabled() {
  return !!(process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO);
}

// Ohne Zugangsdaten/Geheimnisse (gleiche Regeln wie der manuelle Export)
function exportData(s) {
  const data = JSON.parse(JSON.stringify(s));
  if (data.strava) { data.strava.accessToken = null; data.strava.refreshToken = null; }
  if (data.appleHealth) data.appleHealth.importToken = null;
  if (data.push) { data.push.vapid = null; data.push.subscriptions = []; }
  return data;
}

function github(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_BACKUP_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trainingsanalyse-backup',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 20000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung bei GitHub')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function upload(s) {
  const repo = process.env.GITHUB_BACKUP_REPO.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  const date = new Date().toISOString().slice(0, 10);
  const path = `backups/trainingsanalyse-${date}.json`;
  const content = Buffer.from(JSON.stringify(exportData(s))).toString('base64');
  const existing = await github('GET', `/repos/${repo}/contents/${path}`);
  const body = { message: `Backup ${date}`, content };
  if (existing.status === 200 && existing.json && existing.json.sha) body.sha = existing.json.sha;
  const res = await github('PUT', `/repos/${repo}/contents/${path}`, body);
  if (res.status !== 200 && res.status !== 201) {
    const msg = (res.json && res.json.message) || `HTTP ${res.status}`;
    throw new Error(res.status === 404 ? `Repo nicht gefunden oder kein Zugriff (${msg})` : res.status === 401 ? 'Token ungültig' : msg);
  }
  return { path, repo };
}

// Führt das Backup aus, wenn es fällig ist (oder force). Speichert Status im Store.
async function maybeBackup({ loadStore, saveStore, withWriteLock, force = false }) {
  if (!enabled() || running) return null;
  if (!force && Date.now() - lastAttempt < 10 * 60 * 1000) return null;
  const s0 = await loadStore();
  const info = s0.backup || {};
  const due = force || !info.lastAt || Date.now() - new Date(info.lastAt).getTime() > WEEK_MS;
  const retryOk = force || !info.lastErrorAt || Date.now() - new Date(info.lastErrorAt).getTime() > RETRY_MS;
  if (!due || !retryOk) return null;
  running = true;
  lastAttempt = Date.now();
  let result;
  try {
    const r = await upload(s0);
    result = { lastAt: new Date().toISOString(), lastPath: r.path, repo: r.repo, lastError: null, lastErrorAt: null };
    console.log(`[backup] gespeichert: ${r.repo}/${r.path}`);
  } catch (err) {
    result = Object.assign({}, info, { lastError: err.message, lastErrorAt: new Date().toISOString() });
    console.log('[backup] fehlgeschlagen:', err.message);
  } finally {
    running = false;
  }
  await withWriteLock(async () => {
    const s = await loadStore();
    s.backup = result;
    await saveStore(s);
  });
  return result;
}

function status(s) {
  const b = s.backup || {};
  return {
    enabled: enabled(),
    repo: enabled() ? process.env.GITHUB_BACKUP_REPO : null,
    lastAt: b.lastAt || null,
    lastPath: b.lastPath || null,
    lastError: b.lastError || null
  };
}

module.exports = { enabled, maybeBackup, status, exportData };
