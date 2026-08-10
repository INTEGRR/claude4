# ERP lokal starten — vollständige Anleitung

Zwei Wege. **Weg 1 (Docker)** ist der schnellste zum Ausprobieren und braucht
außer Docker nichts. **Weg 2 (ohne Docker)** ist der richtige, wenn du am Code
arbeiten willst.

---

# Weg 1: Mit Docker

## 1. Docker installieren

| System | Vorgehen |
|---|---|
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) laden (Apple Silicon oder Intel je nach Mac), installieren, starten |
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) laden und installieren; beim ersten Start WSL 2 aktivieren lassen |
| **Linux** | `curl -fsSL https://get.docker.com \| sh`, danach `sudo usermod -aG docker $USER` und neu anmelden |

Prüfen, ob es läuft:

```bash
docker --version
docker compose version
```

Beide Befehle müssen eine Version ausgeben. Unter macOS und Windows muss
Docker Desktop dabei **geöffnet** sein (Wal-Symbol in der Menüleiste).

## 1b. Hinweis für Windows

Nutze **PowerShell** (oder Git Bash) — nicht die alte Eingabeaufforderung.

Die Befehle in dieser Anleitung funktionieren in PowerShell unverändert, mit
einer Ausnahme: Mehrzeilige Befehle, die im Text mit `\` umbrochen sind,
schreibst du in PowerShell **in eine Zeile** (oder nutzt Backticks `` ` `` statt
`\`). Betroffen ist nur der optionale `docker run`-Befehl in Weg 2 — dort steht
eine PowerShell-Fassung dabei.

Zeilenenden musst du nicht beachten: Das Projekt erzwingt über `.gitattributes`
LF für Shell-Skripte, und der Container-Build normalisiert sie zusätzlich.

## 2. Projekt holen

```bash
git clone https://github.com/INTEGRR/claude4.git
cd claude4
git checkout claude/odo-erp-features-rebuild-3ukys2
```

Falls du das Repository schon hast:

```bash
cd claude4
git checkout claude/odo-erp-features-rebuild-3ukys2
git pull
```

## 3. Starten

```bash
docker compose up --build
```

**Ist Port 3000 bei dir schon belegt?** Dann einen anderen wählen — die
Anwendung ist danach unter genau diesem Port erreichbar:

```powershell
# Windows (PowerShell)
$env:ERP_PORT=3001; docker compose up --build
```

```bash
# macOS / Linux
ERP_PORT=3001 docker compose up --build
```

Dauerhaft: eine Zeile `ERP_PORT=3001` in die Datei `.env` im Projektordner
schreiben (anlegen, falls nicht vorhanden) — dann reicht wieder
`docker compose up`.

### Zugangsdaten eintragen (Shopify, DHL, E-Mail, KI)

Die Schlüssel gehören in die Datei `.env`. Die mitgelieferte `.env.example`
ist nur eine **Vorlage** und wird von niemandem gelesen — sie muss einmal
kopiert werden:

```bash
cp .env.example .env
```

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
```

Danach den jeweiligen Schlüssel eintragen, zum Beispiel für die KI-Analyse:

```
ANTHROPIC_API_KEY=sk-ant-...
```

und neu starten: `docker compose up -d --build`.

Drei Werte aus der `.env` setzt Compose für den Container bewusst selbst —
`DATABASE_URL` (die Datenbank läuft im Compose-Netz, nicht auf deinem
Rechner), `PORT` (innen immer 3000) und `NODE_ENV`. Ein abweichender Eintrag
in der `.env` stört den Container-Start also nicht.

Was jetzt passiert (alles automatisch):

1. Ein Node-Image wird gebaut und die Anwendung kompiliert — **beim ersten Mal
   3–8 Minuten**, danach Sekunden.
2. PostgreSQL startet.
3. Das Datenbankschema wird angelegt (10 Migrationen).
4. Administrator und Beispieldaten werden erzeugt.

