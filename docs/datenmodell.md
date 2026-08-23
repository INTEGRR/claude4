# Datenmodell (Postgres / Supabase)

> **Stand:** Gründungsmodell (Migrationen 0001–0030). Maßgeblich ist immer
> `src/db/migrations/`; das stets aktuelle, wächter-geprüfte
> Tabelleninventar (inkl. Prozesse, Finanzen, Sprachmodus) steht in
> `src/modules/ki/schema-doku.ts` — ein Test gleicht es gegen die echte
> Datenbank ab. Konzepte der späteren Ausbauten: [prozesse.md](prozesse.md).

Notation: vereinfachtes SQL. Alle Tabellen bekommen zusätzlich `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz`. Enums als Postgres-Enums. Mengen als `numeric(16,4)`, Preise als `numeric(16,2)`.

Die Statuswerte übernehmen bewusst die **technischen Odoo-18-Werte** (siehe `docs/odoo-referenz/`), damit Verhalten 1:1 vergleichbar bleibt.

---

## 1. Gemeinsames

```sql
-- Belegnummernkreise: S00001, P00001, WH/IN/00001, MO/00001, …
create table sequences (
  code        text unique not null,   -- 'sale', 'purchase', 'receipt', 'delivery', 'internal', 'mo', 'unbuild', 'repair', 'bill'
  prefix      text not null,          -- 'S', 'P', 'WH/IN/', 'MO/', …
  padding     int  not null default 5,
  next_number int  not null default 1
);
-- Vergabe ausschließlich über SQL-Funktion next_sequence(code) mit row lock (atomar).

-- Ausgehende Jobs (Outbox): Shopify-Fulfillment, E-Mail senden, …
create table integration_jobs (
  kind        text not null,          -- 'shopify_fulfillment_create', 'shopify_tracking_update', 'send_po_email', 'send_return_label_email', …
  payload     jsonb not null,
  status      text not null default 'pending',  -- pending | running | done | failed
  attempts    int not null default 0,
  last_error  text,
  next_run_at timestamptz not null default now()
);
```

## 2. Stammdaten

