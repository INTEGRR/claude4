# Architektur

## Tech-Stack

| Baustein | Wahl | Begründung |
|---|---|---|
| Frontend + Backend | **Next.js (App Router, TypeScript)** — gehostet oder selbst betrieben | Ein Deployment für UI + API; Route Handler liefern den Raw Body für Shopify-HMAC; Route Handler liefern den Raw Body für die Shopify-HMAC-Prüfung; Betrieb wahlweise auf Vercel oder auf einem eigenen Host hinter VPN (siehe [betrieb.md](betrieb.md)) |
| Datenbank | **Postgres 16+** (Supabase oder selbst betrieben) | Relationales ERP-Datenmodell; Transaktionen für Bestandsbuchungen; Team hat bestehende Supabase-Projekte |
| Auth | **eigenständig** (scrypt-Hashes, Cookie-Sitzungen in Postgres) | Rund 150 Zeilen in `src/modules/auth`, dafür läuft das System ohne externen Anbieter — auch vollständig im privaten Netz (siehe [betrieb.md](betrieb.md)). Austauschbar, weil alle Aufrufer nur `currentUser()` / `requireUser()` kennen |
| Datenzugriff / Migrationen | **postgres.js + eigener Migrations-Runner** (SQL-Dateien im Repo) | SQL-first: die Fachlogik liegt ohnehin in Postgres-Funktionen, die von Hand geschrieben werden müssen. Ein ORM daneben wäre eine zweite Schema-Wahrheit ohne Gegenwert. Der Runner sichert Migrationen über Prüfsummen gegen nachträgliche Änderungen ab |
| Kritische Buchungslogik | **Postgres-Funktionen** (aus Server Actions aufgerufen) | Bestandsbuchungen, Belegnummern und Statusübergänge laufen atomar in der DB — kein halb gebuchter Zustand |
| Belege | **Druckoptimierte HTML-Ansichten** (`@media print`) | Fertigungsauftrag und Etiketten drucken direkt aus dem Browser — kein PDF-Rendering im Server, dieselbe Darstellung am Bildschirm wie auf Papier |
| Barcodes | **bwip-js** (Code 128) | Barcode auf MO-Beleg/Etiketten; gleiche Codes werden von USB-Scannern (Keyboard-Wedge) gelesen |
| E-Mail-Versand | **Resend + React Email** | Bestellungen an Lieferanten, Retourenlabel an Kunden; Vorlagen als React-Komponenten |
| Versand | **DHL Parcel DE Shipping API v2** (eigener typisierter Client, OAuth2 ROPC) | Labels, Tracking (Unified API), Retouren direkt bei DHL — kein Sendcloud dazwischen |
| Hintergrund-Jobs | **Postgres-Job-Tabelle (Outbox) + Cron** (Vercel Cron oder systemd-Timer) | Webhook-Verarbeitung entkoppelt vom Empfang; ausgehende Aufrufe mit Backoff wiederholt; kein zusätzlicher Infrastruktur-Baustein |

Bewusst **nicht** im ersten Ausbau: Redis/Queues, Microservices, Multi-Tenant, Buchhaltung (nur Belege, keine Journalbuchungen).

**Hinweis zum Datenzugriff:** `prepare: false` ist gesetzt. Prepared Statements
brechen zum einen mit dem Supabase-Pooler im Transaction-Mode, zum anderen
zeigen zwischengespeicherte Statements nach Migrationen, die Enums neu anlegen,
auf verschwundene Typ-OIDs.

## Architekturprinzipien

### 1. Modularer Monolith

Eine Codebasis, klar getrennte Module — analog zu Odoo-Apps. Jedes Modul hat eigene Routen, Server Actions, DB-Tabellen(-Präfixe) und Spezifikation. Module kommunizieren über definierte Service-Funktionen, nicht über fremde Tabellen.

