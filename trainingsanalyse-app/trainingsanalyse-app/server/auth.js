// Einfacher Passwortschutz für die App (Single-User).
//
// Aktiv, sobald die Umgebungsvariable APP_PASSWORD gesetzt ist (bei Render unter
// "Environment"). Ohne sie bleibt die App wie bisher offen – so sperrt man sich
// beim Deployen nicht versehentlich aus.
//
// Nach dem Login bekommt der Browser ein Cookie (1 Jahr gültig, HttpOnly,
// SameSite=Lax). Der Cookie-Wert ist ein HMAC des Passworts – ändert man das
// Passwort bei Render, sind alle alten Anmeldungen automatisch ungültig.
//
// Öffentlich bleiben nur: der Login selbst, die Import-Endpunkte für Health Auto
// Export (eigener Token in der URL), der Keep-alive-Endpunkt /api/health, die
// Strava-Callbacks und die statischen Dateien der App-Hülle (enthalten keine Daten).

const crypto = require('crypto');

const COOKIE_NAME = 'ta_session';
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

const PUBLIC_API = new Set([
  '/api/login',
  '/api/logout',
  '/api/auth-status',
  '/api/health',
  '/api/import/health',
  '/api/import/health-auto-export'
]);

function password() {
  return process.env.APP_PASSWORD || '';
}

function enabled() {
  return password().length > 0;
}

function sessionValue() {
  return crypto.createHmac('sha256', password()).update('trainingsanalyse-session-v1').digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function isAuthenticated(req) {
  if (!enabled()) return true;
  const value = readCookie(req, COOKIE_NAME);
  return !!value && safeEqual(value, sessionValue());
}

// Muss die Route angemeldet sein?
function requiresAuth(pathname) {
  if (!enabled()) return false;
  if (PUBLIC_API.has(pathname)) return false;
  if (pathname.startsWith('/webhook')) return false; // Strava-Webhook (hat eigene Prüfung)
  if (pathname === '/auth/strava/callback') return false;
  return pathname.startsWith('/api/') || pathname.startsWith('/auth/');
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
}

function sessionCookie(req) {
  return `${COOKIE_NAME}=${sessionValue()}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
}

function clearCookie(req) {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
}

// Schutz gegen Durchprobieren: max. 10 Fehlversuche pro 15 Minuten und IP
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim();
}

function isBlocked(req) {
  const entry = failures.get(clientIp(req));
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(clientIp(req));
    return false;
  }
  return entry.count >= MAX_FAILS;
}

function recordFailure(req) {
  const ip = clientIp(req);
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else entry.count++;
}

function checkPassword(candidate) {
  return enabled() && safeEqual(candidate || '', password());
}

module.exports = {
  enabled,
  isAuthenticated,
  requiresAuth,
  sessionCookie,
  clearCookie,
  isBlocked,
  recordFailure,
  checkPassword,
  clientIp
};