```sql
create table uom_categories ( name text not null );          -- 'Einheit', 'Gewicht', 'Länge'

create table uoms (
  category_id  uuid references uom_categories not null,
  name         text not null,                                -- 'Stück', 'g', 'kg', 'm'
  ratio        numeric(16,6) not null default 1,             -- Faktor zur Referenzeinheit der Kategorie
  is_reference boolean not null default false,
  rounding     numeric(16,6) not null default 0.01
);
-- Umrechnung nur innerhalb derselben Kategorie (Odoo-Regel).

create table partners (                                      -- Kunden UND Lieferanten (Odoo: res.partner)
  name        text not null,
  is_company  boolean not null default false,
  is_customer boolean not null default false,
  is_vendor   boolean not null default false,
  email       text, phone text,
  street text, street2 text, zip text, city text, country_code text,
  vat         text,                                          -- USt-ID
  payment_terms_days int,
  shopify_customer_id text unique,                           -- Mapping für Import
  notes       text,
  active      boolean not null default true
);

create table product_templates (                             -- Odoo: product.template
  name            text not null,
  type            text not null default 'goods',             -- goods | service (lagergeführt nur goods)
  uom_id          uuid references uoms not null,             -- Verkauf/Lager-Einheit
  purchase_uom_id uuid references uoms,                      -- Einkaufseinheit (gleiche Kategorie!)
  list_price      numeric(16,2) not null default 0,
  standard_cost   numeric(16,2) not null default 0,
  invoice_policy  text not null default 'order',             -- order | delivery
  bill_policy     text not null default 'received',          -- purchase: ordered | received
  route_mto         boolean not null default false,          -- „Replenish on Order"
  route_manufacture boolean not null default false,
  route_buy         boolean not null default false,
  can_be_sold      boolean not null default true,
  can_be_purchased boolean not null default false,
  description     text,
  active          boolean not null default true
);

create table product_attributes (                            -- 'Farbe', 'Switch', 'Layout'
  name         text not null,
  display_type text not null default 'select'                -- select | radio | color | pills
);

create table product_attribute_values (                      -- 'Weiß', 'Schwarz', 'Blau'
  attribute_id uuid references product_attributes not null,
  name         text not null,
  html_color   text,
  sequence     int not null default 10
);

-- Zuordnung Attribut(werte) → Produktvorlage; Varianten = kartesisches Produkt
create table product_template_attribute_lines (
  template_id  uuid references product_templates not null,
  attribute_id uuid references product_attributes not null,
  unique (template_id, attribute_id)
);
create table product_template_attribute_values (             -- Odoo: product.template.attribute.value
  line_id      uuid references product_template_attribute_lines not null,
  value_id     uuid references product_attribute_values not null,
  price_extra  numeric(16,2) not null default 0,
  unique (line_id, value_id)
);

create table product_variants (                              -- Odoo: product.product — DIE Einheit für Bestand & Belege
  template_id uuid references product_templates not null,
  sku         text unique,                                   -- Muss der Shopify-SKU entsprechen (Mapping-Schlüssel!)
  barcode     text unique,                                   -- EAN/Code-128-Inhalt
  shopify_variant_id text unique,
  active      boolean not null default true
);
create table product_variant_attribute_values (              -- welche Werte diese Variante definiert
  variant_id uuid references product_variants not null,
  ptav_id    uuid references product_template_attribute_values not null,
  unique (variant_id, ptav_id)
);
-- Produkte OHNE Varianten bekommen genau eine Variante ohne Attributwerte (vereinfacht alle Belege).

create table vendor_prices (                                 -- Odoo: product.supplierinfo
  vendor_id   uuid references partners not null,
  template_id uuid references product_templates not null,
  variant_id  uuid references product_variants,              -- optional variantenspezifisch
  min_qty     numeric(16,4) not null default 0,
  price       numeric(16,2) not null,
  currency    text not null default 'EUR',
  lead_time_days int not null default 0,
  vendor_product_code text,
  sequence    int not null default 10                        -- Priorität bei mehreren Lieferanten
);
```

## 3. Lager