Fertig ist es, wenn im Terminal steht:

```
app-1  | Administrator angelegt: admin@example.com / erp-admin
app-1  | Beispieldaten angelegt:
app-1  |   - 20 Komponenten mit Anfangsbestand und Lieferantenpreisen
app-1  |   - Tastatur mit 3 Farbvarianten
app-1  |   - Stückliste mit 20 Positionen, davon 6 farbabhängig gefiltert
app-1  |   - Ein Angebot über 2 weiße Tastaturen (noch nicht bestätigt)
app-1  | → ERP startet auf Port 3000
app-1  | ✓ Ready
```

## 4. Anmelden

Browser öffnen: **<http://localhost:3000>** (bzw. der Port, den du über
`ERP_PORT` gesetzt hast)

| | |
|---|---|
| E-Mail | `admin@example.com` |
| Passwort | `erp-admin` |

Für die Rollen liegen zwei weitere Demo-Konten bei (Passwort jeweils
`erp-admin`): **`lager@example.com`** sieht nur Lager, Versand, Reparatur
und den Scanner; **`fertigung@example.com`** nur Fertigung, Reparatur und
den Scanner. Eigene Konten legst du unter **Einstellungen → Benutzer** an.

Wenn der echte Betrieb beginnt, entfernt **Einstellungen → „Gefahrenzone:
alle Daten löschen (Neustart)"** die Beispieldaten restlos — samt der beiden
Demo-Konten und aller Buchungen; Benutzer, Lagerorte und Konfiguration
bleiben, und der Seed legt sie auch später nicht neu an.

Das Terminal lässt du offen — dort laufen die Protokolle. Zum Beenden `Strg+C`.

---

# Rundgang: der Kernablauf in 5 Minuten

Die Beispieldaten sind so gebaut, dass du den kompletten Weg von der
Bestellung bis zum Versand durchspielen kannst.

## Schritt 1 — Die Stückliste ansehen

**Fertigung → Stücklisten → „Tastatur Modell One"**

Du siehst 20 Positionen. Bei sechs davon steht in der Spalte
**„Auf Varianten anwenden"** ein blaues Kennzeichen wie `Farbe: Weiß` — das
sind die drei Gehäuse und die drei Keycap-Sets. Die übrigen 14 Positionen
gelten für alle Varianten.

