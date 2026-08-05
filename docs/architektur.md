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
    auth/                   # Anmeldung, Sitzungen, Rollen
    versand/                # DHL-Client, Label-/Tracking-Service
    integrationen/          # Shopify-Client, Import-Pipeline, Outbox-Runner, E-Mail
    shared/                 # Formatierung, Barcode, Formularauswertung, Adressen
  db/
    client.ts
    migrations/             # Schema UND Fachlogik (Buchungsfunktionen, Trigger)
```

Die fachlichen Module (Verkauf, Fertigung, Einkauf, Lager, Reparatur) leben
vollständig in `db/migrations` (Logik) und `app/(erp)/<modul>` (Seiten +
Server Actions) — sie brauchen keine eigene Zwischenschicht, weil die Actions
direkt die Postgres-Funktionen aufrufen.

### 2. Lagerbewegungen als einzige Wahrheit (Ledger-Prinzip)

Wie in Odoo ist **jede** Bestandsänderung eine `stock_moves`-Zeile „von Ort A nach Ort B" — auch Fertigung (→ virtueller Produktionsort), Inventur (→ Inventurdifferenz-Ort) und Ausschuss. Bestände werden **nie direkt geschrieben**, sondern aus erledigten Bewegungen abgeleitet (materialisiert in `stock_quants`, gepflegt per Trigger in derselben Transaktion). Damit sind Bestände jederzeit nachvollziehbar und ein Audit-Trail existiert gratis.

### 3. Belege mit Status-Maschinen (Odoo-Semantik)

Jeder Beleg (Verkaufsauftrag, Bestellung, Transfer, Fertigungsauftrag, Reparatur) hat ein `state`-Feld mit exakt den Odoo-18-Statuswerten und erlaubten Übergängen (siehe Modul-Spezifikationen). Statusübergänge laufen als Postgres-Funktion: Prüfung + Folgeaktionen (z. B. „Bestellung bestätigen" → Wareneingang anlegen) atomar.

### 4. Outbox-Pattern für Integrationen

Eingehend: Shopify-Webhooks werden nur **verifiziert und gespeichert** (Tabelle `shopify_webhook_events`, idempotent über die Webhook-/Order-ID), die Verarbeitung passiert asynchron per Job-Runner. Ausgehend: Seiteneffekte (Tag in Shopify setzen, E-Mail senden) werden als Job in `integration_jobs` geschrieben und mit Retry/Backoff abgearbeitet. Kein API-Call innerhalb einer DB-Transaktion.

### 5. Erweiterbarkeit

Vorgesehene, aber **nicht** im ersten Ausbau enthaltene Erweiterungen — das Datenmodell lässt sie zu, ohne Umbau:

- **Los-/Seriennummern**: `stock_move_lines`-Tabelle ist als Erweiterungspunkt beschrieben (Seriennummer je gefertigter Tastatur).
- **Mehrere Lagerhäuser**: `warehouses` existiert von Anfang an, UI geht zunächst von einem Lager aus.
- **Arbeitspläne/Arbeitsplätze** (Odoo Work Orders): `boms` bekommt später `bom_operations`; MO-Struktur ist darauf vorbereitet.
- **Buchhaltung**: Rechnungen sind eigenständige Belege; eine spätere Journal-/Konten-Schicht dockt an `vendor_bills`/`customer_invoices` an.
- **Kits (Bausatz-Stücklisten)**: `boms.bom_type` enthält `kit` bereits als Wert, Verhalten wird später implementiert.
- **Weitere Vertriebskanäle**: Der Shopify-Import läuft über eine generische Import-Pipeline (`source`-Feld am Verkaufsauftrag).
- **Versand-Ausbau**: Multicollo (mehrere Pakete je Lieferung — `shipments` ist 1:n modelliert), ZPL-Thermodruck, DHL-Tracking per Push-API statt Polling, weitere Carrier hinter einem Carrier-Interface, Zolldokumente für Nicht-EU-Versand.

## Sicherheit & Betrieb

- **Zugriffsschutz**: Die Anwendung ist die einzige Verbindung zur Datenbank; jede Seite und jede Server Action ruft `requireUser()` auf. Es gibt keinen direkten Datenbankzugang aus dem Browser, deshalb ersetzt das die RLS-Schicht. Zugangsdaten als scrypt-Hashes, Sitzungs-Token nur gehasht gespeichert.
- **Secrets**: Shopify-Token (`shpat_…`), Webhook-Secret, Resend-Key, DHL-API-Key/-Secret + GKP-Systembenutzer als Umgebungsvariablen; nie im Client. DHL-Systembenutzer-Passwort läuft nach 365 Tagen ab — Erinnerung einplanen.
- **Idempotenz**: Webhooks über `X-Shopify-Webhook-Id` + Order-ID; DHL-Label-Erstellung über Sendungs-Datensatz je Lieferung (kein Doppel-Label ohne vorherigen Storno).
- **Zeitzone/Währung**: Europe/Berlin, EUR (einwährungsfähig; `currency`-Spalten vorhanden).
- **Backups**: PITR bzw. regelmäßige Dumps aktivieren, sobald produktiv.
- **Deployment**: Varianten inkl. vollständigem VPN-Betrieb in [betrieb.md](betrieb.md).