```sql
create type location_type as enum ('internal','vendor','customer','view','inventory_loss','production','transit');

create table warehouses ( name text not null, code text unique not null );  -- initial: 1 Lager 'WH'

create table stock_locations (
  warehouse_id uuid references warehouses,
  parent_id    uuid references stock_locations,
  name         text not null,                                -- 'Stock', 'Eingang', …
  full_path    text not null,                                -- 'WH/Stock' (per Trigger gepflegt)
  type         location_type not null,
  is_scrap     boolean not null default false,
  barcode      text unique
);
-- Seed: WH/Stock (internal), Partner/Lieferanten (vendor), Partner/Kunden (customer),
--       Virtuell/Produktion (production), Virtuell/Inventurdifferenz (inventory_loss),
--       Virtuell/Ausschuss (inventory_loss + is_scrap).

create type picking_kind as enum ('receipt','delivery','internal','repair');
create table operation_types (
  kind             picking_kind not null,
  name             text not null,                            -- 'Wareneingang', 'Warenausgang', …
  sequence_code    text not null,                            -- Verweis auf sequences.code
  default_src_id   uuid references stock_locations,
  default_dest_id  uuid references stock_locations,
  backorder_policy text not null default 'ask',              -- ask | always | never
  reservation      text not null default 'at_confirm',       -- at_confirm | manual
  return_type_id   uuid references operation_types
);

create type picking_state as enum ('draft','waiting','confirmed','assigned','done','cancel');
create table stock_pickings (                                -- Transfers (Odoo: stock.picking)
  number            text unique not null,                    -- 'WH/IN/00001'
  operation_type_id uuid references operation_types not null,
  state             picking_state not null default 'draft',
  partner_id        uuid references partners,
  scheduled_date    timestamptz,
  date_done         timestamptz,
  origin_model      text,                                    -- 'sales_order' | 'purchase_order' | 'repair_order' | …
  -- Seit 0072 tragen auch sales_orders und vorgaenge origin_model/origin_id/
  -- origin_label: die Herkunft am Kind ist die Grundlage der Teilprozess-
  -- Verkettung (Angebots-Vorgang → Auftrag → Lieferung).
  origin_id         uuid,                                    -- Quellbeleg (Source Document)
  backorder_of_id   uuid references stock_pickings,
  return_of_id      uuid references stock_pickings,          -- Retoure zu erledigtem Transfer
  note              text
);

create type move_state as enum ('draft','waiting','confirmed','assigned','done','cancel');
create table stock_moves (                                   -- DAS Ledger. Jede Bestandsänderung ist ein Move.
  picking_id      uuid references stock_pickings,            -- null bei MO-/Unbuild-/Inventur-Moves
  production_id   uuid,                                      -- FK auf manufacturing_orders (Verbrauch/Zugang)
  unbuild_id      uuid,
  repair_id       uuid,
  variant_id      uuid references product_variants not null,
  uom_id          uuid references uoms not null,
  qty             numeric(16,4) not null,                    -- Bedarf (Demand)
  qty_done        numeric(16,4) not null default 0,
  reserved_qty    numeric(16,4) not null default 0,
  src_location_id  uuid references stock_locations not null,
  dest_location_id uuid references stock_locations not null,
  state           move_state not null default 'draft',
  date_done       timestamptz
);
-- Erweiterungspunkt (später): stock_move_lines für Los-/Seriennummern je Move.

create table stock_quants (                                  -- materialisierter Bestand je (Ort, Variante)
  location_id uuid references stock_locations not null,
  variant_id  uuid references product_variants not null,
  on_hand     numeric(16,4) not null default 0,
  reserved    numeric(16,4) not null default 0,
  unique (location_id, variant_id)
);
-- Pflege ausschließlich durch SQL-Funktionen: move_done(), move_reserve(), move_cancel().
-- on_hand zählt nur an internal-Orten als „unser Bestand"; forecasted wird als View
-- aus offenen Eingängen/Ausgängen (confirmed/assigned Moves) berechnet.

create table inventory_counts (                              -- Inventur / Bestandskorrektur
  location_id uuid references stock_locations not null,
  variant_id  uuid references product_variants not null,
  counted_qty numeric(16,4) not null,
  applied_at  timestamptz,
  applied_by  uuid,
  move_id     uuid references stock_moves                    -- die erzeugte Korrekturbuchung
);
```

## 4. Verkauf

```sql
create type sale_state as enum ('draft','sent','sale','cancel');
create table sales_orders (                                  -- Odoo: sale.order
  number          text unique not null,                      -- 'S00001'
  state           sale_state not null default 'draft',
  locked          boolean not null default false,            -- Odoo 18: Sperren ist Flag, kein Status
  partner_id      uuid references partners not null,
  order_date      timestamptz not null default now(),
  delivery_status text,                                      -- pending | started | partial | full (berechnet)
  invoice_status  text not null default 'no',                -- no | to_invoice | invoiced
  source          text not null default 'manual',            -- manual | shopify
  shopify_order_id   text unique,
  shopify_order_name text,                                   -- '#1001'
  shopify_tags_pushed text[],                                -- optional gesetzte Info-Tags (Feature default aus)
  currency        text not null default 'EUR',
  note            text
);

create table sales_order_lines (
  order_id     uuid references sales_orders not null,
  sequence     int not null default 10,
  variant_id   uuid references product_variants,             -- null bei display_type-Zeilen
  display_type text,                                         -- null | 'section' | 'note'
  name         text not null,                                -- Beschreibung
  qty          numeric(16,4) not null default 0,
  uom_id       uuid references uoms,
  price_unit   numeric(16,2) not null default 0,
  discount     numeric(5,2) not null default 0,
  tax_rate     numeric(5,2) not null default 19,
  qty_delivered numeric(16,4) not null default 0,            -- aus validierten Lieferungen
  qty_invoiced  numeric(16,4) not null default 0
);
```

## 5. Einkauf

