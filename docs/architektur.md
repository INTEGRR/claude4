# Architektur

## Tech-Stack

| Baustein | Wahl | Begründung |
|---|---|---|
| Frontend + Backend | **Next.js 15 (App Router, TypeScript)** auf **Vercel** | Ein Deployment für UI + API; Route Handler liefern den Raw Body für Shopify-HMAC; Vercel Cron für Reconciliation-Jobs; Stack ist im Team etabliert |
| Datenbank | **Supabase Postgres (17)** | Relationales ERP-Datenmodell; Transaktionen für Bestandsbuchungen; Team hat bestehende Supabase-Projekte |
| Auth | **Supabase Auth** | E-Mail-Login für das Team, Session-Handling out of the box |
| ORM / Migrationen | **Drizzle ORM + drizzle-kit** (SQL-Migrationen im Repo) | Typsichere Queries in Server Actions; Migrationen versioniert im Git |
| Kritische Buchungslogik | **Postgres-Funktionen** (über Drizzle/RPC aufgerufen) | Bestandsbuchungen, Belegnummern und Statusübergänge laufen atomar in der DB — kein halb gebuchter Zustand |
| PDF-Erzeugung | **@react-pdf/renderer** (serverseitig) | Fertigungsauftrag-Beleg, Bestell-PDF, Etiketten |
| Barcodes | **bwip-js** (Code 128) | Barcode auf MO-Beleg/Etiketten; gleiche Codes werden von USB-Scannern (Keyboard-Wedge) gelesen |
| E-Mail-Versand | **Resend + React Email** | Bestellungen an Lieferanten, Retourenlabel an Kunden; Vorlagen als React-Komponenten |
| Versand | **DHL Parcel DE Shipping API v2** (eigener typisierter Client, OAuth2 ROPC) | Labels, Tracking (Unified API), Retouren direkt bei DHL — kein Sendcloud dazwischen |
| Hintergrund-Jobs | **Postgres-Job-Tabelle (Outbox) + Vercel Cron** | Webhook-Verarbeitung entkoppelt vom Empfang; Shopify-Tag-Pushes mit Retry; kein zusätzlicher Infrastruktur-Baustein |

Bewusst **nicht** im ersten Ausbau: Redis/Queues, Microservices, Multi-Tenant, Buchhaltung (nur Belege, keine Journalbuchungen).

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
  modules/
    stammdaten/             # Produkte, Varianten, Attribute, UoM, Partner
    lager/                  # Locations, Pickings, Moves, Bestände, Inventur
    verkauf/
    einkauf/
    fertigung/
    reparatur/
    versand/                # DHL (Label, Tracking, Retouren), Shopify-Fulfillment
    integrationen/          # Shopify-Import, E-Mail
    shared/                 # Belegnummern, Status-Maschinen, PDF, Barcode
  db/
    schema/                 # Drizzle-Schema je Modul
    migrations/
    functions/              # SQL: Buchungsfunktionen, Trigger
```

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

- **RLS**: Alle Tabellen mit Row Level Security; Zugriff nur für authentifizierte Teammitglieder (Single-Tenant, Rollen `admin`/`mitarbeiter` als App-Metadata). Service-Role-Key nur serverseitig.
- **Secrets**: Shopify-Token (`shpat_…`), Webhook-Secret, Resend-Key, DHL-API-Key/-Secret + GKP-Systembenutzer als Vercel-Env-Vars; nie im Client. DHL-Systembenutzer-Passwort läuft nach 365 Tagen ab — Erinnerung einplanen.
- **Idempotenz**: Webhooks über `X-Shopify-Webhook-Id` + Order-ID; DHL-Label-Erstellung über Sendungs-Datensatz je Lieferung (kein Doppel-Label ohne vorherigen Storno).
- **Zeitzone/Währung**: Europe/Berlin, EUR (einwährungsfähig; `currency`-Spalten vorhanden).
- **Backups**: Supabase PITR aktivieren, sobald produktiv.
