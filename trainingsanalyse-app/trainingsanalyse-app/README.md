# Trainingsanalyse

Eine kleine, selbst gehostete Web-App, die deine Trainings automatisch importiert,
deine Trainingsbelastung analysiert (Trainingslast, ACWR, Monotonie/Strain) und dir
daraus einen regelbasierten, sich wöchentlich anpassenden Trainingsplan erstellt.
Läuft als installierbare PWA auf dem iPhone – kein App-Store-Umweg nötig.

**Empfohlener Datenweg: direkt aus Apple Health/Fitness per iOS-Kurzbefehl,
kostenlos.** Eine Strava-Anbindung ist optional weiterhin enthalten, erfordert
seit Sommer 2026 aber eine kostenpflichtige Strava-Mitgliedschaft (siehe Anhang
in `INSTALLATION.md`) – für die meisten daher nicht mehr die erste Wahl.

**Kein Build-Schritt, keine externen Abhängigkeiten.** Das Backend nutzt nur in
Node.js eingebaute Module (`http`, `fetch`, `fs`). Das macht Deployment und
Wartung sehr einfach.

## Was die App tut

- **Automatischer Import aus Apple Health**: Ein einmalig eingerichteter
  iOS-Kurzbefehl schickt nach jedem Apple-Watch-Training automatisch die
  wichtigsten Kennzahlen (Sportart, Dauer, Distanz, Kalorien, optional
  Herzfrequenz) an die App – kein manueller Export, kein Drittanbieter-Abo.
  Genaue Einrichtung: siehe `INSTALLATION.md`, Schritt 3.
- **Trainingsanalyse**: Berechnet aus deinen Aktivitäten eine Trainingslast
  (bevorzugt über Herzfrequenz via TRIMP-Formel, sonst über eine
  Dauer-Schätzung je Sportart) und daraus:
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
  index.js            Server, Routing, Import-, OAuth- & Webhook-Endpunkte
  store.js            Einfacher dateibasierter Datenspeicher (data/store.json)
  health-import.js     Nimmt Kurzbefehl-Trainingsdaten entgegen (Apple Health)
  strava.js            Optionale Strava-API-Anbindung (OAuth, Aktivitäten, Webhooks)
  analysis.js           Trainingslast, ACWR, Monotonie/Strain
  planner.js            Regelbasierte Trainingsplan-Erstellung
public/                 PWA-Frontend (Vanilla JS, kein Framework, kein Build-Step)
data/store.json         Deine Daten (Athlet, Aktivitäten, Plan) - nicht committen!
```

Da alles in einer JSON-Datei gespeichert wird, ist die App für **einen** Nutzer
ausgelegt (also genau dich) – keine Login-/Mehrbenutzer-Logik nötig. Der
Import-Endpunkt (`/api/import/health`) ist stattdessen über einen persönlichen,
in der App generierten Token abgesichert (in den Kurzbefehl eingetragen, siehe
Installationsanleitung).

## Lokal testen

Voraussetzung: Node.js ≥ 18 (am besten 20+).

```bash
cd trainingsanalyse-app
cp .env.example .env
node server/index.js
```

Danach im Browser: <http://localhost:3000>. Der Health-Import-Endpunkt funktioniert
bereits lokal (du kannst ihn z.B. mit `curl` testen), der eigentliche Kurzbefehl auf
dem iPhone braucht aber eine öffentliche HTTPS-URL – dafür folgt jetzt das
Deployment, siehe `INSTALLATION.md`.

## Deployment & Einrichtung

Die komplette Schritt-für-Schritt-Anleitung (GitHub-Upload → Render-Deployment →
Kurzbefehl bauen → iPhone-Installation) steht in **`INSTALLATION.md`** im selben
Ordner. Andere Hosting-Optionen als Render (Railway, Fly.io, ein eigener VPS)
funktionieren genauso – wichtig ist nur: Node ≥ 18, ein dauerhafter Speicherort
für `data/store.json`, und die Umgebungsvariable `APP_BASE_URL` (siehe
`.env.example`).

## Einstellungen

Über "Einstellungen" in der App kannst du hinterlegen:
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
- **Kein echter Push-Import**: Apple erlaubt keinen direkten Serverzugriff auf
  HealthKit-Daten. Der Kurzbefehl-Import hängt daher an iOS' Hintergrund-
  Ausführung (Handy muss zwischendurch entsperrt werden) – meist kommt der Import
  innerhalb weniger Minuten an, aber nicht so instantan wie ein klassischer Webhook.
- **Herzfrequenz optional**: Lässt sich per Kurzbefehl auslesen, ist aber der
  fragilste Teil der Automatisierung (siehe `INSTALLATION.md`, Schritt 3.4).
  Die App funktioniert auch zuverlässig ohne HF-Daten.
- **Freier Tier-Hinweis**: Kostenlose Render-Instanzen schlafen nach Inaktivität
  ein und brauchen dann ein paar Sekunden zum Aufwachen – für den ersten Aufruf
  nach längerer Pause normal.
- **Erweiterbar**: Die Regeln in `planner.js`/`analysis.js` sind bewusst einfach
  und gut kommentiert gehalten, damit du sie leicht an deinen Trainingsstil
  anpassen kannst (z.B. eigene Zielwettkämpfe, andere Deload-Rhythmen, mehr
  Sportarten-Feintuning).
