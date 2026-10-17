// Morgen-Erinnerung per Web Push (funktioniert auf dem iPhone in der zum
// Home-Bildschirm hinzugefügten App, iOS 16.4+).
//
// Ohne zusätzliche Bibliothek: Wir senden bewusst eine Push-Nachricht OHNE
// Inhalt (dafür ist keine Verschlüsselung nötig). Der Service Worker holt sich
// beim Empfang den aktuellen Text selbst von /api/push/today.
// Die VAPID-Schlüssel (Absender-Kennung) werden einmalig erzeugt und im Store
// gespeichert.

const crypto = require('crypto');
const https = require('https');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function ensureVapid(store) {
  store.push = store.push || {};
  if (store.push.vapid && store.push.vapid.publicKey && store.push.vapid.privateJwk) return false;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), fromB64url(pubJwk.x), fromB64url(pubJwk.y)]);
  store.push.vapid = { publicKey: b64url(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
  return true;
}

function settings(store) {
  const p = store.push || {};
  return {
    enabled: p.enabled !== false,
    time: /^\d{2}:\d{2}$/.test(p.time || '') ? p.time : '07:00',
    subscriptions: (p.subscriptions || []).length,
    lastSentDay: p.lastSentDay || null
  };
}

function vapidJwt(store, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const unsigned = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: store.push.vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64url(sig)}`;
}

function sendOne(store, sub) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(sub.endpoint); } catch (e) { resolve({ status: 0, gone: true }); return; }
    const subject = store.push.subject || 'https://trainingsanalyse.onrender.com';
    const jwt = vapidJwt(store, sub.endpoint, subject);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${store.push.vapid.publicKey}`,
        TTL: '43200',
        Urgency: 'normal',
        'Content-Length': 0
      },
      timeout: 15000
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, gone: false }));
    req.end();
  });
}

// An alle Geräte senden; abgelaufene Abos werden entfernt. Gibt Anzahl Erfolge zurück.
async function sendAll(store) {
  ensureVapid(store);
  const subs = store.push.subscriptions || [];
  let ok = 0;
  const keep = [];
  for (const sub of subs) {
    const r = await sendOne(store, sub);
    if (r.status >= 200 && r.status < 300) ok++;
    if (!r.gone) keep.push(sub);
    else console.log('[push] Abo abgelaufen, entfernt');
    if (r.status >= 400 && !r.gone) console.log('[push] Fehler', r.status);
  }
  store.push.subscriptions = keep;
  return ok;
}

// Uhrzeit in Europe/Berlin
function berlinNow(now = new Date()) {
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const time = now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false });
  return { day, time };
}

let running = false;
async function maybeSendMorning({ loadStore, saveStore, withWriteLock }) {
  if (running) return;
  running = true;
  try {
    const s0 = await loadStore();
    const st = settings(s0);
    const { day, time } = berlinNow();
    // Nur im Zeitfenster bis 3 h nach der eingestellten Uhrzeit (kein Nachholen am Nachmittag)
    const [h, m] = st.time.split(':').map(Number);
    const [nh, nm] = time.split(':').map(Number);
    const diff = nh * 60 + nm - (h * 60 + m);
    if (!st.enabled || !st.subscriptions || st.lastSentDay === day || diff < 0 || diff > 180) return;
    await withWriteLock(async () => {
      const s = await loadStore();
      if ((s.push || {}).lastSentDay === day) return;
      const n = await sendAll(s);
      s.push.lastSentDay = day;
      await saveStore(s);
      console.log(`[push] Morgen-Erinnerung an ${n} Gerät(e) gesendet`);
    });
  } catch (err) {
    console.log('[push] Fehler:', err.message);
  } finally {
    running = false;
  }
}

module.exports = { ensureVapid, settings, sendAll, maybeSendMorning, berlinNow };
