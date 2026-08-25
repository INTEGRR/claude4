# Datenübernahme aus Odoo 18 (ANVIL → KRNL)

ANVIL zieht von Odoo 18 Enterprise (Odoo.sh) nach KRNL um — **alle Daten,
inklusive Historie**, wiederholbar: Probeläufe lokal, der finale Lauf am
Stichtag mit frischem Dump auf die leergeräumte Prod-Instanz. Diese Datei
ist Fachdoku UND Betriebsanleitung der Übernahme; die Begründungen der
Grundsatzentscheidungen stehen im
[Entscheidungslog 2026-08-25](entscheidungen.md).

## Quelle und Bestandsaufnahme

Quelle ist ein **Odoo.sh-Datenbank-Dump** (neutralisiert, ohne Filestore —
die Daten sind vollständig, nur Mail-Server/Crons/Tokens sind entschärft;
Binärdateien wie Produktbilder liegen im Filestore und werden nicht
übernommen, KRNL hat dafür kein Zielmodell — Shopify bleibt Bildquelle).

Fachlich genutzt sind von 269 installierten Modulen nur Verkauf, Lager,
Fertigung, etwas Einkauf und Reparatur — der Umfang deckt sich fast 1:1
mit KRNL. Kernzahlen des Analyse-Dumps (2026-08-24): 1.881 Partner ·
75 Produktvorlagen / 506 Varianten · 1.875 Verkaufsaufträge (davon ~77
offen) · 31 Bestellungen · 1.754 Fertigungsaufträge (12 offen) · 1.958
Transfers (~95 offen) · 8 Reparaturen · **keine Lose/Seriennummern** ·
nur 4 Eingangsrechnungen (die 935 übrigen account_moves sind automatische
Journalbuchungen). Odoo bewertet nach **Standardpreis** (kein AVCO), die
Standardkosten sind nur bei 42 von 506 Varianten gepflegt. Die
Shopify-Verknüpfung liegt in Studio-Feldern (`x_studio_shopify_customer_id`,
`x_studio_shopify_order_number`) plus der numerischen Order-ID in
`client_order_ref`.

## Architektur des Importers

```
Odoo.sh-Dump (dump.sql)
   │  psql -f                                 lokale Staging-DB „odoo_quelle"
   ▼                                          (zweite DB derselben Instanz)
scripts/odoo-import.ts ── liest ──► Staging ── schreibt ──► KRNL-Ziel-DB
   (CLI, Phasen, Report)                        (lokal oder Supabase via DIRECT_URL)
```

- **Wartungsskript, keine Registry-Aktion**: Der Import läuft vor dem
  Betrieb gegen die Wartungsverbindung (`wartungsUrl()`), wie
  `scripts/seed.ts`. Abnahme-Instanz ist der **Daten-TÜV**
  (`src/modules/lager/daten-tuev.ts`), nicht der Torwächter.
- **Mapping-Anker `odoo_verweise`** (Migration 0073): je Odoo-Datensatz
  der entstandene KRNL-Datensatz — macht jede Phase zum idempotenten
  Upsert. Shopify-IDs gehen zusätzlich als GIDs in die dedizierten
  Spalten (`partners.shopify_customer_id`, `sales_orders.shopify_order_id`
  + `shopify_order_name`), damit der Shopify-Sync nach dem Umstieg keine
  Duplikate anlegt.
- Modulschnitt nach dem Vorbild des Demodaten-Seeders
  (`src/modules/demo/daten.ts` — pure Module, `sql` injiziert):
  `src/modules/migration/odoo/quelle.ts` (Lese-Queries),
  `mapper.ts` (pure Umformungen, unit-getestet), `import.ts`
  (Phasen + Upserts), `verifikation.ts` (Zähl-/Summenabgleich).

### Staging laden

```bash
createdb -h 127.0.0.1 -p 5433 -U erp odoo_quelle
psql -h 127.0.0.1 -p 5433 -U erp -d odoo_quelle -q \
  -v ON_ERROR_STOP=0 -f dump.sql
```

