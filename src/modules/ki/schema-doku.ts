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
- **vendor_prices**: Lieferantenpreise je Template (vendor_id → partners, price, lead_time_days, min_qty).

### Lager (Bewegungs-Ledger — Kernprinzip: jede Bestandsänderung ist eine Zeile in stock_moves)
- **stock_locations**: Orte, full_path z. B. 'WH/Stock', 'Virtuell/Produktion', 'Virtuell/Inventurdifferenz', 'Virtuell/Ausschuss', 'Partner/Kunden', 'Partner/Lieferanten'.
- **stock_moves**: variant_id, qty (Soll), qty_done (Ist), src_location_id, dest_location_id, state ('draft','waiting','confirmed','assigned','done','cancel'), reference (z. B. 'Fertigmeldung', 'Komponentenverbrauch', 'Inventur'), date_done, picking_id, production_id (→ manufacturing_orders), unbuild_id, repair_id, inventory_id.
- **stock_pickings**: Transfers. number ('WH/IN/…', 'WH/OUT/…', 'WH/INT/…', 'WH/REP/…'), operation_type_id, state, partner_id, origin_model/origin_id (z. B. 'sales_order'), backorder_of_id, date_done.
- **stock_quants**: aktueller Bestand je (location_id, variant_id): on_hand, reserved. Nur über Funktionen gepflegt — für Auswertungen besser die Helfer nutzen:
  on_hand_qty(variant_id), free_to_use(variant_id), incoming_qty(variant_id), outgoing_qty(variant_id), forecasted_qty(variant_id).
- **inventory_counts**: Inventuren (counted_qty, book_qty, applied_at).

### Verkauf
- **sales_orders**: number ('S00001'), partner_id, state ('draft','sent','sale','cancel'), locked, delivery_status ('nothing','partial','full'), invoice_status, order_date, source ('manuell'|'shopify'), shopify_order_id/name, ship_*-Adressfelder. Summen: sales_order_total(order_id) → (net, tax, gross).
- **sales_order_lines**: order_id, variant_id, name, qty, qty_delivered, uom_id, price_unit, discount, tax_rate. Netto je Zeile: sale_line_subtotal(zeile).

### Fertigung
- **boms**: Stücklisten je Template (template_id, qty, consumption 'blocked'|'allowed'|'warning'). Auflösung je Variante: resolve_bom(variant_id) → bom_id.
- **bom_lines**: Positionen (component_variant_id, qty, uom_id). Variantenfilter: bom_line_variant_filters (bom_line_id, ptav_id) — Position gilt nur für Varianten mit dem Attributwert. Gefilterte Liste: bom_components_for_variant(bom_id, variant_id).
- **manufacturing_orders**: number ('MO/00001'), variant_id, qty_to_produce, qty_produced, state ('draft','confirmed','progress','to_close','done','cancel'), sales_order_id, backorder_of_id, date_done. Komponentenbedarf = stock_moves mit production_id und reference='Komponentenverbrauch'; Fertigmeldung = reference='Fertigmeldung'.
- **unbuild_orders**: Demontage (variant_id, qty, state).

### Einkauf
- **purchase_orders**: number ('P00001'), vendor_id → partners, state ('draft','sent','purchase','done','cancel'), order_deadline, confirmed_at, created_at, billing_status.
- **purchase_order_lines**: order_id, variant_id, qty, qty_received, qty_billed, uom_id, price_unit.
- **vendor_bills**: Lieferantenrechnungen (number 'BILL/…', vendor_id, purchase_order_id, state 'draft'|'posted'|'paid'|'cancel', total).
- **vendor_bill_lines**: Positionen.

### Reparatur & Versand
- **repair_orders**: number ('RMA/…'), partner_id, variant_id, state ('new','confirmed','under_repair','repaired','cancel').
- **repair_parts**: Teile (kind 'add'|'remove'|'recycle', variant_id, qty).
- **shipments**: DHL-Sendungen (shipment_number, picking_id, sales_order_id, state 'created'|'manifested'|'transit'|'delivered'|'failure'|'cancelled', tracking_url).
- **shipping_ready** (View): versandbereite Lieferungen (Lieferung 'assigned', keine offenen MOs).

### Sonstiges
- **audit_log**: Verlauf je Datensatz (model, record_id, kind 'state'|'note'|'email'|'error', message, actor, created_at).
- **sequences**: Nummernkreise. **integration_jobs**: Outbox für Shopify/E-Mail.

Konventionen: Geldwerte sind netto in EUR, sofern nicht anders benannt. 'state' immer als Text vergleichen. Monatsauswertungen mit date_trunc('month', …).
`
