# Master-Umsetzungsplan: ERP-Eigenentwicklung (Odoo-Nachbau)

**Ziel:** Die bei uns aktiv genutzten Odoo-Funktionen als eigene, schlanke Web-Anwendung nachbauen — Verkauf (mit Shopify-Import), Fertigung (Stücklisten mit Variantenlogik, druckbare Fertigungsaufträge), Einkauf (inkl. E-Mail-Versand und Lieferantenrechnungen), Lager (Bewegungs-Ledger, Inventur, Barcodes), Reparatur sowie Shopify/Sendcloud-Anbindung (`ready-to-ship`-Tag).

**Grundlage:** Das Zielverhalten wurde aus der offiziellen Odoo-18-Dokumentation erhoben (teilweise gegen den Odoo-Quellcode verifiziert) und liegt in [docs/odoo-referenz/](docs/odoo-referenz/) ab. Die fachlichen Spezifikationen je Modul stehen in [docs/module/](docs/module/), Architektur und Datenmodell in [docs/architektur.md](docs/architektur.md) und [docs/datenmodell.md](docs/datenmodell.md).

**Stack (Kurzfassung):** Next.js 15 (TypeScript) auf Vercel · Supabase (Postgres 17, Auth, Storage) · Drizzle ORM mit SQL-Migrationen · kritische Buchungslogik als Postgres-Funktionen · @react-pdf/renderer + bwip-js (PDFs/Barcodes) · Resend (E-Mail) · Outbox-Tabelle + Vercel Cron (Jobs). Begründungen: [docs/architektur.md](docs/architektur.md).

---

## Leitplanken für die Umsetzung

1. **Odoo-Semantik beibehalten:** Statuswerte, Übergänge und Buchungslogik exakt wie in den Referenzdokumenten — das Team kennt Odoo, die Umstellung soll sich vertraut anfühlen.
2. **Ledger zuerst:** Kein Feature schreibt Bestände direkt; alles läuft über `stock_moves` + Buchungsfunktionen. Diese Invariante wird ab Phase 2 per Test abgesichert und gilt für alle Folge-Phasen.
3. **Jede Phase endet lauffähig:** deploybar, mit erfüllten Abnahmekriterien (siehe Modul-Spezifikationen) und Seed-/Testdaten.
4. **Erweiterbarkeit:** Die in [docs/architektur.md](docs/architektur.md) genannten Erweiterungspunkte (Seriennummern, Kits, Arbeitspläne, Buchhaltung, weitere Kanäle, Sendcloud-Direkt-API) dürfen durch Implementierungsentscheidungen nicht verbaut werden.
5. **Deutsch als UI-Sprache**, Begriffe wie in Odoo-Deutsch (Stückliste, Fertigungsauftrag, Wareneingang, Demontageauftrag …).

---

## Phasen

### Phase 0 — Fundament
Projekt-Setup: Next.js + TypeScript + Drizzle + Supabase-Anbindung (neues Supabase-Projekt), Migrations-Workflow, Supabase Auth (E-Mail-Login, Rollen `admin`/`mitarbeiter`), RLS-Grundgerüst, App-Shell mit Modul-Navigation, `sequences` + `next_sequence()`, `audit_log` (Statuswechsel/Notizen je Beleg), CI (Lint, Typecheck, Tests), Vercel-Deployment.

**Fertig, wenn:** Login funktioniert, leere Modulseiten erreichbar, Migrationen + Seeds laufen, CI grün, Preview-Deployment steht.

### Phase 1 — Stammdaten
Spezifikation: [docs/module/stammdaten.md](docs/module/stammdaten.md)
Maßeinheiten (Kategorien, Umrechnung), Kontakte (Kunden/Lieferanten), Produkte mit Attributen → Variantengenerierung, SKU/Barcode je Variante, Lieferantenpreise, Einstellungsseiten (Attribute, UoM, Nummernkreise, Steuersätze). Seed: Tastatur-Produkt mit Farbvarianten + ~20 Komponenten-Produkte als realistische Testdaten.

### Phase 2 — Lager-Kern
Spezifikation: [docs/module/lager.md](docs/module/lager.md)
Lagerorte (Seed-Struktur), Vorgangsarten, Pickings + Moves mit Status-Maschine, Buchungsfunktionen (`validate_picking`, Reservierung, Storno, Retoure), `stock_quants`-Pflege, Bestandsliste + Bewegungsprotokoll, Inventur, Ausschuss, Backorder-Dialog. **Property-Test der Ledger-Invariante** (Bestand ≡ Summe der Moves).

### Phase 3 — Verkauf
Spezifikation: [docs/module/verkauf.md](docs/module/verkauf.md)
Verkaufsaufträge mit Odoo-18-Status-Maschine (+ `locked`-Flag), Positionen auf Variantenebene, `confirm_sales_order` mit automatischer Lieferung, Storno-Regeln, Liefer-/Abrechnungsstatus, Smart-Buttons. (MO-Erzeugung wird in Phase 4 aktiv, der Hook wird hier vorbereitet.)