```
src/
  app/                      # Next.js App Router (Seiten je Modul)
    (erp)/
      verkauf/
      einkauf/
      lager/
      fertigung/
      reparatur/
      einstellungen/
    api/
      webhooks/shopify/     # Route Handler (Raw Body, HMAC)
      cron/                 # Reconciliation, Job-Runner
  components/               # Wiederverwendete UI-Bausteine
  modules/
    prozesse/               # DAS HERZSTÜCK (~9.000 Z.): Aktions-Registry,
                            # Torwächter, Introspektion, Maskengenerierung,
                            # Prozess-Fixtures
    ki/                     # Chat-Agent (Anthropic), Sprachmodus (OpenAI
                            # Realtime/Whisper), KI-Anlagekatalog
    integrationen/          # Shopify-Client, Import-Pipeline, Outbox-Runner, E-Mail
    versand/                # DHL-Client, Label-/Tracking-Service, Versandregeln
    demo/                   # Beispieldaten + Betriebshistorie
    auth/                   # Anmeldung, Sitzungen, Rollen
    lager/                  # Daten-TÜV (Invariantenprüfung)
    shared/                 # Formatierung, Barcode, Formularauswertung, Adressen
    befehle.ts              # Katalog fürs Befehlsfeld
  db/
    client.ts
    migrations/             # Schema UND Fachlogik (Buchungsfunktionen, Trigger)
```

### Wo liegt die Logik eines Fachmoduls?

Es gibt bewusst KEIN `modules/verkauf/`. Die Fachbereiche verteilen sich nach
Zuständigkeit auf drei Orte — das ist die wichtigste Regel für alle, die neu
dazukommen:

| Was | Wo | Beispiel |
|---|---|---|
| **Schreiben** | `modules/prozesse/registry/<bereich>.ts` (Katalog, DB-frei) + `<bereich>-ausfuehren.ts` (Ausführung) | `verkauf.bestaetigen` |
| **Buchen** | `db/migrations/*.sql` — atomare Statusübergänge und Bestandsbuchungen | `confirm_sales_order()` |
| **Lesen** | `app/(erp)/<bereich>/**/page.tsx` — Server Components fragen direkt ab | Auftragsliste |

Jeder Schreibvorgang läuft über den **Torwächter**
(`aktionAusfuehrenGeprueft`), nie über eine freie Server Action — siehe
[prozesse.md](prozesse.md) und die Regel in [AGENTS.md](../AGENTS.md).
Ein Wächter-Test (`tests/prozess-registry.test.ts`) erzwingt das; Ausnahmen
stehen dort als geschlossene, nur schrumpfende Liste.

Die aktuelle Fassung einer SQL-Funktion findet man mit
`npm run funktion <name>` — Migrationen sind unveränderlich, deshalb liegen
31 Funktionen in mehreren Fassungen vor und `grep` liefert überwiegend tote
Treffer.

### 1b. Fachliche Fehler werden zurückgegeben, nicht geworfen

Next.js schwärzt in Produktionsbauten jeden Fehler, der aus einer Server Action geworfen wird — beim Benutzer kommt nur eine React-Fehlernummer an. Genau diese Meldungen („Erledigte Transfers können nicht storniert werden", „Bestand reicht nicht") sind aber der Kern der Bedienung: Sie stammen aus `raise exception` in den Postgres-Funktionen und sagen dem Lager, was zu tun ist.

Deshalb gilt im ganzen Haus: Server Actions **geben** fachliche Fehler zurück (`actionError(...)`, `actionFail(err)` aus `src/modules/shared/action.ts`); `ActionButton` und `ActionForm` zeigen sie an. Geworfen wird nur, was wirklich ein Programmfehler ist. `tests/actions.test.ts` wacht darüber, dass niemand wieder wirft.

### 1c. Materialisierte Sichten rufen keine SQL-Funktionen auf

PostgreSQL 17 legt materialisierte Sichten mit eingeschränktem `search_path` an und aktualisiert sie ebenso. Eine eingebettete SQL-Funktion — etwa `on_hand_qty()` — findet dabei ihre eigenen Tabellen nicht mehr, und `CREATE MATERIALIZED VIEW` scheitert mit „relation … does not exist". Auf PostgreSQL 16 fällt das nicht auf; der Docker-Stack fährt aber 17.

Deshalb: In den `mv_*`-Sichten stehen Verbunde statt Funktionsaufrufe. Das ist ohnehin schneller, weil die Funktion sonst je Zeile liefe. Die Testsuite läuft gegen dieselbe Version wie der Container (siehe `docker-compose.yml`), damit solche Unterschiede auffallen.

### 2. Lagerbewegungen als einzige Wahrheit (Ledger-Prinzip)

Wie in Odoo ist **jede** Bestandsänderung eine `stock_moves`-Zeile „von Ort A nach Ort B" — auch Fertigung (→ virtueller Produktionsort), Inventur (→ Inventurdifferenz-Ort) und Ausschuss. Bestände werden **nie direkt geschrieben**, sondern aus erledigten Bewegungen abgeleitet (materialisiert in `stock_quants`, gepflegt per Trigger in derselben Transaktion). Damit sind Bestände jederzeit nachvollziehbar und ein Audit-Trail existiert gratis.