Weiter unten bei **„Vorschau je Variante"** wählst du `Tastatur Modell One
(Farbe: Weiß)` und klickst **Anzeigen**. Ergebnis: 16 Positionen — das weiße
Gehäuse und die weißen Keycaps sind dabei, schwarz und blau fehlen. Genau das
ist das Odoo-Verhalten „Apply on Variants".

## Schritt 2 — Auftrag bestätigen

**Verkauf → Verkaufsaufträge → S00001**

Ein Angebot über 2 weiße Tastaturen. Klick auf **Bestätigen**. Es passiert:

- Der Status wechselt auf „Verkaufsauftrag".
- Unten erscheint eine **Lieferung** (`WH/OUT/00001`).
- Unten erscheint ein **Fertigungsauftrag** (`MO/00001`) — weil das Produkt die
  Routen „Fertigen" und „Auf Bestellung" trägt.

## Schritt 3 — Fertigen

Klick auf den Fertigungsauftrag **MO/00001**.

Die Komponentenliste hat **16 Zeilen** — die gefilterte Stückliste, eingefroren
zum Zeitpunkt der Anlage. Alle Mengen sind grün reserviert.

Klick auf **Drucken** (öffnet sich in einem neuen Tab): der Werkstattbeleg mit
scanbarem Barcode der Auftragsnummer, Komponenten-Checkliste zum Abhaken und
Unterschriftszeilen. Über den Drucken-Knopf unten geht es in den Druckdialog.

Zurück im Auftrag: **Fertig melden** klicken. Danach ist der Auftrag „Erledigt",
2 Tastaturen sind im Bestand und das Material ist verbraucht.

## Schritt 4 — Verbrauch prüfen

**Lager → Bestand**

Suche nach `Switch`: von 9.000 sind noch **8.826** da — genau 174 verbraucht
(87 Stück pro Tastatur × 2). Beim weißen Gehäuse fehlen 2, beim schwarzen und
blauen ist nichts abgegangen.

Klick auf ein Produkt → **Bewegungen**: dort steht jede einzelne Buchung mit
Datum, Von/Nach-Lagerort und Beleg. Nichts im System ändert Bestände am
Protokoll vorbei.

## Schritt 5 — Versand

**Versand**

Die Lieferung steht jetzt unter **„Versandbereit"** — sie erscheint dort, weil
die Fertigung fertig ist und die Ware reserviert werden konnte. Der Knopf
„Label erstellen" ist ohne DHL-Zugangsdaten deaktiviert; das ist erwartet
(siehe unten).

## Schritt 6 — Am Scanner-Arbeitsplatz (optional, ohne Scanner spielbar)

**Scanner** in der Navigation öffnen. Die Seite lauscht auf Tastatureingaben —
ein Barcodescanner im Tastatur-Modus tippt einfach Code + Enter, zum
Ausprobieren geht das genauso von Hand:

1. `MO/00002` eintippen und Enter (einen neuen Fertigungsauftrag bekommst du,
   indem du z. B. einen weiteren Auftrag bestätigst oder unter Fertigung
   einen anlegst und bestätigst). Die Positionsliste erscheint.
2. Komponenten-Barcodes scannen bzw. eintippen (z. B. `4260000000001` für
   das weiße Gehäuse — die Barcodes stehen an jeder Zeile). Jede Eingabe
   zählt die Zeile hoch, volle Zeilen werden grün, ein Scan zu viel gibt
   einen Warnton.
3. Die Belegnummer **erneut** eintippen (Doppelscan) → Bestätigen-Ansicht.
   Standard beim Fertigungsauftrag: es werden die **Sollmengen** verbraucht;
   die Scans dienen als Kontrolle.
4. Belegnummer ein drittes Mal eintippen (oder den großen Knopf drücken) —
   der Auftrag ist gebucht, die Anzeige springt zurück auf „Beleg scannen".

Lieferungen (`WH/OUT/…`) funktionieren genauso — dort gilt: gescannt =
erledigt, der Rest wandert automatisch in einen Rückstand.

## Schritt 7 — Auswertungen ansehen

**Auswertungen** in der Navigation öffnen: Inventarwert, „Produktion je
Endvariante" (die zwei gefertigten weißen Tastaturen), „Verbaute
Komponenten" (u. a. 2× Gehäuse weiß — genau die Frage „wie oft wurde
weißes Case verbaut") und die Abverkaufsquote der letzten 6 Monate.

## Was du sonst noch ausprobieren kannst

| Was | Wo |
|---|---|
| Kommentar an einem Beleg hinterlassen | jede Detailseite, Karte „Verlauf & Kommentare" |
| Benutzer und Rollen verwalten | Einstellungen → Benutzer (als Admin) |
| KI-Analyse (braucht `ANTHROPIC_API_KEY`) | KI-Analyse in der Navigation |
| Meldebestand anlegen, Vorschlag ausführen | Lager → Beschaffung (z. B. Switches: Min 9500 / Max 12000) |
| Seriennummern verfolgen | Produkt → Rückverfolgung auf „Seriennummern", dann fertigen; Lager → Lose & Serien |
| Steuern, Zahlungsbedingungen, Kategorien, Tags | Produkte → Konfiguration |
| API-Transaktionen und Job-Queue beobachten | Integrationen → Transaktionsprotokoll (als Admin) |
| Bestellung beim Lieferanten, Wareneingang buchen | Einkauf → Neue Bestellung („Komponenten Handels GmbH") |
| Lieferantenrechnung, Gutschrift | Einkauf → Bestellung → Rechnung erstellen |
| Inventur mit Differenzbuchung | Lager → Inventur |
| Ausschuss buchen | Lager → Bestand (unten) |
| Tastatur wieder zerlegen | Fertigung → Demontage |
| Reparatur mit Teileverbrauch | Reparaturen → Neuer Reparaturauftrag |
| Neue Farbe anlegen und Varianten erzeugen | Produkte → Attribute, dann Produkte → Tastatur |
| Barcode-Suche | Feld oben rechts (oder **F2**), z. B. `MO/00001` oder `TAST-W` eingeben |

---

# Alltagsbefehle (Docker)

```bash
docker compose up            # starten (ohne Neubau)
docker compose up --build    # starten und vorher neu bauen (nach git pull)
docker compose up -d         # im Hintergrund starten
docker compose down          # anhalten, Daten bleiben erhalten
docker compose down -v       # anhalten und ALLE Daten löschen (frischer Start)
docker compose logs -f app   # Protokolle mitlesen
docker compose restart app   # nur die Anwendung neu starten
```

**Ganz von vorn anfangen:**

```bash
docker compose down -v && docker compose up --build
```

**In die Datenbank schauen:** In `docker-compose.yml` beim Dienst `db` die drei
Kommentarzeichen vor `ports` entfernen, dann `docker compose up -d`. Danach:

```bash
psql postgres://erp:erp@localhost:5433/erp
```

---

# Für den echten Betrieb: vier Dinge beachten

Zum Ausprobieren läuft alles ohne Zutun. Wer damit wirklich arbeitet, sollte
diese vier Punkte kennen.

## 1. Die Daten liegen in Docker-Volumes, nicht im Projektordner

`docker compose down -v` löscht **alles** — Aufträge, Bestände, Bewegungen.
Das `-v` ist der Unterschied zwischen „anhalten" und „wegwerfen".

Sicherung, am besten regelmäßig:

```bash
docker compose exec -T db pg_dump -U erp -Fc erp > sicherung-$(date +%F).dump
```

Zurückspielen in eine leere Datenbank:

```bash
docker compose exec -T db pg_restore -U erp -d erp --clean < sicherung-2026-08-09.dump
```

## 2. Vom Telefon oder Tablet erreichbar machen

Die Oberfläche ist für schmale Geräte gebaut — am Packtisch oder an der
Werkbank ist das Telefon oft die bequemste Bedienung. Standardmäßig lauscht
das ERP aber **nur auf dem eigenen Rechner**:

```yaml
ports:
  - '127.0.0.1:${ERP_PORT:-3000}:3000'
