/**
 * Kompakte Schemabeschreibung für den KI-Agenten. Manuell gepflegt —
 * bei Schemaänderungen bitte mitziehen (Quelle: src/db/migrations/).
 */
export const SCHEMA_DOKU = `
## Datenmodell (PostgreSQL)

Alle IDs sind UUIDs. Zeitstempel: timestamptz. Mengen: numeric.

### Stammdaten
- **partners**: Kunden & Lieferanten. Spalten: name, is_company, is_customer, is_vendor, email, phone, street, house_number, zip, city, country_code, vat, active.
- **uoms**: Maßeinheiten (name, category, factor). Umrechnung: uom_convert(qty, von_uom_id, nach_uom_id).
- **product_templates**: Produkte. name, uom_id, list_price (VK), standard_cost (Einstand), weight_g, can_be_sold, can_be_purchased, type ('goods'|'service'), route_manufacture, route_mto, route_buy, active.
- **product_variants**: Varianten je Template (template_id). sku, barcode, display_name, price_extra, active. Anzeigename: variant_display_name(variant_id).
- **product_attributes / product_attribute_values**: Attribute (z. B. Farbe) und Werte (z. B. Weiß).
- **product_template_attribute_values (ptav)** & **product_variant_attribute_values**: verknüpfen Varianten mit Attributwerten.
- **vendor_prices**: Lieferantenpreise je Template (vendor_id → partners, price, discount, lead_time_days, min_qty, date_start, date_end).
- **product_categories**: Produktkategorien (name, parent_id, full_path). **taxes**: Steuersätze (name, amount, type_tax_use 'sale'|'purchase'). **payment_terms**: Zahlungsbedingungen inkl. Skonto. **incoterms**: Lieferbedingungen.
- **tags** (kind 'partner'|'product'|'sale'|'repair') mit den Verknüpfungen partner_tag_links, product_tag_links, sales_order_tag_links, repair_order_tag_links.

### Lager (Bewegungs-Ledger — Kernprinzip: jede Bestandsänderung ist eine Zeile in stock_moves)
- **stock_locations**: Orte, full_path z. B. 'WH/Stock', 'Virtuell/Produktion', 'Virtuell/Inventurdifferenz', 'Virtuell/Ausschuss', 'Partner/Kunden', 'Partner/Lieferanten'.
- **stock_moves**: variant_id, qty (Soll), qty_done (Ist), src_location_id, dest_location_id, state ('draft','waiting','confirmed','assigned','done','cancel'), reference (z. B. 'Fertigmeldung', 'Komponentenverbrauch', 'Inventur'), date_done, picking_id, production_id (→ manufacturing_orders), unbuild_id, repair_id, inventory_id.
- **stock_pickings**: Transfers. number ('WH/IN/…', 'WH/OUT/…', 'WH/INT/…', 'WH/REP/…'), operation_type_id, state, partner_id, origin_model/origin_id (z. B. 'sales_order'), backorder_of_id, date_done.
- **stock_quants**: aktueller Bestand je (location_id, variant_id): on_hand, reserved. Nur über Funktionen gepflegt — für Auswertungen besser die Helfer nutzen:
  on_hand_qty(variant_id), free_to_use(variant_id), incoming_qty(variant_id), outgoing_qty(variant_id), forecasted_qty(variant_id).
- **inventory_counts**: Inventuren (counted_qty, book_qty, applied_at).
- **stock_orderpoints**: Meldebestände (variant_id, location_id, min_qty, max_qty, qty_multiple, route 'buy'|'manufacture', snoozed_until). Vorschläge: orderpoint_suggestions().

### Los- und Seriennummern
- **product_templates.tracking**: 'none'|'lot'|'serial'. Helfer: product_tracking(variant_id).
- **stock_lots**: Lose/Seriennummern (variant_id, name, ref, note). **move_lot_assignments**: (move_id, lot_id, qty) — welche Nummer in welcher Bewegung. **stock_lot_quants**: Bestand je (location_id, variant_id, lot_id).
- Rückverfolgung: von move_lot_assignments über stock_moves auf picking_id / production_id joinen.

### Bestandsbewertung (gleitender Durchschnitt / AVCO)
- **stock_valuation_layers**: unveränderliche Wertschichten. variant_id, move_id, layer_type ('receipt','issue','landed_cost','revaluation','production'), quantity (+Zugang/−Abgang), unit_cost, value, qty_after, value_after, note, created_at.
- **product_variants.moving_avg_cost / valued_qty / valuation_total**: fortgeschriebener Durchschnittspreis und Bestandswert. View **stock_value** (variant_id, product, sku, on_hand, valued_qty, moving_avg_cost, valuation_total, qty_difference).
- **landed_costs** + **landed_cost_allocations**: Einstandsnebenkosten (Fracht, Zoll) verteilt nach basis 'weight'|'value'|'quantity'.
- **currencies** / **exchange_rates**: Fremdwährung; Kurs zum Stichtag: exchange_rate_at(code, datum). purchase_orders.exchange_rate friert den Kurs bei Bestätigung ein.

### Verkauf
- **sales_orders**: number ('S00001'), partner_id, state ('draft','sent','sale','cancel'), locked, delivery_status ('nothing','partial','full'), invoice_status, order_date, source ('manuell'|'shopify'), shopify_order_id/name, ship_*-Adressfelder. Summen: sales_order_total(order_id) → (net, tax, gross).
- **sales_order_lines**: order_id, variant_id, name, qty, qty_delivered, uom_id, price_unit, discount, tax_rate. Netto je Zeile: sale_line_subtotal(zeile).

### Fertigung
- **boms**: Stücklisten je Template (template_id, qty, bom_type 'manufacture'|'kit', consumption 'blocked'|'allowed'|'warning'). Auflösung je Variante: resolve_bom(variant_id) → bom_id (nur 'manufacture'), resolve_kit(variant_id) → bom_id (nur 'kit'/Phantom).
- **bom_lines**: Positionen (component_variant_id, qty, uom_id, issue_method 'backflush'|'manual'). Variantenfilter: bom_line_variant_filters (bom_line_id, ptav_id) — Position gilt nur für Varianten mit dem Attributwert. Einstufig gefilterte Liste: bom_components_for_variant(bom_id, variant_id); **mehrstufig mit aufgelösten Baugruppen: bom_explode(bom_id, variant_id, menge)** → (component_variant_id, qty, uom_id, issue_method, depth, phantom_path).
- **work_centers**: Arbeitsplätze (code, name, cost_per_hour, capacity, time_efficiency). **bom_operations**: Arbeitsgänge der Stückliste (name, work_center_id, duration_minutes je Referenzmenge, setup_minutes je Auftrag).
- **mo_operations**: Arbeitsgänge des Auftrags (mo_id, name, work_center_id, cost_per_hour als Schnappschuss, duration_expected, duration_real, state 'pending'|'progress'|'done'|'cancel', date_start, date_done, user_id). Lohnkosten: mo_labor_cost(mo_id).
- **manufacturing_orders**: number ('MO/00001'), variant_id, qty_to_produce, qty_produced, state ('draft','confirmed','progress','to_close','done','cancel'), sales_order_id, backorder_of_id, date_done, material_cost, labor_cost, unit_cost. Komponentenbedarf = stock_moves mit production_id und reference='Komponentenverbrauch' (mit issue_method und phantom_path); Fertigmeldung = reference='Fertigmeldung'.
- View **production_cost**: je erledigtem Auftrag number, product, qty_produced, material_cost, labor_cost, total_cost, unit_cost, minutes.
- **unbuild_orders**: Demontage (variant_id, qty, state).

### Einkauf
- **purchase_orders**: number ('P00001'), vendor_id → partners, state ('draft','sent','purchase','done','cancel'), order_deadline, confirmed_at, created_at, billing_status.
- **purchase_order_lines**: order_id, variant_id, qty, qty_received, qty_billed, uom_id, price_unit.
- **vendor_bills**: Lieferantenrechnungen (number 'BILL/…', vendor_id, purchase_order_id, state 'draft'|'posted'|'paid'|'cancel', total).
- **vendor_bill_lines**: Positionen.

### Personal
- **employees**: Mitarbeiter (number 'MA0001', name, barcode = Ausweis, job_title, department, employment_type 'full_time'|'part_time'|'mini_job'|'temp'|'apprentice', hourly_cost = Personalkostensatz je Stunde, weekly_hours, vacation_days, hire_date, exit_date, active, user_id → users).
- **time_entries**: Zeiterfassung (employee_id, kind 'attendance'|'production', mo_operation_id, started_at, ended_at, break_minutes, minutes = Nettodauer, hourly_cost als Schnappschuss). Helfer: employee_minutes(employee_id, von, bis). View **employees_present** (wer ist gerade angemeldet), View **time_sheet** (Minuten und Kosten je Mitarbeiter, Tag und Art).
- **shift_templates** (code, name, start_time, end_time, break_minutes) und **shift_assignments** (employee_id, template_id, work_center_id, starts_at, ends_at, state 'draft'|'published'|'cancel'). Überschneidungen sind per Ausschluss-Constraint unmöglich.
- **absences**: Abwesenheiten (kind 'vacation'|'sick'|'training'|'unpaid'|'other', starts_on, ends_on, half_day, state 'requested'|'approved'|'rejected'|'cancel', reason, decided_by, decided_at). Arbeitstage: absence_days(id).

### Reparatur & Versand
- **repair_orders**: number ('RMA/…'), partner_id, variant_id, state ('new','confirmed','under_repair','repaired','cancel').
- **repair_parts**: Teile (kind 'add'|'remove'|'recycle', variant_id, qty).
- **shipments**: DHL-Sendungen (shipment_number, picking_id, sales_order_id, state 'created'|'manifested'|'transit'|'delivered'|'failure'|'cancelled', tracking_url).
- **shipping_ready** (View): versandbereite Lieferungen (Lieferung 'assigned', keine offenen MOs).

### Sonstiges
- **audit_log**: Verlauf je Datensatz (model, record_id, kind 'state'|'note'|'email'|'error', message, actor, created_at).
- **sequences**: Nummernkreise. **integration_jobs**: Outbox für Shopify/E-Mail (nicht abfragbar).
- **api_transactions**: Protokoll aller Aufrufe an Shopify/DHL/Mail (system, kind, reference, ok, status_code, error, duration_ms, created_at).

Konventionen: Geldwerte sind netto in EUR, sofern nicht anders benannt. 'state' immer als Text vergleichen. Monatsauswertungen mit date_trunc('month', …).
`
