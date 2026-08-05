# Odoo 18 — Modul Einkauf (Purchase): Feature-Zusammenfassung für einen Nachbau

Basierend auf der offiziellen Odoo-18.0-Dokumentation (Quell-URLs am Ende).

## 1. Lebenszyklus einer Bestellung (`purchase.order`)

| Status (UI) | Technischer State | Auslöser / Übergang |
|---|---|---|
| **RFQ** (Angebotsanfrage) | `draft` | Neu angelegtes Dokument |
| **RFQ Sent** (Gesendet) | `sent` | Klick auf **Send by Email** und Absenden der E-Mail |
| **Purchase Order** (Bestellung) | `purchase` | **Confirm Order** transformiert die RFQ direkt in eine aktive PO. *Order Deadline* wird zu *Confirmation Date* |
| **Locked** (Gesperrt) | `done` | Manuell per **Lock**-Button oder automatisch via Einstellung **Lock Confirmed Orders**: bestätigte Bestellungen werden schreibgeschützt. Per **Unlock** wieder editierbar |
| **Cancelled** (Abgebrochen) | `cancel` | **Cancel**-Button; von RFQ und von bestätigter PO aus möglich. Warnung im Chatter; stornierte Anfrage kann per „Set to Draft" zurückgesetzt werden |

Weitere Lifecycle-Details:
- **RFQ-Dashboard** mit Filter-Buttons: **To Send** (noch nicht versendet), **Waiting** (versendet, warten auf Bestätigung), **Late** (Order Deadline überschritten).
- Kopffelder: **Vendor** (Pflicht), **Vendor Reference** (Beleg-Nr. des Lieferanten, für das Matchen beim Wareneingang), **Order Deadline**, **Expected Arrival** (= Deadline + Lieferzeit des Lieferanten), **Ask confirmation**, **Deliver to**.
- **Chatter** protokolliert alle E-Mails, Notizen, Aktivitäten.

## 2. Versand per E-Mail (Send by Email)

- Button öffnet Compose-Popup mit Mailvorlage **„Purchase: Request for Quotation"**; Empfänger = E-Mail des Lieferantenkontakts.
- **Send** verschickt und setzt Status auf **RFQ Sent**. **Print RFQ** lädt alternativ ein PDF herunter.
- Versand wird im Chatter dokumentiert.

## 3. Bestellpositionen (Products-Tab)

- Felder je Zeile: **Produkt**, **Menge**, **Maßeinheit (UoM)**, **Einzelpreis** (auto-befüllt aus Lieferantenpreisliste), Steuern, Zwischensumme.
- **Maßeinheiten:** Produkt kann getrennte **UoM** (Verkauf/Lager) und **Purchase UoM** haben. Bestellung in Einkaufs-UoM; beim Wareneingang automatische Umrechnung in Lager-UoM (z. B. 2 Dutzend → 24 Stück). Umrechnung nur innerhalb derselben UoM-Kategorie.
- **Received (erhaltene Menge):** wird durch Validieren des zugehörigen Wareneingangs gefüllt; bei Teillieferung nur die validierte Teilmenge.
- **Billed (abgerechnete Menge):** wird durch aus der PO erzeugte/verknüpfte Lieferantenrechnungen gefüllt.
- Voraussetzung: Checkbox **Purchase** am Produkt, Route **Buy**.

## 4. Lieferanten und Lieferantenpreislisten

**Lieferant = Kontakt** (Typ Company/Individual). Relevante Felder: Name, Adresse, Tax ID, E-Mail, Tab **Sales & Purchase** (Zahlungsbedingungen, Zahlungsmethode, Receipt Reminder, Fiscal Position), Tab **Accounting** (Bankkonten, Standardkonten).

**Lieferantenpreislisten (`product.supplierinfo`):**
- Gepflegt am Produkt (Tab Purchase) oder zentral unter Konfiguration → **Vendor Pricelists**.
- Felder: **Vendor** (Pflicht), Produkt, **Quantity** (Mindestmenge für den Preis), **Unit Price**, **Delivery Lead Time** (Tage), Sequenz (Priorität bei mehreren Lieferanten); optional **Vendor Product Code**, **Discount (%)**.
- Wirkung: Beim Hinzufügen des Produkts auf einer RFQ werden Preis und Lieferzeit **automatisch übernommen**.
- Import per XLSX/CSV möglich.

## 5. Wareneingang (Receipt) und Rückstände

- **Bestätigen einer PO erzeugt automatisch einen Wareneingangsbeleg** (`WH/IN/…`) mit Produkten und erwarteten Ankunftsdaten; Smart-Button **Receipt** bzw. **Receive Products**.
- Receipt trägt **Source Document** = Bestellnummer (Rückverknüpfung PO ↔ Lagerbuchung), Operation Type Empfang, Status (bereit → Done).
- **Validate**: Status → Done, Produkte werden vom Lieferantenstandort in den Lagerbestand gebucht, **Received**-Spalte der PO aktualisiert.
- Empfangsprozess konfigurierbar als **1, 2 oder 3 Schritte**.
- **Teillieferung / Backorder:** Bei Validierung mit geringerer Menge Popup **„Create Backorder?"**: **Create Backorder** (neuer Eingangsbeleg über Restmenge, mit PO verknüpft), **No Backorder** (Restmenge aufgeben), **Discard**.

## 6. Lieferantenrechnungen (Vendor Bills)

**Abrechnungsrichtlinie (Bill Control):** global in den Einstellungen, **pro Produkt überschreibbar**:
- **Ordered quantities:** Entwurfsrechnung sofort nach PO-Bestätigung, über **bestellte** Mengen.
- **Received quantities:** Rechnung erst nach (Teil-)Wareneingang, über **tatsächlich erhaltene** Mengen. Versuch ohne Eingang → Fehlermeldung.

**Erstellung aus der PO:** **Create Bill** erzeugt Entwurfsrechnung (Positionen gemäß Richtlinie vorbefüllt) → **Bill Date** setzen → **Confirm** (Posted) → **Register Payment** → bezahlt. Sammelaktionen: Drucken, Sammelzahlung (Group Payments).

**Billing Status** auf der PO:

| Billing Status | bei „Received quantities" | bei „Ordered quantities" |
|---|---|---|
| **Nothing to Bill** | PO bestätigt, noch nichts erhalten | nicht anwendbar |
| **Waiting Bills** | (teilweise) erhalten, Rechnung noch nicht erstellt | PO bestätigt |
| **Fully Billed** | (teilweise) erhalten, Entwurfsrechnung erstellt | Entwurfsrechnung erstellt |

**Rechnungsstatus:** Draft → Posted → Paid. **Stornieren/Korrektur:** auf bestätigten Rechnungen per **Credit Note** (Gutschrift); Entwürfe können verworfen werden.

**3-Way Matching** (optional, nur mit „Received quantities"): Feld **Should Be Paid** (Yes / Exception / No) auf der Entwurfsrechnung.

## Quell-URLs

- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/rfq.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/control_bills.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/manage.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/products/pricelist.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/receipts_delivery_one_step.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/product_management/configure/uom.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/picking_methods/batch.html
- https://www.odoo.com/documentation/18.0/applications/essentials/contacts.html
- https://www.odoo.com/documentation/13.0/applications/inventory_and_mrp/purchase/purchases/rfq/lock_orders.html (Lock-Feature, in 18.0 unverändert)

Hinweis: Die technischen State-Bezeichner in Abschnitt 1 sowie „Set to Draft" sind aus dem Odoo-Standardmodul ergänzt; alles Übrige stammt aus den gelisteten Doku-Seiten.