```

Für den Zugriff aus dem Werkstatt-WLAN die Bindung auf alle Schnittstellen
umstellen:

```yaml
ports:
  - '${ERP_PORT:-3000}:3000'
```

Danach ist das ERP unter `http://<IP-des-Rechners>:3000` erreichbar — und
zwar **für jeden im selben Netz, ohne weitere Hürde**. Das ist die bewusste
Entscheidung, die dahintersteht: im eigenen, vertrauenswürdigen Netz in
Ordnung, in einem Gast- oder Büro-WLAN mit Fremdgeräten nicht. Wer das
weiterdenken will, findet die Varianten in [betrieb.md](betrieb.md).

## 3. Die Zeitsteuerung läuft mit — aber nur, wenn der Dienst `cron` läuft

Ohne sie bliebe die Warteschlange stehen: Fulfillment würde nicht an Shopify
gemeldet, Bestell-Mails blieben liegen, die Sendungsverfolgung stünde still
und die Kennzahlen zeigten Zahlen von vorgestern. Der Dienst `cron` in
`docker-compose.yml` erledigt das und startet automatisch mit.

Prüfen, ob er arbeitet:

```bash
docker compose logs -f cron       # → "Zeitsteuerung aktiv"
```

Die Staffelung (minütlich Outbox und Webhooks, viertelstündlich Abgleich,
stündlich Sendungsverfolgung, alle sechs Stunden Kennzahlen, täglich
Aufräumen) steht in `docker/cron.sh` und entspricht der auf Vercel.

