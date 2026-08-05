# Odoo 18 — Modul Verkauf (Sales): Feature-Zusammenfassung für einen Nachbau

## 1. Lebenszyklus / Status eines Verkaufsauftrags (`sale.order`)

Odoo behandelt Angebot und Verkaufsauftrag als **dasselbe Objekt** (`sale.order`) — nur das Statusfeld unterscheidet sie. Statusfeld `state` in Odoo 18 (verifiziert im offiziellen Quellcode, Branch 18.0):

| Technischer Wert | Anzeigename | Bedeutung |
|---|---|---|
| `draft` | **Quotation** (Angebot/Entwurf) | Neu angelegter Beleg, frei editierbar |
| `sent` | **Quotation Sent** (Angebot gesendet) | Angebot wurde per E-Mail an den Kunden geschickt |
| `sale` | **Sales Order** (Verkaufsauftrag) | Bestätigt; löst Logistik/Beschaffung aus, abrechenbar |
| `cancel` | **Cancelled** (Abgebrochen) | Storniert |

**Wichtig:** Der frühere Status `done` („Locked/Gesperrt") existiert in Odoo 18 **nicht mehr als Status**. Sperren ist jetzt ein separates Boolean-Feld `locked`, orthogonal zum Status `sale`.

### Übergänge und was sie auslösen

- **`draft` → `sent`**: Button *Send by Email* (Angebot als PDF per Mail, Kundenportal-Link). Reine Statusänderung.
- **`draft`/`sent` → `sale`**: Button *Confirm* — oder automatisch durch **Online-Signatur** bzw. **Online-Zahlung**. Löst aus: Erzeugung von Lieferaufträgen, ggf. Einkaufs-/Fertigungsaufträgen, Abrechnung wird möglich. Einstellung **„Lock Confirmed Sales"** sperrt bei Bestätigung automatisch.
- **`sale` + Lock**: Button *Lock* setzt `locked = true` → keine Änderungen mehr; *Unlock* hebt auf.
- **→ `cancel`**: Button *Cancel* (optional Storno-Mail). Zugehörige **Lieferaufträge werden automatisch storniert**; über MTO erzeugte RFQs und Fertigungsaufträge **bleiben aktiv** und erhalten nur eine Warnung im Chatter (manuell stornieren).
- **`cancel`/`sent` → `draft`**: Button *Set to Quotation*.

Typischer Gesamtfluss: Angebot → Verkaufsauftrag → Lieferung → Rechnung → Zahlung.

## 2. Was passiert bei Bestätigung — Lieferung, MTO, Fertigung

### Automatischer Lieferauftrag
Bei Bestätigung eines Auftrags mit lagergeführten Produkten erzeugt Odoo automatisch einen **Lieferauftrag** (`WH/OUT`, ein `stock.picking`), erreichbar über den **Delivery-Smart-Button**. Beim **Validieren** der Lieferung geht das Picking auf *Done*, die Menge fließt in die Spalte **Delivered** der Auftragsposition zurück. Mehrstufige Auslieferung (Pick → Ship bzw. Pick → Pack → Ship) erzeugt eine Kette von Transfers; nachgelagerte stehen auf *Waiting Another Operation*.

### Routen-Konzept (kurz)
Routen sind Sammlungen von **Push-/Pull-Regeln**:
- **Pull-Regel:** Bedarf am Zielort (bestätigter Auftrag) erzeugt rückwärts durch die Kette Transfers/Belege.
- **Push-Regel:** Physisches Eintreffen von Ware erzeugt den nächsten Transfer.
- Regel-Aktionen auch **Buy** (erzeugt RFQ) und **Manufacture** (erzeugt MO).
- Routen zuweisbar auf: Produkt, Produktkategorie, Lager, Verpackung, einzelne Auftragsposition.

Vorkonfigurierte Routen: **Buy**, **Manufacture**, **Replenish on Order (MTO)**, Liefer-/Empfangsrouten.

### Make-to-Order (MTO) + Buy / Manufacture
Route **„Replenish on Order (MTO)"** funktioniert nur in Kombination mit einer zweiten Route am Produkt:
- **MTO + Buy** (+ Lieferant am Produkt): Auftragsbestätigung erzeugt automatisch eine **RFQ (Einkauf)**.
- **MTO + Manufacture** (+ Stückliste): Auftragsbestätigung erzeugt automatisch einen **Fertigungsauftrag (MO)**.

MTO beschafft **auch bei vorhandenem Lagerbestand** (auftragsbezogen). RFQ/MO sind per Smart-Button **direkt mit dem Ursprungs-Verkaufsauftrag verknüpft** (Quellbeleg). Abgrenzung: **Meldebestandsregeln (Reordering Rules)** lösen bestandsgetrieben aus (Min/Max), MTO genau bei Auftragsbestätigung mit Verlinkung SO ↔ PO/MO.

## 3. Aufbau der Auftragspositionen (`sale.order.line`)

| Feld | Inhalt |
|---|---|
| `product_id` | Produkt — konkret die **Variante** (`product.product`); dazu `product_template_id` |
| Variantenattribute | `product_template_attribute_value_ids`, `product_custom_attribute_value_ids` (Freitext), `product_no_variant_attribute_value_ids` |
| `name` | Positionsbeschreibung (vorbelegt, editierbar) |
| `product_uom_qty` | Bestellte **Menge** |
| `product_uom` | **Maßeinheit** (nur gleiche UoM-Kategorie) |
| `price_unit` | **Einzelpreis** (aus Preisliste, editierbar) |
| `discount` | Rabatt in % |
| `tax_id` | **Steuern** (aus Produkt/Fiskalposition vorbelegt) |
| `qty_delivered` | **Gelieferte Menge**; Methode: Manual / Stock Moves / Timesheet / Expenses |
| `qty_invoiced` / `qty_to_invoice` | **Abgerechnete** / noch abzurechnende Menge |
| `invoice_status` | Abrechnungsstatus je Zeile |
| `display_type` | Strukturzeilen: **Section** und **Note** ohne Produkt/Preis |

Variantenauswahl: **Product Configurator** (Popup, eine Variante) oder **Variant Grid Entry** (mehrere Varianten mit Mengen auf einmal). Jede gewählte Variante wird eigene Auftragszeile. Zusätzlich: Optional Products (Upsell), Other Info (Verkäufer/Team, Incoterms, Fiskalposition).

## 4. Lieferstatus und Abrechnungsstatus auf dem Auftrag

**Lieferstatus** (`delivery_status`, berechnet aus den Pickings):
- `pending` — Not Delivered
- `started` — Started
- `partial` — Partially Delivered
- `full` — Fully Delivered

**Abrechnungsstatus** (`invoice_status`, berechnet aus den Positionen):
- `no` — Nothing to Invoice
- `to invoice` — To Invoice
- `invoiced` — Fully Invoiced
- `upselling` — Upselling Opportunity (Policy „delivered": mehr geliefert als bestellt)

Abhängig von der **Abrechnungspolitik** des Produkts:
- **Invoice what is ordered** (Standard): abrechenbar sofort bei Auftragsbestätigung.
- **Invoice what is delivered**: abrechenbar erst nach validierter Lieferung; Teillieferungen ⇒ Teilrechnungen.

## 5. Connectors (Shopify-artige Integrationen) — kurz

Odoo 18 dokumentiert offiziell: **Amazon Connector**, **Shopee Connector**, **Gelato**. Einen **offiziellen Shopify-Connector gibt es nicht** (nur Drittanbieter-Apps). Muster (Beispiel Amazon): bestätigte Marktplatz-Bestellungen werden automatisch als **Odoo-Verkaufsaufträge** importiert (Produkt, Menge, Versandkosten; fehlende Kunden werden angelegt); bei Eigenversand erzeugt Odoo Lieferaufträge und meldet den Versandstatus an den Marktplatz zurück.

## Quell-URLs

**Doku:**
- https://www.odoo.com/documentation/18.0/applications/sales/sales.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/sales_quotations.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/sales_quotations/create_quotations.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/sales_quotations/orders_and_variants.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/invoicing/invoicing_policy.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/mto.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/use_routes.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_one_step.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/amazon_connector/features.html

**Quellcode (Branch 18.0):**
- https://raw.githubusercontent.com/odoo/odoo/18.0/addons/sale/models/sale_order.py
- https://raw.githubusercontent.com/odoo/odoo/18.0/addons/sale/models/sale_order_line.py
- https://raw.githubusercontent.com/odoo/odoo/18.0/addons/sale_stock/models/sale_order.py