### 3. Belege mit Status-Maschinen (Odoo-Semantik)

Jeder Beleg (Verkaufsauftrag, Bestellung, Transfer, Fertigungsauftrag, Reparatur) hat ein `state`-Feld mit exakt den Odoo-18-Statuswerten und erlaubten Übergängen (siehe Modul-Spezifikationen). Statusübergänge laufen als Postgres-Funktion: Prüfung + Folgeaktionen (z. B. „Bestellung bestätigen" → Wareneingang anlegen) atomar.

### 4. Outbox-Pattern für Integrationen

Eingehend: Shopify-Webhooks werden nur **verifiziert und gespeichert** (Tabelle `shopify_webhook_events`, idempotent über die Webhook-/Order-ID), die Verarbeitung passiert asynchron per Job-Runner. Ausgehend: Seiteneffekte (Tag in Shopify setzen, E-Mail senden) werden als Job in `integration_jobs` geschrieben und mit Retry/Backoff abgearbeitet. Kein API-Call innerhalb einer DB-Transaktion.

### 5. Weiterentwicklung seit dem Gründungsstand

Dieses Dokument beschreibt das Fundament (Stand Anfang August 2026). Seither
dazugekommen — jeweils dokumentiert in [prozesse.md](prozesse.md) und
begründet im [Entscheidungslog](entscheidungen.md):

- **Prozess-ERP** (2026-08-16, der große Umbau): jede fachliche Aktion läuft
  über die Aktions-Registry und den **Torwächter** (`aktionAusfuehrenGeprueft`
  — zod-Validierung, Rollen/Befugnisse, Audit) als einzigen Schreibweg;
  Prozesse sind Daten in der DB, Masken werden aus Schritten generiert, die
  Navigation ist eine Projektion der aktiven Prozesse (Chamäleon).
- **Los-/Seriennummern, Arbeitsplätze/Arbeitsgänge, Kits/Phantom-Baugruppen,
  Befugnisse** — die früher hier als „später" gelisteten Punkte sind gebaut.
- **Finanzmodul** (Zahlungen, Verträge, Darlehen/Steuern, 13-Wochen-Prognose)
  und **KRNL-Marke** (2026-08-17).
- **KI-Schicht**: Chat-Agent mit Read-only-SQL und rechtegesteuerter
  Schema-Doku, **Sprachmodus** (OpenAI Realtime, Sammeln statt
  Sofort-Buchen) als Kern-Einstieg (2026-08-18/19).
- **Schutzschicht für den Kundenbetrieb** (2026-08-19): Instanz pro Kunde,
  Migrations-Wächter, nächtlicher Daten-TÜV.

Weiterhin bewusst offen: Buchhaltung (Journal-/Konten-Schicht dockt an die
Belege an), Multicollo/ZPL/weitere Carrier, weitere Vertriebskanäle (die
Import-Pipeline ist generisch, `source`-Feld am Verkaufsauftrag).

## Sicherheit & Betrieb

- **Zugriffsschutz**: Die Anwendung ist die einzige Verbindung zur Datenbank; jede Seite und jede Server Action ruft `requireUser()` auf. Es gibt keinen direkten Datenbankzugang aus dem Browser, deshalb ersetzt das die RLS-Schicht. Zugangsdaten als scrypt-Hashes, Sitzungs-Token nur gehasht gespeichert.
- **Secrets**: Shopify-Token (`shpat_…`), Webhook-Secret, Resend-Key, DHL-API-Key/-Secret + GKP-Systembenutzer als Umgebungsvariablen; nie im Client. DHL-Systembenutzer-Passwort läuft nach 365 Tagen ab — Erinnerung einplanen.
- **Idempotenz**: Webhooks über `X-Shopify-Webhook-Id` + Order-ID; DHL-Label-Erstellung über Sendungs-Datensatz je Lieferung (kein Doppel-Label ohne vorherigen Storno).
- **Zeitzone/Währung**: Europe/Berlin, EUR (einwährungsfähig; `currency`-Spalten vorhanden).
- **Backups & Kundenbetrieb**: PITR je Projekt + Restore-Proben, Instanz pro
  Kunde, Update-Ringe — siehe „Schutzschicht" in [prozesse.md](prozesse.md)
  und das [Entscheidungslog](entscheidungen.md) (2026-08-19).
- **Deployment**: Varianten inkl. vollständigem VPN-Betrieb in [betrieb.md](betrieb.md).
