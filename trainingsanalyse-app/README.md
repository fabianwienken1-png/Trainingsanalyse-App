# Trainingsanalyse

Eine kleine, selbst gehostete Web-App, die deine Strava-Aktivitäten automatisch
importiert, deine Trainingsbelastung analysiert (Trainingslast, ACWR, Monotonie/Strain)
und dir daraus einen regelbasierten, sich wöchentlich anpassenden Trainingsplan
erstellt. Läuft als installierbare PWA auf dem iPhone – kein App-Store-Umweg nötig.

**Kein Build-Schritt, keine externen Abhängigkeiten.** Das Backend nutzt nur in
Node.js eingebaute Module (`http`, `fetch`, `fs`). Das macht Deployment und
Wartung sehr einfach.

## Was die App tut

- **Automatischer Import**: Sobald du ein Training in Strava hochlädst, schickt
  Strava einen Webhook an die App, die daraufhin die Aktivität automatisch abruft
  und speichert – kein manueller Export nötig.
- **Trainingsanalyse**: Berechnet aus deinen Aktivitäten eine Trainingslast
  (bevorzugt aus Strava "Relative Effort", sonst über Herzfrequenz via TRIMP-Formel,
  sonst über eine Dauer-Schätzung je Sportart) und daraus:
  - **ACWR** (Acute:Chronic Workload Ratio) – Verhältnis der Belastung der letzten
    7 Tage zum 28-Tage-Schnitt, eine verbreitete Kennzahl zur groben Einschätzung
    von Verletzungs-/Übertrainingsrisiko.
  - **Monotonie & Strain** (nach Foster) – erkennt, wenn dein Training zu wenig
    Abwechslung zwischen harten und leichten Tagen hat.
  - Wochentrend, Sportart-Verteilung, Auffälligkeiten als Klartext-Hinweise.
- **Adaptive Trainingspläne**: Erstellt jede Woche automatisch (oder auf Knopfdruck)
  einen neuen Wochenplan – **regelbasiert und nachvollziehbar**, keine Blackbox:
  - Max. 10 % Belastungssteigerung pro Woche (einstellbar)
  - Automatische Deload-Woche alle 4 Wochen (einstellbar)
  - Reduziert die Belastung bei erhöhter ACWR
  - Steigert nicht weiter, wenn du zuletzt viele geplante Einheiten verpasst hast
  - Sportart-Mix orientiert sich an deiner tatsächlichen Trainingshistorie

Alle Regeln stehen ausführlich kommentiert in `server/planner.js` und
`server/analysis.js` – du kannst sie jederzeit anpassen.

**Wichtiger Hinweis:** Die Kennzahlen (ACWR, TRIMP, Monotonie) sind gängige
sportwissenschaftliche Heuristiken, keine medizinische Diagnostik. Sie sollen grobe
Trends sichtbar machen, nicht ärztlichen oder trainerischen Rat ersetzen.

## Architektur in Kürze

```
server/
  index.js          Server, Routing, Strava-OAuth- & Webhook-Endpunkte
  store.js          Einfacher dateibasierter Datenspeicher (data/store.json)
  strava.js         Strava-API-Anbindung (OAuth, Aktivitäten, Webhooks)
  analysis.js        Trainingslast, ACWR, Monotonie/Strain
  planner.js         Regelbasierte Trainingsplan-Erstellung
public/               PWA-Frontend (Vanilla JS, kein Framework, kein Build-Step)
data/store.json       Deine Daten (Athlet, Aktivitäten, Plan) - nicht committen!
```

Da alles in einer JSON-Datei gespeichert wird, ist die App für **einen** Nutzer
ausgelegt (also genau dich) – keine Login-/Mehrbenutzer-Logik nötig.

## 1. Lokal testen

Voraussetzung: Node.js ≥ 18 (am besten 20+).

```bash
cd trainingsanalyse-app
cp .env.example .env
node server/index.js
```

Danach im Browser: <http://localhost:3000>. Strava-Verbindung und Webhook
funktionieren lokal noch nicht (Strava braucht eine öffentliche HTTPS-URL) –
dafür folgt jetzt das Deployment.

## 2. Strava-App anlegen

Damit deine App auf deinen Strava-Account zugreifen darf, brauchst du eine eigene
"Strava API-Anwendung" (kostenlos, dauert 2 Minuten):

1. Gehe zu <https://www.strava.com/settings/api> (eingeloggt mit deinem Strava-Account).
2. Erstelle eine neue Anwendung. Als "Authorization Callback Domain" trägst du
   **nur die Domain ohne https:// und ohne Pfad** ein, z.B. `trainingsanalyse.onrender.com`
   (die genaue Domain bekommst du in Schritt 3, wenn du die App bei Render anlegst –
   du kannst das Feld später in den Strava-Einstellungen jederzeit nachträglich ändern).
3. Du erhältst eine **Client ID** und ein **Client Secret** – beide brauchst du
   gleich für die `.env`.

## 3. Deployment (empfohlen: Render.com, kostenlos)