`ON_ERROR_STOP=0`, weil der Dump Owner-/Extension-Statements der
Odoo.sh-Umgebung enthält, die lokal scheitern dürfen (z. B. pgvector für
Odoos KI-Embeddings). psql ≥ 16 nötig (`\restrict`-Meta-Kommando). Das
Importskript verifiziert die Zeilenzahlen der Kerntabellen selbst.

### Aufruf

```bash
ODOO_QUELLE_URL=postgres://erp:erp@127.0.0.1:5433/odoo_quelle \
npm run odoo:import -- [--dry-run] [--nur-phase=<name>] [--bis-phase=<name>] [--lauf=<label>]
```

Ziel-Verbindung über `DIRECT_URL` (bevorzugt) bzw. `DATABASE_URL` — für
Supabase zwingend der Session-Port, nicht der Transaction-Pooler.
`--dry-run` fährt den kompletten Lauf in einer Transaktion und rollt am
Ende zurück; der Report wird vorher erhoben und trotzdem ausgegeben.

## Die Phasen

| # | Phase | Mechanik |
|---|---|---|
| 0 | Vorbedingung | Ziel frisch migriert + `db:seed` ohne `--demo`; Abbruch, wenn Produkte ohne `odoo_verweise`-Herkunft existieren; Firmendaten aus `res_company`. |
| 1 | Stammdaten | Einheiten (Namens-Match auf Seeds, **ratio = 1/odoo.factor**), genutzte Steuern, Zahlungsbedingungen, Kategorien, Partner (inkl. `splitStreet()` für die DHL-Hausnummer, Shopify-GID). |
| 2 | Produkte | Attribute → Vorlagen → `generate_variants()` → Varianten-Matching über Attributwertmengen → SKU/Barcode, Lieferantenpreise, Stücklisten, Arbeitsplätze, Meldebestände. |
| 3 | Belege flach | Abgeschlossene Historie **im Endzustand, ohne Pickings/Moves**, Rückschreibefelder (`qty_delivered` …) direkt gesetzt, Original-Belegnummern. Offene Belege nur als Entwurf. |
| 4 | Eingangsrechnungen | Die 4 `in_invoice` flach nach `vendor_bills`. |
| 5 | Kosten | `standard_cost` je Vorlage über die Fallback-Kette (Layer-Restwert → standard_price → jüngster EUR-Lieferantenpreis → 0 + Warnung). **Zwingend vor dem Bestand**: `move_done` bewertet den Zugang sofort mit dem dann gültigen Satz. |
| 6 | Bestand + Bewertung | Je Variante Σ interner Odoo-Bestand → `inventory_counts` → `inventory_apply()` (der einzige legitime Bestands-Schreibweg; idempotent gegen den Ist-Bestand), dann `valuation_initialize(null, 'odoo-import')` für Unbewertetes. Der KRNL-Bestandswert liegt ÜBER dem Odoo-Restwert: Odoo hatte durch das lückenhaft gepflegte Standardpreis-Verfahren große Bestände mit 0-Bewertung — KRNL bewertet konsistent. |
| 7 | Offene durchbuchen | `confirm_purchase_order` / `confirm_sales_order` / `mo_confirm` / `repair_confirm` — es entstehen echte Lieferungen, Reservierungen und MTO-Fertigungsaufträge. |
| 8 | Abschluss | Nummernkreise über `sequences.next_number` hochziehen, MO-Präfix auf `WH/MO/`, `refresh_analytics()`, **`datenTuev()` als harte Abnahme** (Befund = Exit ≠ 0). |

### Zustands-Mapping und Klassifikation

Die Enums decken sich weitgehend (KRNL ist als Odoo-Nachbau gebaut) — die
Abweichungen: `to invoice → to_invoice` (Leerzeichen), einkaufsseitig
`no/to invoice/invoiced → nothing/waiting/fully_billed`, Reparatur
`draft → new`, `done → repaired`, Rechnung `posted + in_payment/paid →
paid`. Unbekannte Werte brechen den Lauf ab, statt still gemappt zu werden.

