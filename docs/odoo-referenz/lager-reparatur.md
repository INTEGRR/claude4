# Odoo 18 — Feature-Zusammenfassung LAGER (Inventory) & REPARATUR (Repairs)

Grundlage: offizielle Odoo-18.0-Dokumentation (Quell-URLs am Ende).

---

## LAGER (Inventory)

### 1. Grundkonzepte

**Lagerhäuser (Warehouses):** physische Gebäude mit Adresse; pro Lagerhaus konfigurierbare Routen für Eingang, Ausgang, interne Transfers.

**Lagerorte (Locations, `stock.location`):**
- Feingliederung innerhalb eines Lagerhauses, hierarchisch mit Parent Location (z. B. `WH/Stock/Zone A/Regal 1`).
- **7 Lagerort-Typen:**

  | Typ | Zweck |
  |---|---|
  | **Vendor Location** (Lieferant) | Virtueller Herkunftsort gekaufter Ware; zählt nicht zum eigenen Lager |
  | **Customer Location** (Kunde) | Virtueller Zielort verkaufter Ware; Ware verlässt damit den Bestand |
  | **Internal Location** | Echte Lagerplätze; nur diese zählen zur Bestandsbewertung |
  | **View** | Reiner Gliederungsknoten, enthält selbst keine Ware |
  | **Inventory Loss** (Inventurdifferenz) | Virtuell; Gegenkonto für Bestandskorrekturen. Unterorte: `Inventory Adjustment` und `Scrap` |
  | **Production** (Produktion) | Virtuell; hier werden Komponenten verbraucht und Fertigprodukte „erzeugt" |
  | **Transit Location** | Virtuell; Ware unterwegs zwischen Lagerhäusern/Firmen |

- Regel: Bewegungen zwischen internen und externen/virtuellen Orten verändern die Bestandsbewertung.
- Weitere Felder: Storage Category, Company, **Barcode**, Is a Scrap Location, Is a Return Location, Removal Strategy (FIFO/LIFO/FEFO/Closest), zyklische Zählung (`Inventory Frequency (Days)`).

**Lagerbuchungen (Stock Moves):**
- Jede Bestandsänderung ist eine Bewegung „von Ort A nach Ort B" (auch von/zu virtuellen Orten). Transfers (Pickings) bündeln Moves; Validieren erzeugt Move-Lines als Audit-Trail.
- Mehrstufige Abläufe erzeugen **verkettete Moves** (z. B. 3-stufige Lieferung: `WH/Stock → Packing → Output → Kunde`), jede Stufe hängt von der vorherigen ab.

**Vorgangsarten (Operation Types, `stock.picking.type`):**
- Kategorien: **Receipt** (`WH/IN`), **Delivery** (`WH/OUT`), **Internal Transfer** (`WH/INT`), dazu Fertigungs-/Reparatur-Vorgangsarten.
- Konfiguration: Type of Operation, **Sequence Prefix** (Belegnummern), Barcode der Vorgangsart, **Reservation Method** (At Confirmation / Manually / Before scheduled date), **Returns Type**, **Create Backorder** (Ask / Always / Never), Lose/Seriennummern (Create New / Use Existing), Standard-Quell-/Zielort, Reiter **Hardware** (Druck bei Validierung) und **Barcode App**.

### 2. Transfer-Status und Stornierung

- Statusverlauf: `draft` (Entwurf) → `waiting` (wartet auf Verfügbarkeit) / `confirmed` (Waiting Another Operation) → `assigned` (Ready/Bereit) → `done` (Erledigt), plus `cancel`.
- **Stornieren:** Nicht erledigte Transfers können abgebrochen werden (Reservierungen aufgehoben); „Set to Draft" setzt zurück. Ein **erledigter** Transfer ist nicht stornierbar — Korrektur nur per Gegenbuchung/Retoure (**Return**-Button erzeugt Rücktransfer).
- Teilmengen-Validierung: **Backorder**-Logik gemäß Vorgangsart (Ask/Always/Never).

### 3. Bestandsführung: On Hand, Reserviert, Prognostiziert; Reservierung