Render eignet sich gut, weil es kostenlos ist, HTTPS automatisch bereitstellt und
einen "Persistent Disk" für die `data/store.json` anbietet (sonst gehen deine
Daten bei jedem Neustart verloren).

1. Lade den Code auf GitHub hoch (neues Repo, Inhalt dieses Ordners pushen) –
   oder nutze bei Render die Option "Deploy from a public Git repository" mit
   einem beliebigen Git-Hoster.
2. Auf [render.com](https://render.com) → **New → Web Service** → dein Repo auswählen.
3. Einstellungen:
   - **Build Command:** (leer lassen – kein Build-Schritt nötig)
   - **Start Command:** `node server/index.js`
   - **Environment Variables** (unter "Environment"):
     - `STRAVA_CLIENT_ID` = deine Client ID
     - `STRAVA_CLIENT_SECRET` = dein Client Secret
     - `STRAVA_WEBHOOK_VERIFY_TOKEN` = ein beliebiger geheimer String (z.B. mit
       `openssl rand -hex 16` erzeugen)
     - `APP_BASE_URL` = deine spätere Render-URL, z.B. `https://trainingsanalyse.onrender.com`
       (Render zeigt dir die URL nach dem ersten Deploy an – trag sie danach hier ein
       und deploye einmal neu)
4. Unter **Disks**: einen Persistent Disk hinzufügen, Mount Path `/opt/render/project/src/data`
   (bzw. den Pfad, den Render für dein Projektverzeichnis anzeigt + `/data`),
   Größe reicht 1 GB.
5. Deploy starten. Sobald die App läuft, trage die Render-URL (siehe Schritt 3)
   als "Authorization Callback Domain" in deinen Strava-API-Einstellungen ein
   (nur Domain, kein `https://`, kein Pfad).

Andere Hosting-Optionen (Railway, Fly.io, ein eigener VPS) funktionieren genauso –
wichtig ist nur: Node ≥ 18, ein dauerhafter Speicherort für `data/store.json`,
und die Umgebungsvariablen aus `.env.example`.

## 4. Strava verbinden & Auto-Import aktivieren

1. Öffne deine App-URL im Browser, klicke auf **"Mit Strava verbinden"** und
   bestätige den Zugriff. Die App importiert danach automatisch deine letzten
   90 Tage.
2. Damit **neue** Uploads automatisch reinkommen, klicke unter dem Strava-Status
   auf **"Jetzt einrichten"** (richtet die Webhook-Subscription bei Strava ein).
   Alternativ per Kommandozeile direkt auf dem Server:
   ```bash
   APP_BASE_URL=https://deine-app-url node server/setup-webhook.js
   ```
3. Ab jetzt: Training in Strava hochladen → taucht innerhalb weniger Sekunden
   automatisch in der App auf, keine weitere Aktion nötig.

## 5. Als App auf dem iPhone installieren

1. Öffne deine App-URL in **Safari** auf dem iPhone (muss Safari sein, nicht Chrome).
2. Tippe auf das Teilen-Symbol (Quadrat mit Pfeil nach oben).
3. Wähle **"Zum Home-Bildschirm"**.
4. Fertig – ab jetzt startet die App per Icon im Vollbild, wie eine normale App.

## 6. Einstellungen

Über das Zahnrad/"Einstellungen" in der App kannst du hinterlegen:
- Maximale Herzfrequenz & Ruhepuls (für präzisere Trainingslast-Berechnung –
  ohne diese Werte wird grob nach Sportart & Dauer geschätzt)
- Max. wöchentliche Belastungssteigerung (Default 10 %)
- Deload-Rhythmus (Default alle 4 Wochen)
- Standard-Einheiten pro Woche (nur relevant als Startwert, solange noch keine
  Trainingshistorie vorliegt)

## Bekannte Grenzen & mögliche nächste Schritte

- **Single-User**: Kein Login-System – für den privaten Gebrauch durch dich gedacht.
  Schütze die App-URL ggf. zusätzlich (z.B. Render "Basic Auth" oder IP-Filter),
  falls dir das wichtig ist.
- **Apple-Fitness-Import**: Aktuell läuft der automatische Import ausschließlich über
  Strava. Falls du auch Trainings direkt aus Apple Fitness/Health importieren willst
  (ohne Umweg über Strava), müsste zusätzlich ein HealthKit-Export-Mechanismus
  angebunden werden (z.B. über eine Kurzbefehle-Automation, die Health-Daten
  periodisch an die App sendet) – das ist bewusst nicht Teil dieser ersten Version.
- **Freier Tier-Hinweis**: Kostenlose Render-Instanzen schlafen nach Inaktivität
  ein und brauchen dann ein paar Sekunden zum Aufwachen – für den ersten Aufruf
  nach längerer Pause normal.
- **Erweiterbar**: Die Regeln in `planner.js`/`analysis.js` sind bewusst einfach
  und gut kommentiert gehalten, damit du sie leicht an deinen Trainingsstil
  anpassen kannst (z.B. eigene Zielwettkämpfe, andere Deload-Rhythmen, mehr
  Sportarten-Feintuning).