## 4. Nach einem `git pull` neu bauen

Neue Migrationen spielt der Container beim Start selbst ein — aber nur, wenn
er auch neu gebaut wurde:

```bash
git pull && docker compose up --build
```

Migrationen sind unveränderlich und laufen genau einmal; ein zweiter Start
ändert nichts. Das Startprotokoll zeigt, was eingespielt wurde.

---

# Weg 2: Ohne Docker

Sinnvoll, wenn du am Code arbeitest: Änderungen sind sofort im Browser
sichtbar, ohne Neubau.

## 1. Voraussetzungen

- **Node.js 22 oder neuer** — [nodejs.org](https://nodejs.org/) oder
  `brew install node` / `nvm install 22`
- **PostgreSQL 16 oder neuer**

Prüfen:

```bash
node --version    # muss v22 oder höher sein
```

## 2. PostgreSQL bereitstellen

**Windows ohne Docker:** [PostgreSQL-Installer](https://www.postgresql.org/download/windows/)
ausführen und das vergebene Passwort merken. Danach in der PowerShell:

```powershell
createdb -U postgres erp
```

In `.env` dann:
`DATABASE_URL=postgres://postgres:DEINPASSWORT@localhost:5432/erp`

**Mit Docker** — am einfachsten nur die Datenbank im Container, den Rest nativ:

```bash
docker run -d --name erp-db \
  -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=erp \
  -p 5433:5432 postgres:17-alpine
```

In PowerShell in einer Zeile:

```powershell
docker run -d --name erp-db -e POSTGRES_USER=erp -e POSTGRES_PASSWORD=erp -e POSTGRES_DB=erp -p 5433:5432 postgres:17-alpine
```

Alternativ nativ installiert (macOS: `brew install postgresql@17 && brew
services start postgresql@17`), dann Datenbank anlegen:

```bash
createdb erp
```

## 3. Einrichten und starten

```bash
npm install
cp .env.example .env
```

In `.env` die Zeile `DATABASE_URL` auf deine Datenbank zeigen lassen:

```
DATABASE_URL=postgres://erp:erp@localhost:5433/erp
```

(Bei nativer Installation ohne Passwort meist:
`postgres://localhost:5432/erp`)

Dann:

```bash
npm run db:migrate         # Schema anlegen
npm run db:seed -- --demo  # Administrator + Beispieldaten
npm run dev                # startet auf http://localhost:3000
```

## 4. Weitere Befehle

```bash
npm run db:reset           # Schema verwerfen und neu aufbauen (Daten weg!)
npm run db:seed            # nur Administrator, ohne Beispieldaten
npm test                   # 61 Tests (brauchen die Datenbank)
npm run check              # Typprüfung + Tests
npm run build && npm start # Produktionsmodus lokal testen
```

---

# Shopify und DHL anbinden (optional)

Ohne Zugangsdaten laufen **alle Module** — nur der Bestellimport und die
Labelerstellung sind deaktiviert, mit sichtbarem Hinweis in der Oberfläche.
Zum Aktivieren die Werte in `.env` eintragen (bzw. bei Docker in
`docker-compose.yml` unter `environment`) und neu starten.

**Shopify** — App im [Dev Dashboard](https://dev.shopify.com) anlegen (seit
2026 der einzige Weg; die früheren Custom Apps im Shop-Admin gibt es für neue
Apps nicht mehr):

1. Dev Dashboard → App erstellen, Scopes geben: `read_orders`, `read_all_orders` (sonst nur die letzten 60 Tage!),
   `write_orders`, `read_customers`, `read_products`,
   `write_merchant_managed_fulfillment_orders`, `read_inventory`,
   `write_inventory`, `read_locations`.
2. App im eigenen Shop **installieren**.
3. **Settings → Credentials**: Client ID und Secret kopieren.

```
SHOPIFY_SHOP_DOMAIN=deinshop.myshopify.com   # die .myshopify.com-Adresse
SHOPIFY_CLIENT_ID=…
SHOPIFY_CLIENT_SECRET=…
```

Ein Token muss nirgends kopiert werden: das ERP tauscht Client ID und Secret
selbst gegen ein Access Token (Client-Credentials-Grant, 24 Stunden gültig)
und erneuert es automatisch. Das funktioniert, weil App und Shop derselben
Organisation gehören. Alt-Apps von vor 2026 mit statischem `shpat_…`-Token
laufen weiter über `SHOPIFY_ADMIN_TOKEN`.

Webhooks brauchen eine öffentlich erreichbare URL — `localhost` kann Shopify
nicht anrufen. Lokal ist das einkalkuliert: der viertelstündliche Abgleich
holt Bestellungen aktiv ab, es geht nur die Sekunden-Aktualität verloren.
Läuft das ERP öffentlich (z. B. Vercel), die Webhooks `orders/create`,
`orders/updated`, `orders/cancelled` und `inventory_levels/update` auf
`https://<erp>/api/webhooks/shopify` registrieren (im Dev Dashboard in der
App-Konfiguration). Shopify signiert sie mit dem Client Secret — 
`SHOPIFY_WEBHOOK_SECRET` bleibt dann leer und ist nur für Webhooks nötig, die
über die Admin-Seite (Einstellungen → Benachrichtigungen) registriert wurden.

**DHL** — Geschäftskundenvertrag mit Zugang zum Geschäftskundenportal, dort
einen Systembenutzer anlegen, App im
[DHL Developer Portal](https://developer.dhl.com/) erstellen:

```
DHL_API_BASE=https://api-sandbox.dhl.com   # zum Testen; produktiv: https://api-eu.dhl.com
DHL_API_KEY=…
DHL_API_SECRET=…
DHL_GKP_USER=…
DHL_GKP_PASSWORD=…
DHL_BILLING_NUMBER=…          # 14-stellig
```

Zum Ausprobieren reicht die Sandbox mit den DHL-Testzugangsdaten — dort
kommen Musterlabels zurück, es wird nichts versendet.

Den Zustand beider Anbindungen zeigt die Seite **Integrationen**.

**KI-Analyse** — API-Schlüssel in der
[Anthropic Console](https://console.anthropic.com/) erstellen:

```
ANTHROPIC_API_KEY=sk-ant-…
```

Danach beantwortet die Seite **KI-Analyse** freie Fragen zu allen ERP-Daten
(„Welche Komponenten reichen nicht mehr aus?") — der Agent liest die
Datenbank ausschließlich lesend, Ergebnisse lassen sich als CSV
herunterladen. Jede ausgeführte SQL-Abfrage wird protokolliert.

---

# Fehlerbehebung

**`port is already allocated` / `address already in use` (Port 3000)**
Auf Port 3000 läuft schon etwas anderes. Einfach einen anderen Port nehmen:

```powershell
$env:ERP_PORT=3001; docker compose up --build      # Windows
```
```bash
ERP_PORT=3001 docker compose up --build            # macOS / Linux
```

Damit es dauerhaft gilt, `ERP_PORT=3001` in die Datei `.env` im Projektordner
schreiben. Die Anwendung ist dann unter <http://localhost:3001> erreichbar.

Wer wissen will, was den Port belegt:
`netstat -ano | findstr :3000` (Windows) bzw. `lsof -i :3000` (macOS/Linux).

**Auch bei Weg 2 (ohne Docker)** lässt sich der Port setzen:
`PORT=3001 npm run dev` bzw. `$env:PORT=3001; npm run dev`.

**`Cannot connect to the Docker daemon` / `failed to connect to the docker API
at npipe:////./pipe/dockerDesktopLinuxEngine` (Windows)**

Die Docker-Engine läuft nicht. Der Docker-Befehl selbst ist installiert, findet
aber keinen laufenden Dienst.

1. **Docker Desktop starten** (Startmenü → Docker Desktop) und warten, bis
   unten links **„Engine running"** grün angezeigt wird — nach einem Neustart
   des Rechners dauert das gut 1–2 Minuten.
2. Prüfen mit `docker version`: Es muss ein Abschnitt **`Server:`** erscheinen.
   Steht dort nur `Client:`, ist die Engine noch nicht oben.
3. Dann erneut `docker compose up --build`.

Startet Docker Desktop nicht oder beendet sich sofort wieder:

- **WSL 2 fehlt oder ist veraltet** — häufigste Ursache. In PowerShell als
  Administrator: `wsl --install`, danach `wsl --update`, Windows neu starten.
- **Virtualisierung ist im BIOS deaktiviert** — im Task-Manager unter
  *Leistung → CPU* muss „Virtualisierung: Aktiviert" stehen; sonst im BIOS/UEFI
  Intel VT-x bzw. AMD-V einschalten.
- **Windows- statt Linux-Container** — Rechtsklick auf das Wal-Symbol; falls
  *„Switch to Linux containers"* angeboten wird, anklicken.
- **Falscher Docker-Kontext** — `docker context ls`, dann
  `docker context use desktop-linux`.
- **Zurücksetzen** — Docker Desktop → Zahnrad → *Troubleshoot* → *Restart*.

Unter **macOS** gilt dasselbe: Docker Desktop muss geöffnet sein.
Unter **Linux** fehlt meist nur die Gruppenmitgliedschaft:
`sudo usermod -aG docker $USER`, danach ab- und wieder anmelden. Prüfen, ob der
Dienst läuft: `sudo systemctl status docker`.

**Der Build hängt bei `npm ci`**
Meist die Netzwerkverbindung zur npm-Registry. Abbrechen (`Strg+C`) und
`docker compose build --no-cache` erneut versuchen.

**„Datenbank nach 120 Sekunden nicht erreichbar"**
Selten, meist wenn der Rechner stark ausgelastet ist. `docker compose down`
und erneut `docker compose up` lösen es in der Regel.

**Anmeldung schlägt fehl**
Prüfen, ob im Protokoll „Administrator angelegt" steht. Falls die Datenbank aus
einem früheren Versuch stammt, hilft `docker compose down -v` und ein
Neustart.

**Beispieldaten fehlen**
Sie werden nur angelegt, wenn die Datenbank leer ist. Frisch aufsetzen mit
`docker compose down -v && docker compose up --build`.

**Apple Silicon (M1–M4)**
Läuft ohne Anpassung; alle verwendeten Images gibt es für arm64.

**`exec ./entrypoint.sh: no such file or directory` (Windows)**
Das Startskript hat Windows-Zeilenenden bekommen. Sollte durch
`.gitattributes` und den Build nicht mehr auftreten; falls doch:
`git config core.autocrlf false`, dann `git rm --cached -r . && git reset --hard`
und neu bauen.

**Änderungen am Code werden nicht sichtbar (Docker)**
Das Image enthält einen Produktions-Build. Nach Codeänderungen entweder
`docker compose up --build` oder besser Weg 2 (`npm run dev`) benutzen.

---

# Was als Nächstes?

- **Weiterbetrieb im Team:** [betrieb.md](betrieb.md) — inklusive der Variante,
  das ERP vollständig hinter einem VPN zu betreiben.
- **Wie es funktioniert:** [architektur.md](architektur.md)
- **Was jedes Modul kann:** [module/](module/)