### Phase 4 — Fertigung ★ Kernphase
Spezifikation: [docs/module/fertigung.md](docs/module/fertigung.md)
Stücklisten-Verwaltung inkl. **„Auf Varianten anwenden"** (Komponentenzeilen mit Attributwert-Filter, Vorschau je Variante), MO-Lebenszyklus mit Komponenten-Snapshot, Reservierung, `produce_mo` (Verbrauch + Zugang, flexible Verbrauchsregeln, Backorder), Demontageaufträge, **MO-Druck als PDF mit Code-128-Barcode**, Produkt-Etiketten, MTO-Verknüpfung Verkauf → Fertigung (Smart-Buttons in beide Richtungen).

### Phase 5 — Einkauf
Spezifikation: [docs/module/einkauf.md](docs/module/einkauf.md)
RFQ → Bestellung → Sperren/Stornieren, Bestell-PDF + **E-Mail-Versand an Lieferanten** (Resend, Outbox), automatischer Wareneingang bei Bestätigung, erhaltene/abgerechnete Mengen, Backorders, **Lieferantenrechnungen** (Richtlinien bestellt/erhalten, Buchen, Zahlung erfassen, Gutschrift), Dashboard-Filter (Zu senden / Wartend / Verspätet).

### Phase 6 — Shopify + Sendcloud ★ Kernphase
Spezifikation: [docs/module/integrationen.md](docs/module/integrationen.md)
Custom App + Webhook-Empfang (HMAC, Idempotenz), Import-Pipeline (Kunden-Upsert, SKU-Mapping mit Klärliste, Auftrag → automatisch Lieferung + MOs), Reconciliation-Cron, **`ready-to-ship`-Tag via `tagsAdd`** nach Fertigungsabschluss, Storno-Sync, Monitoring-Seite. Sendcloud über dessen Shopify-Integration (Variante A — kein eigener API-Code nötig).
*Voraussetzung (manuell, vorab): Shopify-Custom-App anlegen, Sendcloud-Versandregel auf den Tag einrichten.*

### Phase 7 — Reparatur
Spezifikation: [docs/module/reparatur.md](docs/module/reparatur.md)
Reparaturaufträge (Status-Maschine, Teile add/remove/recycle mit Bestandswirkung), Retoure-Flow vom Kunden, Rücklieferung, optionales Angebot bei kostenpflichtiger Reparatur.

### Phase 8 — Barcode-Workflows & Feinschliff
Scan-Feld-Integration in Lager-/Fertigungsmasken (Beleg öffnen, Mengen hochzählen), Etikettendruck-Framework (Produkt-/Lagerort-Etiketten), Nachschub-Hinweisliste (`forecasted < 0`), Übersichts-Dashboard (offene Aufträge/MOs/Eingänge, Fehlerjobs), Härtung (Fehlerzustände, Berechtigungen, Performance), Doku für das Team.

---

## Reihenfolge & Abhängigkeiten

```
Phase 0 ─▶ 1 ─▶ 2 ─▶ 3 ─▶ 4 ─▶ 6 ─▶ 8
                     └─▶ 5 ─────────┘   (Einkauf braucht nur Phase 2; parallel zu 3/4 möglich)
                          7 nach 2+3 (Reparatur braucht Lager + Verkauf/Retoure)
```

Empfohlene Ausführung: strikt sequenziell 0→1→2→3→4→6, dann 5, 7, 8 — so ist der kritische Pfad (Shopify-Order → Fertigung → ready-to-ship) am schnellsten produktiv.

## Getroffene Annahmen (bei Bedarf korrigieren)

1. **Eine Firma, ein Lager, EUR**, deutsche UI; Mehrlager/Währungen sind im Modell vorgesehen, aber ohne UI.
2. **Kundenrechnungen** entstehen nicht im ERP (Shopify rechnet ab); Lieferantenrechnungen sind enthalten. Buchhaltung (Konten/Journale) ist bewusst außen vor.
3. **Keine Los-/Seriennummern im ersten Ausbau** (Erweiterungspunkt ist im Datenmodell beschrieben — für Tastatur-Seriennummern später relevant).
4. **Fertigung 1-stufig** (Verbrauch direkt aus WH/Stock), keine Arbeitspläne/Arbeitsplätze — entspricht Odoos Standardeinstellung.
5. Sendcloud läuft über die **Sendcloud-Shopify-Integration** (Tag-gesteuert), nicht über die direkte API.
6. Versand-Trigger: Tag wird gesetzt, sobald **alle Fertigungsaufträge des Auftrags abgeschlossen** sind (bei Aufträgen ohne Fertigung: sobald die Lieferung reservierbar ist).

## Definition of Done (je Phase)

- Abnahmekriterien der zugehörigen Modul-Spezifikation erfüllt (manuell durchgespielt + automatisierte Tests für Buchungslogik).
- Migrationen idempotent, Seeds aktualisiert, RLS auf neuen Tabellen aktiv.
- Keine direkte Bestandsmutation außerhalb der Buchungsfunktionen (Code-Review-Checkpunkt).
- Deployment auf Vercel-Preview, kurzer Demo-Durchlauf dokumentiert im PR.