Klassifikation je Beleg (Phase 3): Verkauf `sale` + Lieferstatus
`full`/leer → flach erledigt (leer = nur nicht-lagergeführte Zeilen,
Warnhinweis); `sale` + `pending` → Entwurf für Phase 7; Storno → flach
`cancel` (ohne `cancel_sales_order` — es gab nie Logistik dazu). Einkauf:
`purchase`/`done` voll empfangen → flach, sonst Entwurf für Phase 7.
Fertigung/Reparatur: nur `done`/`cancel` flach, Offenes macht Phase 7 über
die echten Funktionen. Bewusst nicht abbildbar: die vier abgeschlossenen
Odoo-Reparaturen ohne Produktangabe (in KRNL Pflicht) und der leere
Rechnungsentwurf ohne Lieferant — beides steht auf der Warnliste.

**Warum flach + durchbuchen statt alles nachbuchen:** Bestände,
Wertschichten, Belegstatus und Kennzahlen leiten sich in KRNL voneinander
ab. 1.834 historische Lieferungen einzeln nachzubuchen wäre langsam und
fehlerträchtig — und für abgeschlossene Vorgänge ohne Nutzen. Der
Präzedenzfall ist die Shopify-Erstübernahme
(`src/modules/integrationen/import.ts`): Historie flach, damit keine
hunderten offenen Vorgänge für längst gelieferte Ware entstehen. Was noch
offen ist, läuft dagegen durch die echten Buchungsfunktionen, damit
Reservierungen und Folgebelege stimmen.

## Bewusst nicht übernommen

- Produktbilder/Anhänge (kein Zielmodell; Shopify bleibt Bildquelle)
- 935 automatische Journalbuchungen (`account_move` Typ `entry`) und die
  eine Ausgangsrechnung im Entwurf (kein Zielmodell; Notiz am Auftrag)
- Benutzerkonten (Passwörter/Rollen inkompatibel — werden manuell angelegt)
- 10 historische Arbeitsgänge, 11 Ausschussbuchungen (Wirkung steckt im
  Endbestand), das `x_out_of_stock_alert`-Log (KRNL-Meldebestände ersetzen es)
- Preislisten (in Odoo ungenutzt — 1 Eintrag)

## Verifikation

Nach jedem Lauf (auch Dry-Run) erzeugt `verifikation.ts` einen Report:
Zählabgleich je Entität und Zustand, Bestandsmenge und -wert je Variante
Odoo ↔ KRNL, offene Auftrags-/Bestellmengen, Umsatz je Monat als
Plausibilitätskurve, Liste „bewusst ausgelassen". Harte Abnahme ist
`datenTuev()` (Ledger-Invarianten). Probelauf-Choreografie lokal:
`db:reset` → `db:migrate` → `db:seed` → Import `--dry-run` → echter Lauf →
Report → zweiter Lauf (No-Op-Beweis) → erst dann Prod.

## Cutover-Runbook (Stichtag)

Wird mit dem letzten Arbeitspaket der Umsetzung vervollständigt. Gerüst:

1. Odoo einfrieren (Benutzer sperren, Shopify-Odoo-Anbindung deaktivieren;
   der Shop läuft weiter — Bestellungen der Zwischenzeit holt später der
   KRNL-Backfill).
2. Frischen Dump ziehen, Staging neu laden (`dropdb` → `createdb` → `psql`).
3. Supabase-Backup/PITR-Punkt setzen (Rollback-Pfad).
4. KRNL-Prod leerräumen (`demodaten_loeschen()` — erhält Konfiguration,
   Benutzer und Prozesse; räumt auch `odoo_verweise`). **Achtung:** Die
   Schichtvorlagen (FRUEH/SPAET/…, Seeds aus 0022) stehen nicht in der
   Behalten-Liste und werden mit abgeräumt — nach dem Leerräumen unter
   Personal → Schichten neu anlegen, falls gebraucht.
5. Import gegen Prod (`DIRECT_URL`), Shopify-Umgebungsvariablen ungesetzt.
6. Report + `datenTuev()` grün — sonst Restore.
7. Shopify-Kopplung: zuerst Produkt-Import (SKU-Match setzt
   `shopify_variant_id`), dann Webhooks; Order-Backfill nur ab Stichtag.
8. Benutzerkonten anlegen, Odoo auf lesend/Archiv.
