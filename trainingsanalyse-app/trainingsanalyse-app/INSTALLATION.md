# Installationsanleitung: Trainingsanalyse-App

Diese Anleitung führt dich von der ZIP-Datei bis zur fertig installierten App auf
deinem iPhone – **mit automatischem Import direkt aus Apple Health/Fitness,
kostenlos, ohne Strava.** Kein Programmieren nötig, nur ein Browser und die
Kurzbefehle-App (ist bei jedem iPhone vorinstalliert). Rechne mit ca. 30–40 Minuten,
der Kurzbefehl-Teil ist der aufwendigste Schritt.

Du brauchst: einen (kostenlosen) GitHub-Account, einen (kostenlosen) Render.com-Account.

---

## Schritt 1: Code auf GitHub hochladen

Render (unser Hosting-Anbieter) deployt Apps direkt aus einem Git-Repository.
Deshalb lädst du den Code zunächst zu GitHub hoch – komplett über den Browser,
ohne Kommandozeile.

1. Entpacke die zugeschickte `trainingsanalyse-app.zip` auf deinem Computer.
2. Gehe zu [github.com](https://github.com) und lege einen kostenlosen Account an,
   falls du noch keinen hast.
3. Klicke oben rechts auf **+** → **New repository**.
4. Name z.B. `trainingsanalyse-app`, Sichtbarkeit **Private** (empfohlen, auch wenn
   die eigentlichen Geheimnisse über `.env`/Umgebungsvariablen laufen und nicht mit
   hochgeladen werden, siehe `.gitignore`). Klicke **Create repository**.
5. Auf der leeren Repo-Seite: **uploading an existing file** anklicken.
6. Ziehe den kompletten *Inhalt* des entpackten Ordners (nicht den Ordner selbst,
   sondern alle Dateien/Unterordner darin: `server/`, `public/`, `package.json`,
   `README.md`, usw.) in das Upload-Feld.
7. Unten **Commit changes** klicken.

## Schritt 2: App bei Render.com deployen

1. Gehe zu [render.com](https://render.com) und melde dich an (Anmeldung mit
   GitHub-Account geht am schnellsten und verknüpft gleich beide Konten).
2. **New +** → **Web Service**.
3. Wähle dein eben erstelltes GitHub-Repo `trainingsanalyse-app` aus.
4. Einstellungen:
   - **Name:** frei wählbar (erscheint als Teil deiner URL)
   - **Region:** z.B. Frankfurt
   - **Build Command:** leer lassen
   - **Start Command:** `node server/index.js`
   - **Instance Type:** Free
5. Unter **Environment Variables** → **Add Environment Variable**: `APP_BASE_URL`
   vorerst leer lassen (folgt gleich in 2b). Strava-Variablen brauchst du nur, wenn
   du zusätzlich Strava einrichten willst (siehe Anhang unten) – für Apple Health
   sind sie nicht nötig.
6. Unter **Disks** → **Add Disk**: Name z.B. `data`, **Mount Path**:
   `/opt/render/project/src/data`, Größe 1 GB (das sichert deine Trainingsdaten
   dauerhaft, auch nach einem Neustart des Servers).
7. **Deploy Web Service** klicken. Der erste Build dauert 1–2 Minuten.

### Schritt 2b: URL eintragen

Sobald der Deploy fertig ist, zeigt Render dir oben deine App-URL an, z.B.
`https://trainingsanalyse-app-xyz.onrender.com`. Trage sie unter **Environment**
bei `APP_BASE_URL` ein (ohne `/` am Ende) und speichere – Render deployt automatisch
neu.

Öffne danach die URL im Browser – du solltest das Dashboard sehen, oben eine Karte
**"Apple Health · Kurzbefehl"** mit einer persönlichen Import-Adresse.

## Schritt 3: Apple Health per Kurzbefehl verbinden

Anders als bei Strava gibt es keine direkte Server-zu-Server-Verbindung zu Apple
Health – aus Datenschutzgründen lässt Apple das nicht zu. Stattdessen baust du
einmalig einen **Kurzbefehl**, der sich automatisch nach jedem Apple-Watch-Training
selbst anstößt, die wichtigsten Trainingsdaten ausliest und an deine App schickt.

**Ehrlicher Hinweis vorab:** Ich konnte diesen Kurzbefehl nicht selbst an einem
echten iPhone testen (das kann ich aus meiner Umgebung heraus nicht). Die folgenden
Schritte basieren auf sorgfältiger Recherche und sind logisch stimmig, aber falls
eine Aktion bei dir leicht anders heißt oder an anderer Stelle im Suchmenü auftaucht,
nutze einfach die Suchfunktion in Kurzbefehle mit den genannten Stichworten – die
gesuchte Aktion taucht damit praktisch immer auf. Die Herzfrequenz-Schritte (3.4)
sind der wackligste Teil; wenn die bei dir partout nicht funktionieren, lass sie
einfach weg – die App schätzt die Trainingsbelastung dann automatisch über Sportart
und Dauer statt über Herzfrequenz, das funktioniert ebenfalls gut.

### 3.1 Deine Import-Adresse holen

Öffne deine App-URL im Browser, in der Karte **"Apple Health · Kurzbefehl"** siehst
du eine Zeile wie:

```
https://trainingsanalyse-app-xyz.onrender.com/api/import/health?token=a1b2c3...
```

Tippe auf **"URL kopieren"**. Diese Adresse ist dein persönliches, geheimes Passwort
für den Import – nicht weitergeben. Falls sie doch mal in falsche Hände gerät, kannst
du jederzeit über **"Token neu generieren"** eine neue erzeugen (die alte wird dann
ungültig).

### 3.2 Neue Automatisierung anlegen

1. Öffne die **Kurzbefehle**-App auf dem iPhone.
2. Tab **Automatisierung** → **+** (oben rechts) → **Neue persönliche Automatisierung**.
3. Scrolle zu **Apple Watch-Training** (bzw. "Training") und wähle es aus.
4. Stelle **"Endet"** ein (nicht "Beginnt"), Trainingsart: **Beliebig**. **Weiter**.
5. **Neuen leeren Kurzbefehl erstellen**.

### 3.3 Basis-Trainingsdaten auslesen

Diese Aktionen im neuen Kurzbefehl hinzufügen (über die Lupe/Suche unten):

1. Suche nach **"Details von Workout abrufen"** (bzw. englisch "Get Details of
   Workout") und füge sie hinzu. Als Eingabe die **Kurzbefehl-Eingabe** wählen
   (das ist automatisch das gerade beendete Training).
2. Tippe die Aktion an und wähle nacheinander folgende Eigenschaften aus (bzw.
   füge für jede einen eigenen Wert hinzu, falls deine Kurzbefehle-Version das
   als Liste statt Dropdown anbietet): **Trainingsart**, **Startdatum**,
   **Enddatum**, **Gesamtdistanz**, **Verbrauchte aktive Energie**,
   **Gesamter Höhenanstieg**.
3. Füge die Aktion **"Zeit zwischen Daten berechnen"** (bzw. "Date Difference"/
   "Zeitspanne berechnen") hinzu: von **Startdatum** bis **Enddatum**, Einheit
   **Sekunden**. Das ergibt eine verlässliche Dauer unabhängig davon, in welcher
   Einheit "Dauer" sonst geliefert würde.
4. Falls Distanz/Höhenanstieg mit einer Einheit angezeigt werden (z.B. "8,2 km"
   statt einer reinen Zahl): Aktion **"Einheiten umrechnen"** dazwischenschalten
   und auf **Meter** umrechnen.

### 3.4 Herzfrequenz auslesen (optional, wie gewünscht)

1. Füge **"Zustände suchen"** (bzw. "Find Health Samples") hinzu, Typ:
   **Herzfrequenz**, Filter: **Startdatum ist nach** [Startdatum aus 3.3] **und**
   **Startdatum ist vor** [Enddatum aus 3.3].
2. Füge **"Statistik berechnen"** (bzw. "Calculate Statistics") hinzu, Eingabe:
   das Ergebnis aus Schritt 1, Berechnung: **Durchschnitt**. Das ist deine
   durchschnittliche Herzfrequenz.
3. Optional wiederholen mit Berechnung **Maximum** für die Maximalherzfrequenz.
4. **Test-Tipp:** Führe den Kurzbefehl einmal manuell aus (z.B. direkt nach einem
   Training antippen) und schau dir bei den beiden "Statistik berechnen"-Ergebnissen
   im Vorschau-Fenster an, ob plausible Zahlen (z.B. 130–170) rauskommen. Wenn dort
   nichts oder Unsinn steht, überspring diesen Abschnitt einfach – siehe Hinweis oben.

### 3.5 Daten an die App senden

1. Füge die Aktion **"Wörterbuch"** (Dictionary) hinzu und trage folgende
   Schlüssel/Werte ein (rechts jeweils die passende Variable aus den vorherigen
   Schritten einsetzen, per Tippen auf das Textfeld → Variable auswählen):

   | Schlüssel | Wert |
   |---|---|
   | `type` | Trainingsart (aus 3.3) |
   | `startDate` | Startdatum (aus 3.3) |
   | `durationSec` | Ergebnis aus "Zeit zwischen Daten berechnen" (3.3) |
   | `distanceMeters` | Gesamtdistanz in Metern (aus 3.3/3.4) |
   | `activeEnergyKcal` | Verbrauchte aktive Energie (aus 3.3) |
   | `elevationGainMeters` | Gesamter Höhenanstieg in Metern (aus 3.3) |
   | `averageHeartrate` | Durchschnitt aus 3.4 (weglassen, falls nicht genutzt) |
   | `maxHeartrate` | Maximum aus 3.4 (weglassen, falls nicht genutzt) |

2. Füge **"Inhalt von URL abrufen"** (Get Contents of URL) hinzu:
   - **URL:** deine Import-Adresse aus 3.1 (einfach einfügen)
   - Tippe auf **Anzeigen weiterer Optionen (▸)**
   - **Methode:** POST
   - **Kopfzeilen:** `Content-Type` = `application/json`
   - **Anfragetext (Request Body):** **JSON** auswählen, dann als Inhalt das
     **Wörterbuch** aus Schritt 1 dieser Aktion auswählen (nicht abtippen –
     die Variable direkt reinziehen/auswählen).

### 3.6 Ohne Rückfrage im Hintergrund laufen lassen

1. Zurück zur Automatisierungs-Übersicht, **Fertig**.
2. Ganz wichtig: Schalte **"Vor Ausführung fragen"** **aus** (bzw. wähle
   "Sofort ausführen"). Sonst bekommst du nach jedem Training eine Benachrichtigung,
   die du erst antippen müsstest, damit der Import läuft.

### 3.7 Testen

1. Mach ein kurzes Test-Training auf der Apple Watch (reicht auch 1–2 Minuten).
2. Beende es. Nach kurzer Zeit (Handy muss dafür entsperrt worden sein – iOS führt
   Automatisierungen im Hintergrund nicht beliebig zuverlässig sofort aus, das ist
   eine bewusste Einschränkung von Apple, keine Krux unserer App) sollte in der App
   unter "Apple Health · Kurzbefehl" der Zähler hochgehen und die Aktivität in der
   Liste "Letzte Aktivitäten" auftauchen.
3. Klappt's nicht sofort: Handy kurz entsperren/App im Vordergrund haben und
   nochmal schauen – iOS braucht dafür manchmal ein paar Minuten.

## Schritt 4: Auf dem iPhone installieren

1. Öffne deine App-URL in **Safari** auf dem iPhone (wichtig: Safari, nicht Chrome).
2. Tippe unten auf das **Teilen-Symbol** (Quadrat mit Pfeil nach oben).
3. Wähle **"Zum Home-Bildschirm"**.
4. Fertig – ab jetzt startet die App über ihr eigenes Icon im Vollbildmodus wie
   eine normale App.

---

## Kurz-Check, ob alles klappt

- App-URL öffnet sich und zeigt das Dashboard → Server läuft ✓
- Testtraining taucht nach der Automatisierung in "Letzte Aktivitäten" auf →
  Kurzbefehl läuft ✓
- Nach ein paar Trainings: "Neue Woche planen" erzeugt einen sinnvollen Plan →
  Analyse-Engine hat genug Daten ✓

## Wenn etwas nicht klappt

- **Import kommt nie an:** Prüfe zuerst mit einem manuellen Kurzbefehl-Testlauf
  (Kurzbefehle-App → Kurzbefehl antippen statt auf die Automatisierung zu warten),
  ob die Aktion "Inhalt von URL abrufen" überhaupt einen Fehler zurückgibt (z.B.
  falscher Token, fehlendes Pflichtfeld) – der Fehlertext dort verrät meist genau,
  was fehlt.
- **401-Fehler:** Die Import-Adresse/der Token stimmt nicht mehr – z.B. weil du
  zwischendurch auf "Token neu generieren" geklickt hast. Neue Adresse aus der App
  holen und im Kurzbefehl aktualisieren.
- **400-Fehler mit Feldname:** Ein Pflichtfeld (`type`, `startDate` oder
  `durationSec`) fehlt im gesendeten Wörterbuch oder hat das falsche Format –
  nochmal Schritt 3.5 prüfen.
- **Automatisierung läuft gar nicht erst an:** Prüfe, dass unter "Vor Ausführung
  fragen" wirklich aus ist, und dass die Apple Watch während des Trainings mit dem
  iPhone verbunden war.
- **App reagiert beim ersten Aufruf sehr langsam:** normal bei Render Free Tier –
  die Instanz "schläft" nach Inaktivität ein und braucht beim Aufwecken ein paar
  Sekunden.

Ausführlichere Hintergründe (Architektur, wie die Analyse- und Planungslogik
funktioniert) stehen in der `README.md` im selben Ordner.

---

## Anhang: Optional zusätzlich Strava verbinden (kostenpflichtig)

Falls du zusätzlich oder stattdessen Strava nutzen willst (z.B. weil du dort ohnehin
aktiv bist) – seit Sommer 2026 verlangt Strava dafür eine laufende, kostenpflichtige
Mitgliedschaft (siehe unser vorheriges Gespräch). Die Funktion ist weiterhin in der
App enthalten:

1. Strava-API-App anlegen unter <https://www.strava.com/settings/api> (Callback
   Domain = deine Render-URL ohne `https://`).
2. Bei Render unter **Environment** ergänzen: `STRAVA_CLIENT_ID`,
   `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN` (ein beliebiges Passwort).
3. In der App auf **"Mit Strava verbinden"** klicken, danach unter dem Strava-Status
   auf **"Jetzt einrichten"** für den automatischen Webhook-Import.

Beide Quellen (Apple Health per Kurzbefehl und Strava) können parallel aktiv sein –
die App dedupliziert nicht automatisch zwischen beiden, achte also darauf, nicht
dieselben Trainings doppelt einzuspielen.