```sql
create type purchase_state as enum ('draft','sent','purchase','done','cancel');  -- done = Locked (Odoo)
create table purchase_orders (
  number           text unique not null,                     -- 'P00001'
  state            purchase_state not null default 'draft',
  vendor_id        uuid references partners not null,
  vendor_reference text,
  order_deadline   timestamptz,
  expected_arrival timestamptz,                              -- deadline + lead_time
  confirmed_at     timestamptz,
  billing_status   text not null default 'nothing',          -- nothing | waiting | fully_billed
  currency         text not null default 'EUR',
  note             text
);

create table purchase_order_lines (
  order_id     uuid references purchase_orders not null,
  sequence     int not null default 10,
  variant_id   uuid references product_variants not null,
  name         text not null,
  qty          numeric(16,4) not null,
  uom_id       uuid references uoms not null,                -- Einkaufseinheit
  price_unit   numeric(16,2) not null,
  tax_rate     numeric(5,2) not null default 19,
  qty_received numeric(16,4) not null default 0,             -- aus validierten Wareneingängen
  qty_billed   numeric(16,4) not null default 0              -- aus gebuchten Rechnungen
);

create type bill_state as enum ('draft','posted','paid','cancel');
create table vendor_bills (
  number       text unique not null,                         -- 'BILL/00001'
  purchase_order_id uuid references purchase_orders,
  vendor_id    uuid references partners not null,
  state        bill_state not null default 'draft',
  bill_date    date,
  due_date     date,
  vendor_bill_reference text,                                -- Rechnungsnr. des Lieferanten
  is_credit_note boolean not null default false,             -- Gutschrift (Storno gebuchter Rechnungen)
  reversed_bill_id uuid references vendor_bills,
  currency     text not null default 'EUR'
);
create table vendor_bill_lines (
  bill_id    uuid references vendor_bills not null,
  po_line_id uuid references purchase_order_lines,
  name       text not null,
  qty        numeric(16,4) not null,
  price_unit numeric(16,2) not null,
  tax_rate   numeric(5,2) not null default 19
);
```

## 6. Fertigung

```sql
create type bom_type as enum ('manufacture','kit');          -- kit: vorgesehen, Umsetzung später
create table boms (                                          -- Odoo: mrp.bom
  template_id uuid references product_templates not null,
  variant_id  uuid references product_variants,              -- NUR wenn BoM exklusiv für eine Variante; sonst null
  qty         numeric(16,4) not null default 1,              -- Referenzmenge
  uom_id      uuid references uoms not null,
  bom_type    bom_type not null default 'manufacture',
  consumption text not null default 'warning',               -- blocked | allowed | warning (Abweichung vom Soll)
  active      boolean not null default true
);

create table bom_lines (                                     -- ~20 Positionen je Tastatur-BoM
  bom_id       uuid references boms not null,
  sequence     int not null default 10,
  component_variant_id uuid references product_variants not null,
  qty          numeric(16,4) not null,
  uom_id       uuid references uoms not null,
  manual_consumption boolean not null default false
);

-- ★ „Auf Varianten anwenden" (Apply on Variants):
-- Ohne Einträge gilt die Zeile für ALLE Varianten. Mit Einträgen nur für Varianten,
-- die mindestens einen der verknüpften Attributwerte tragen.
create table bom_line_variant_filters (
  bom_line_id uuid references bom_lines not null,
  ptav_id     uuid references product_template_attribute_values not null,
  unique (bom_line_id, ptav_id)
);

create type mo_state as enum ('draft','confirmed','progress','to_close','done','cancel');
create table manufacturing_orders (                          -- Odoo: mrp.production
  number       text unique not null,                         -- 'MO/00001'
  variant_id   uuid references product_variants not null,    -- konkrete Variante wird gefertigt
  bom_id       uuid references boms not null,
  qty_to_produce numeric(16,4) not null,
  qty_produced   numeric(16,4) not null default 0,
  uom_id       uuid references uoms not null,
  state        mo_state not null default 'draft',
  scheduled_date timestamptz,
  date_done    timestamptz,
  sales_order_id uuid references sales_orders,               -- Quellbeleg bei MTO (Smart-Button-Verknüpfung)
  backorder_of_id uuid references manufacturing_orders,
  note         text
);
-- Komponentenbedarf wird bei MO-Anlage aus der BoM „eingefroren":
-- gefilterte bom_lines (Apply-on-Variants gegen die Werte der MO-Variante) → stock_moves
-- mit production_id = MO, src = WH/Stock, dest = Virtuell/Produktion.
-- Fertigprodukt-Zugang: 1 Move Virtuell/Produktion → WH/Stock.

create table unbuild_orders (                                -- Demontage
  number     text unique not null,                           -- 'UB/00001'
  variant_id uuid references product_variants not null,
  bom_id     uuid references boms not null,
  qty        numeric(16,4) not null,
  mo_id      uuid references manufacturing_orders,
  src_location_id  uuid references stock_locations not null, -- wo das Produkt liegt
  dest_location_id uuid references stock_locations not null, -- wohin die Komponenten
  state      text not null default 'draft'                   -- draft | done
);
```

