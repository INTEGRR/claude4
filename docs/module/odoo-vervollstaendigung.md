# Odoo-Vervollständigung (Migrationen 0012–0017)

Zweiter Ausbau nach dem Praxistest: das Datenmodell wurde gegen die
Odoo-18-Modelle (Quellcode, Branch 18.0) abgeglichen und um die fehlenden
Felder und Relationen ergänzt. Feldnamen folgen den Odoo-Originalen.

## Was dazukam

**Stammdaten (0012)** — Produktkategorien mit Hierarchie (`product.category`),
Steuern (`account.tax`: Satz, Verkauf/Einkauf, preis-inklusive),
Zahlungsbedingungen (`account.payment.term` inkl. Skonto und
`payment_term_due_date()`), die elf Incoterms 2020, Tags für
Kontakte/Produkte/Aufträge/Reparaturen, Kuppelprodukte (`mrp.bom.byproduct`).
Kontakte: Hierarchie mit Typen (Ansprechpartner / Rechnungs- / Lieferadresse),
Verkäufer, Zahlungsbedingungen, Referenz, Website, Mobil, Handelsregister.
Produkte: Pflichtkategorie, Standardsteuern, Kundenlieferzeit, HS-Code +
Ursprungsland (DHL-Zoll), Belegtexte, Verantwortlicher. Lieferantenpreise:
Rabatt und Gültigkeitszeitraum. Verwaltung unter **Produkte → Konfiguration**.

**Statuswerte (0013)** — `delivery_status` kennt `started` (Lager hat
reserviert), `invoice_status` kennt `upselling` (mehr geliefert als
bestellt), `reservation_method` kennt `by_date`.

**Belege (0014)** — Verkauf: Verkäufer, Kundenreferenz, zugesagter
Liefertermin, Angebotsgültigkeit, Zahlungsbedingung, Incoterm; je Zeile
Steuerbezug, eigener Abrechnungsstatus und `qty_to_invoice`. Die
Bestätigung zieht einen Steuer-Schnappschuss, terminiert die Lieferung und
explodiert **Kit-Stücklisten** (`bom_type='kit'`) in Komponenten. Einkauf:
Einkäufer, Zahlungsbedingung, Incoterm, Priorität, Empfangserinnerung,
**Zeilenrabatt**. Rechnungen: automatische **Fälligkeit** aus der
Zahlungsbedingung, Verwendungszweck, Prüf-Flag und
**3-Way-Matching-Ampel** (`vendor_bill_match_state`). Transfers,
Fertigungsaufträge und Reparaturen kennen Verantwortliche und Priorität;
`stock_moves` können verkettet werden (`move_dest_id`).

**Meldebestände (0015)** — `stock_orderpoints` (Min/Max/Vielfaches je
Variante+Ort), `orderpoint_suggestions()` (Bedarf, sobald die Prognose
unter Min fällt) und `orderpoint_execute()` (Entwurfs-Bestellung mit
Merge je Lieferant bzw. bestätigter Fertigungsauftrag). Seite
**Lager → Beschaffung**.

**Lose & Seriennummern (0017)** — `tracking` je Produkt
(keine/Los/Serie), `stock_lots`, `move_lot_assignments`,
`stock_lot_quants`. Die aggregierten `stock_quants` und ihre
Ledger-Invariante bleiben unangetastet; die Los-Ebene hat eine eigene
Invariante. Regeln: explizite Zuordnung muss exakt passen (Serie = Menge
1); ohne Angabe FIFO bei Abgängen (Altbestand über Sonderlos
`ALTBESTAND`) und Auto-Anlage bei Zugängen. Erfassung am Wareneingang
(Textfeld) und an der Fertigmeldung (Wunschnummer); Seiten
**Lager → Lose & Serien** mit Rückverfolgung.

## Bewusst NICHT nachgebaut

Buchhaltung (Konten, Journale, Bestandsbewertung), Multi-Company,
Multi-Currency-Kurse, Preislisten (Preise kommen aus Shopify),
Fiskalpositions-Automatik, CRM/Sales-Teams/Kundenportal, Kundenrechnungen
als Objekte, Workcenter/Arbeitspläne/Shop-Floor, generische
`stock.move.line`-Ebene, Batch-/Wave-Picking, Storage Categories/Putaway,
Verpackungen/GS1, Dropshipping, mehrstufige Liefer-Routen, Ablaufdaten,
`product.combo`, Attribut-Modi dynamic/no_variant + Exclusions.

## Ereignis-Monitor (0016)

Gehört zum selben Ausbau: `api_transactions` protokolliert jeden
Shopify-/DHL-/Mail-Aufruf (Request/Antwort gekürzt, Dauer, Fehler; nie
Zugangsdaten). Die Job-Queue trennt Ergebnis- und Fehlermeldung, holt
hängengebliebene Läufe zurück (`reap_stuck_jobs`) und schreibt Fehler in
den Verlauf des betroffenen Belegs; Webhooks bekommen dieselbe
Backoff-Staffel. Oberfläche: **Integrationen** (Monitor) +
**Integrationen → Transaktionsprotokoll** (Filter, Detailansicht).
Housekeeping räumt Transaktionen nach 30, Erledigtes nach 60 Tagen auf.