- **On Hand:** physisch vorhandene Menge (nur interne Orte).
- **Reserved / Free to Use:** Free to Use = On Hand minus für Liefer-/Fertigungsaufträge reservierte Menge.
- **Incoming / Outgoing:** erwartete Zu-/Abgänge aus bestätigten Einkaufs-, Verkaufs-, Fertigungsaufträgen.
- **Forecasted** = On Hand + Incoming − Outgoing, terminiert nach geplanten Daten; negative Prognose = Unterdeckung.
- **Reservierungsmethoden** (je Vorgangsart, nicht für Wareneingänge): **At Confirmation** / **Manually** („Check Availability") / **Before Scheduled Date** (x Tage vorher). Gilt auch für Fertigung und Reparaturen.

### 4. Fertigung und Bestände

- **Buchungslogik MO:** Komponentenverbrauch = Move `WH/Stock → Production` (virtueller Produktionsort); Fertigprodukt-Zugang = Move `Production → WH/Stock`. Bei 1-stufiger Fertigung keine separaten Transferbelege — Bestände ändern sich direkt bei MO-Abschluss.
- **Demontage (Unbuild):** Fertigprodukt −, Komponenten + gemäß BoM. Warnung bei Bestand ≤ 0.
- **Ausschuss (Scrap):** Scrap-Order (Product, Quantity, Source Location, Scrap Location = `Virtual Locations/Scrap`, optional Replenish Quantities) bucht in den virtuellen Scrap-Ort; auch direkt aus Transfers heraus möglich.

### 5. Inventur / Bestandskorrekturen (Inventory Adjustments)

- Zeilen mit `On Hand Quantity` (Buchbestand), `Counted Quantity` (gezählt), `Difference`, Lot/Serial, `Scheduled Date`.
- Ablauf: Produkt wählen → gezählte Menge eintragen → **Apply** bucht: Move-Line gegen virtuellen Ort `Inventory Adjustment`, On Hand = Zählwert.
- Zusatzfunktionen: Relocate, Set to zero, **Revert** über Moves-History; Warnung bei zwischenzeitlichen Bewegungen. Zyklische Zählungen über `Inventory Frequency` am Lagerort.

### 6. Barcode-App

- Produkte, Verpackungen und **Lagerorte** bekommen Barcodes; Nomenklatur **Default** (UPC/EAN) oder **GS1**.
- Barcodes vergeben am Produktformular oder Liste „Product Barcodes"; **Varianten brauchen eigene Barcodes**. Lagerort-Barcodes als PDF druckbar; druckbare Befehls-Barcodes (z. B. „Validate") und Vorgangsart-Barcodes.
- **Wareneingang per Scan:** Beleg wählen → Produkt-Barcodes scannen (jeder Scan +1) → Mengen korrigieren → Validate.
- **Warenausgang per Scan:** erst Quellort scannen, dann Produkte → Validate.
- **Interne Transfers:** bestehenden Transfer abarbeiten oder neu: Vorgangsart-Barcode scannen → Transfer angelegt → Produkte scannen → Validate. Los-/Seriennummern nach dem Produktscan.
- **Inventur per Scan:** Lagerort-Barcode → Produkte scannen/Keypad → Apply.

### 7. Maßeinheiten (UoM)

- Einheiten in **Kategorien** (z. B. Unit, Weight); jede Kategorie hat eine **Referenzeinheit**; Umrechnung nur **innerhalb derselben Kategorie**.
- Neue Einheit: Name, Bigger/Smaller than Referenz, **Ratio** (z. B. „Box of 12" = 12,0), Rundungsgenauigkeit.
- Am Produkt: `Unit of Measure` (Verkauf/Lager) und `Purchase UoM`; automatische Umrechnung bei Einkauf, Nachschub, Verkauf.

---

## REPARATUR (Repairs)

### 8. Reparaturaufträge (`repair.order`)

**Gesamtablauf (Retoure → Reparatur → Rücklieferung):**
1. **Retoure:** Im Verkaufsauftrag → Delivery → **Return** → Reverse-Transfer-Popup (Produkte/Mengen anpassen) → Wareneingang der Retoure validieren (korrigiert gelieferte Menge im SO).
2. **Reparaturauftrag anlegen** mit Feldern: `Customer`, `Product to Repair`, `Product Quantity` (+ UoM), `Return` (Verknüpfung zum Rücktransfer), `Under Warranty` (Kunde zahlt keine Teile), `Scheduled Date`, `Responsible`, `Tags`.
3. **Reiter Parts** — Teilezeilen mit `Type`:
   - **Add:** benötigte/eingebaute Teile (werden aus dem Lager verbraucht),
   - **Remove:** aus dem Produkt zu entfernende Teile,
   - **Recycle:** entnommene Teile, die wiederverwendbar ins Lager zurückgehen.
   Zeilenfelder: Product, Demand, Done, UoM, Used-Häkchen; optional Quell-/Ziel-Lagerort.
4. Reiter **Repair Notes** und **Miscellaneous** (`Operation Type`, Default „Repairs" — eigene Lager-Vorgangsart).

**Status/Aktionen:** `New` → **Confirm Repair** → `Confirmed` (reserviert Teile; Forecasted zeigt Verfügbarkeit) → **Start Repair** → `Under Repair` → **End Repair** → `Repaired`; jederzeit **Cancel Repair** → `Cancelled`. Bei Demand ≠ Done Popup „Uncomplete Move(s)". Smart-Button **Product Moves** zeigt alle Lagerbewegungen.

**Lagerwirkung:** Bestätigen reserviert Add-Teile; beim Abschluss werden alle Bewegungen über die Reparatur-Vorgangsart gebucht: Add-Teile verlassen das Lager, Remove-Teile gehen an einen definierten Zielort (z. B. Ausschuss), Recycle-Teile zurück in den Bestand.

**Rücklieferung:** Über den Reverse-Transfer → erneut **Return** → neue Auslieferung → validieren.

**Abrechnung:** Bei `Under Warranty` keine Berechnung. Sonst **Create Quotation**: erzeugt Verkaufsauftrag, vorbefüllt mit verwendeten Teilen; Arbeitszeit als Dienstleistungsprodukt ergänzen, bestätigen, fakturieren.

---

## Quell-URLs

**Inventory:**
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/use_locations.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/operation_type.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/count_products.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/inventory_management/scrap_inventory.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_one_step.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/delivery_three_steps.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/reservation_methods.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/forecast.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/warehouses_storage/reporting/stock.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html

**Barcode:**
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/setup/software.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/receipts_deliveries.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/process_transfers.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/transfers_scratch.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/barcode/operations/adjustments.html

**Repairs:**
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/repairs.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/repairs/repair_orders.html