## 7. Reparatur

```sql
create type repair_state as enum ('new','confirmed','under_repair','repaired','cancel');
create table repair_orders (
  number       text unique not null,                         -- 'RMA/00001'
  partner_id   uuid references partners not null,
  variant_id   uuid references product_variants not null,    -- zu reparierendes Produkt
  qty          numeric(16,4) not null default 1,
  under_warranty boolean not null default false,
  state        repair_state not null default 'new',
  scheduled_date timestamptz,
  responsible  uuid,                                         -- auth.users
  return_picking_id uuid references stock_pickings,          -- Retoure vom Kunden
  sales_order_id uuid references sales_orders,               -- erzeugtes Angebot bei kostenpflichtiger Reparatur
  note         text
);

create type repair_part_type as enum ('add','remove','recycle');
create table repair_parts (
  repair_id  uuid references repair_orders not null,
  part_type  repair_part_type not null,
  variant_id uuid references product_variants not null,
  qty        numeric(16,4) not null,
  qty_done   numeric(16,4) not null default 0,
  uom_id     uuid references uoms not null
);
```

## 8. Versand (DHL)

```sql
create type shipment_state as enum ('created','manifested','transit','delivered','failure','cancelled');
create table shipments (                                     -- 1..n je Lieferung (Multicollo-Erweiterung vorgesehen)
  picking_id      uuid references stock_pickings not null,   -- die Lieferung (WH/OUT)
  sales_order_id  uuid references sales_orders,
  carrier         text not null default 'dhl',
  dhl_product     text not null,                             -- 'V01PAK' | 'V54EPAK' | 'V53WPAK' | …
  billing_number  text not null,
  weight_g        int not null,
  shipment_number text unique,                               -- = Trackingnummer (aus DHL-Response)
  tracking_url    text,
  state           shipment_state not null default 'created',
  label_path      text,                                      -- Supabase Storage (DHL hält Labels nur ~3 Tage vor)
  label_format    text not null default '910-300-700',
  dhl_warnings    jsonb,                                     -- weiche Adressvalidierung der DHL-Response
  last_tracking_event jsonb,                                 -- 30 Tage nach Zustellung löschen (DHL-Auflage)
  shopify_fulfillment_id text,                               -- nach fulfillmentCreate
  manifested_at   timestamptz,
  delivered_at    timestamptz
);

create table return_labels (                                 -- DHL-Retourenlabels (Reparatur/Retoure)
  repair_order_id uuid references repair_orders,
  sales_order_id  uuid references sales_orders,
  partner_id      uuid references partners not null,
  shipment_number text unique,                               -- 'RET…'
  label_path      text,                                      -- PDF im Storage
  qr_link         text,
  emailed_at      timestamptz
);
```

## 9. Shopify-Integration

```sql
create table shopify_webhook_events (
  webhook_id  text unique not null,                          -- X-Shopify-Webhook-Id (Idempotenz)
  topic       text not null,                                 -- 'orders/create', 'orders/paid', …
  shopify_order_id text,
  payload     jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status      text not null default 'pending',               -- pending | done | failed | skipped
  error       text
);

create table shopify_sync_state (
  key   text unique not null,                                -- 'last_reconciliation_at'
  value jsonb not null
);

create table shopify_unmatched_lines (                       -- Zeilen ohne SKU-Treffer → manuelle Klärung
  event_id   uuid references shopify_webhook_events not null,
  shopify_order_id text not null,
  sku        text,
  title      text,
  qty        numeric(16,4),
  resolved_at timestamptz
);
```

