// Kleines CLI-Hilfsskript, um die Strava-Webhook-Subscription einzurichten,
// ohne den Server zu starten. Praktisch direkt nach dem Deployment.
//
// Aufruf:  APP_BASE_URL=https://deine-app.onrender.com node server/setup-webhook.js
// (liest zusätzlich STRAVA_CLIENT_ID/SECRET/STRAVA_WEBHOOK_VERIFY_TOKEN aus .env)
//
// Hinweis: Die App bietet denselben Schritt auch komfortabel per Klick im
// Einstellungen-Bereich der Weboberfläche an (Button "Webhook einrichten").

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const strava = require('./strava');

async function main() {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    console.error('Bitte APP_BASE_URL setzen, z.B.:');
    console.error('  APP_BASE_URL=https://deine-app.onrender.com node server/setup-webhook.js');
    process.exit(1);
  }
  const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error('Bitte STRAVA_WEBHOOK_VERIFY_TOKEN in der .env setzen.');
    process.exit(1);
  }

  const callbackUrl = `${baseUrl.replace(/\/$/, '')}/webhook`;
  console.log('Prüfe bestehende Subscriptions...');
  const existing = await strava.listWebhookSubscriptions();
  if (existing && existing.length > 0) {
    console.log('Es existiert bereits eine Subscription:', existing[0]);
    console.log('Falls du sie neu anlegen willst, lösche sie zuerst in der Strava-App-Einstellung oder via API.');
    return;
  }

  console.log(`Lege neue Subscription an mit callback_url=${callbackUrl} ...`);
  const sub = await strava.createWebhookSubscription(callbackUrl, verifyToken);
  console.log('Erfolgreich eingerichtet:', sub);
}

main().catch((err) => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
