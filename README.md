# ERP — Eigenentwicklung (Odoo-Nachbau)

Schlankes ERP, das die bei uns genutzten Odoo-Funktionen nachbaut:

- **Verkauf** — Verkaufsaufträge (v. a. aus Shopify), Bestätigung erzeugt Lieferung und Fertigungsauftrag
- **Fertigung** — Produkte mit Varianten, Stücklisten inkl. **„Auf Varianten anwenden"**, Fertigungsaufträge (druckbar, mit Barcode), Demontage
- **Einkauf** — Lieferanten, Bestellungen (E-Mail-Versand, Sperren, Stornieren), Wareneingang, Lieferantenrechnungen
- **Lager** — Bewegungs-Ledger (Eingang, Ausgang, Fertigung, Inventur, Ausschuss, Retoure), Bestände mit Prognose, Barcodes
- **Reparatur** — Reparaturaufträge mit Teileverbrauch (einbauen / ausbauen / wiederverwenden)
- **Versand** — DHL-Direktanbindung (Label, Tracking, Retouren) und Fulfillment-Rückmeldung an Shopify
- **Scanner-Arbeitsplatz** — Belege per Barcode öffnen, Positionen scannen, Doppelscan bestätigt und bucht
- **Auswertungen** — Inventarwert, Produktion je Variante, verbaute Komponenten, Abverkaufsquote — mit Diagrammen
- **KI-Analyse** — Ad-hoc-Auswertungen auf Zuruf: Claude-Agent mit Nur-Lese-Zugriff auf die Datenbank
- **Rollen & Kommentare** — Lager-/Fertigungs-/Büro-/Admin-Rollen mit passendem Menü; Verlauf + Kommentare an jedem Beleg
- **Beschaffung** — Meldebestände (Min/Max) mit Vorschlagsliste; ein Klick erzeugt Bestellung oder Fertigungsauftrag
- **Lose & Seriennummern** — Rückverfolgung je Produkt (Chargen oder Serien), FIFO-Zuteilung, Rückverfolgungsansicht
- **Ereignis-Monitor** — jede Shopify-/DHL-/Mail-Transaktion protokolliert; Queue mit Backoff, Fehler am Beleg sichtbar
- **Vollständige Stammdaten** — Kategorien, Steuern, Zahlungsbedingungen (inkl. Skonto), Incoterms, Tags, Kontakt-Hierarchie

> **Ausführliche Schritt-für-Schritt-Anleitung mit Rundgang durch die
> Beispieldaten und Fehlerbehebung: [docs/lokal-starten.md](docs/lokal-starten.md)**

## Schnellstart mit Docker (empfohlen zum Ausprobieren)

Voraussetzung ist nur Docker Desktop bzw. Docker Engine mit Compose:

```bash
docker compose up --build
```

Beim ersten Start werden Datenbank, Schema, Administrator und Beispieldaten
angelegt — das dauert ein paar Minuten. Danach:

**<http://localhost:3000>** · `admin@example.com` / `erp-admin`

Zum Ausprobieren der Rollen liegen zwei weitere Demo-Konten bei:
`lager@example.com` und `fertigung@example.com` (Passwort jeweils wie beim Administrator).

Ist Port 3000 belegt: `ERP_PORT=3001 docker compose up --build`
(Windows PowerShell: `$env:ERP_PORT=3001; docker compose up --build`).

```bash
docker compose down       # anhalten (Daten bleiben erhalten)
docker compose down -v    # anhalten und alle Daten verwerfen
docker compose logs -f app
```

## Schnellstart ohne Docker

Voraussetzung: Node 22+ und ein erreichbarer PostgreSQL 16+.

```bash
npm install
cp .env.example .env          # DATABASE_URL eintragen
npm run db:migrate            # Schema anlegen
npm run db:seed -- --demo     # Administrator + Beispieldaten
npm run dev                   # http://localhost:3000
```

Anmeldung mit den beim Seed ausgegebenen Zugangsdaten
(Standard: `admin@example.com` / `erp-admin` — bitte danach ändern).

Die Beispieldaten enthalten eine Tastatur mit drei Farbvarianten und eine
Stückliste mit 20 Positionen, in der Gehäuse und Keycaps je Farbe gefiltert
sind. Damit lässt sich der Kernablauf sofort durchspielen:
Auftrag bestätigen → Fertigungsauftrag prüfen (nur die passenden Farbteile) →
fertig melden → Lieferung wird versandbereit.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklungsserver |
| `npm run build` / `npm start` | Produktions-Build und -Start |
| `npm run db:migrate` | Ausstehende Migrationen einspielen |
| `npm run db:reset` | Schema verwerfen und neu aufbauen (nur Entwicklung) |
| `npm run db:seed [-- --demo]` | Administrator anlegen, optional Beispieldaten |
| `npm test` | Tests (brauchen eine erreichbare Datenbank) |
| `npm run check` | Typprüfung + Tests |

## Dokumente

| Dokument | Inhalt |
|---|---|
| [docs/lokal-starten.md](docs/lokal-starten.md) | **Lokal starten** — vollständige Anleitung inkl. Rundgang und Fehlerbehebung |
| [PLAN.md](PLAN.md) | Umsetzungsplan mit Phasen und Abnahmekriterien |
| [docs/architektur.md](docs/architektur.md) | Tech-Stack, Prinzipien, Projektstruktur, Erweiterbarkeit |
| [docs/datenmodell.md](docs/datenmodell.md) | Datenbankschema |
| [docs/betrieb.md](docs/betrieb.md) | Deployment (auch hinter VPN), Cron-Aufgaben, Betriebspflichten |
| [docs/module/](docs/module/) | Fachliche Spezifikation je Modul |
| [docs/odoo-referenz/](docs/odoo-referenz/) | Recherche aus der offiziellen Odoo-18-Dokumentation |
| [docs/api-referenz/](docs/api-referenz/) | Shopify- und DHL-APIs, Sendcloud-Funktionsumfang als Nachbau-Vorlage |

## Aufbau

```
src/
  app/(erp)/…      Seiten je Modul (Server Components + Server Actions)
  app/api/…        Webhooks, Cron, Barcode-Auflösung, Label-Auslieferung
  db/migrations/   SQL-Migrationen — Schema UND Fachlogik
  modules/         auth, integrationen (Shopify), versand (DHL), shared
tests/             Tests gegen eine echte Postgres-Datenbank
```

Die Buchungslogik liegt bewusst als Postgres-Funktionen in den Migrationen:
Bestandsbuchungen, Statusübergänge und Belegnummern laufen damit atomar in
einer Transaktion. Die Anwendungsschicht ruft sie auf und kümmert sich um
Anmeldung, Eingabeprüfung und Darstellung.

**Grundregel:** Jede Bestandsänderung ist eine Bewegung in `stock_moves`.
Bestände werden nie direkt geschrieben, sondern aus erledigten Bewegungen
fortgeschrieben — abgesichert durch einen Invariantentest.