---

## Berechnete Größen (Views/Funktionen)

| Größe | Definition |
|---|---|
| `on_hand(variant)` | Σ `stock_quants.on_hand` über interne Orte |
| `free_to_use` | on_hand − reserved |
| `incoming` / `outgoing` | Σ offener Moves (state in confirmed/assigned) nach/von internen Orten |
| `forecasted` | on_hand + incoming − outgoing |
| `sales_orders.delivery_status` | aus Pickings des Auftrags (keins done = pending, teils = partial, alle = full) |
| `purchase_orders.billing_status` | gemäß `bill_policy` (siehe `docs/odoo-referenz/einkauf.md`) |

## Kritische SQL-Funktionen (alle atomar, `security definer`)

| Funktion | Zweck |
|---|---|
| `next_sequence(code)` | Belegnummer ziehen (row lock) |
| `confirm_sales_order(id)` | Status → sale; Lieferung anlegen; je `route_manufacture`-Position MO anlegen |
| `cancel_sales_order(id)` | Status → cancel; offene Lieferungen stornieren; verknüpfte MOs markieren (Warnhinweis, kein Auto-Storno — Odoo-Verhalten) |
| `confirm_purchase_order(id)` | Status → purchase; Wareneingang anlegen |
| `validate_picking(id, done_lines, backorder?)` | Moves buchen, Quants aktualisieren, qty_received/qty_delivered zurückschreiben, ggf. Backorder-Picking erzeugen; bei Shopify-Lieferung mit Sendung: `shopify_fulfillment_create`-Job einreihen |
| `confirm_mo(id)` / `produce_mo(id, qty)` | Komponenten reservieren / Verbrauch + Zugang buchen, ggf. MO-Backorder; bei verknüpftem SO: wenn alle MOs fertig ⇒ Lieferung reservieren („versandbereit") |
| `unbuild(id)` | Fertigprodukt −, Komponenten + (mit Negativbestands-Warnung) |
| `apply_inventory_count(id)` | Korrektur-Move gegen Inventurdifferenz-Ort |
| `repair_transition(id, action)` | Reparatur-Statusmaschine inkl. Teile-Buchungen |

## 9. Erweiterungen aus dem zweiten Ausbau (Migrationen 0011–0017)

Dieses Dokument beschreibt den Kernstand. Später ergänzt (Details in
[module/odoo-vervollstaendigung.md](module/odoo-vervollstaendigung.md) und
den Migrationen selbst — die Migrationen sind die verbindliche Quelle):

- **0011** Rollen `lager`/`fertigung` (user_role)
- **0012** `product_categories`, `taxes`, `payment_terms`, `incoterms`,
  `tags` (+ vier Link-Tabellen), `bom_byproducts`; Zusatzfelder an
  `partners` (Hierarchie/Typ, Verkäufer, Zahlungsbedingungen, …),
  `product_templates` (Kategorie, Steuern, sale_delay, HS-Code, …),
  `vendor_prices` (Rabatt, Gültigkeit)
- **0013/0014** Statuswerte `started`/`upselling`/`by_date`; Belegfelder
  auf Verkauf/Einkauf/Rechnung/Transfer/MO/Reparatur inkl. Kit-Explosion,
  Steuer-Schnappschuss, 3-Way-Matching, Fälligkeit aus Zahlungsbedingung
- **0015** `stock_orderpoints` + `orderpoint_suggestions()/execute()`
- **0016** `api_transactions` (Ereignis-Monitor), Queue-Härtung
  (`last_result`, `started_at`, `reap_stuck_jobs()`), Webhook-Backoff
- **0017** `stock_lots`, `move_lot_assignments`, `stock_lot_quants`,
  `tracking` am Produkt; `move_done`/`mo_produce` um die Los-Dimension
