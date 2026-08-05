# Odoo 18 — Modul Fertigung (Manufacturing/MRP): Feature-Zusammenfassung für einen Nachbau

## 1. Stücklisten (Bill of Materials, `mrp.bom`)

**Anlage:** Fertigung → Produkte → Stücklisten → Neu. Kopfdaten:
- **Produkt** (Pflicht): das zu fertigende Produkt (Produktvorlage).
- **Produktvariante** (optional): nur befüllen, wenn die BoM exklusiv für genau eine Variante gilt (siehe Abschnitt 2).
- **Menge** + **Maßeinheit**: Referenzmenge, auf die sich die Komponenten beziehen (typisch 1,0 Stück).
- **BoM-Typ**:
  - **„Dieses Produkt fertigen" (Manufacture this product)** — Standard; Grundlage für Fertigungsaufträge.
  - **„Bausatz" (Kit)** — Produkt wird nie gefertigt/gelagert, sondern beim Verkauf/Transfer automatisch in seine Komponenten zerlegt.

**Reiter „Komponenten":** eine Zeile je Komponente mit
- Produkt (Komponente), Menge, Maßeinheit.
- Optionale Spalten:
  - **Auf Varianten anwenden (Apply on Variants)** — siehe Abschnitt 2.
  - **In Vorgang verbraucht (Consumed in Operation)** — bindet Komponente an einen Arbeitsschritt.
  - **Manueller Verbrauch (Manual Consumption)** — Werker muss Verbrauch explizit bestätigen, sonst Warnung.

**Reiter „Vorgänge" (Operations):** nur nach Aktivierung von **Arbeitsaufträgen**. Je Vorgang: Name, Arbeitsplatz, Dauer (automatisch/manuell), Arbeitsblatt (PDF/Google Slides/Text) — und ebenfalls Varianten-Einschränkung möglich. Ein Vorgang gehört exklusiv zu einer BoM.

**Reiter „Kuppelprodukte" (By-Products):** Nebenausstoß mit Menge/ME, optional einem Vorgang zugeordnet.

**Reiter „Sonstiges":** u. a.
- **Fertigungsbereitschaft (Manufacturing Readiness):** MO startbereit, wenn Komponenten der ersten Operation verfügbar vs. alle Komponenten.
- **Flexibler Verbrauch:** Abweichung vom Soll-Verbrauch **Blockiert / Erlaubt / Erlaubt mit Warnung**.
- **Route/Vorgangsart** (bei mehreren Lagern), **Durchlaufzeiten** (Fertigungsdauer, Vorlaufzeit Komponenten in Tagen).

**Kit-BoM (Bausatz):** Auf Angebot/Auftrag erscheint der Bausatz als eine Zeile, auf dem **Lieferschein werden die einzelnen Komponenten** gelistet. Der Kit-Artikel selbst hat keinen eigenen Bestand — Verfügbarkeit ergibt sich rein aus den Komponentenbeständen; interne Transfers zerlegen den Kit automatisch. Kits dürfen verschachtelt werden.

## 2. „Auf Varianten anwenden" (Apply on Variants) — BoM für Produkte mit Varianten

Kernprinzip: **Eine einzige BoM bedient alle Varianten eines Produkts**; einzelne Komponentenzeilen werden per Variantenfilter eingeschränkt.

**Voraussetzungen:**
1. Varianten-Feature aktivieren (Einstellungen → „Varianten").
2. Attribute + Attributwerte anlegen, dem Produkt im Reiter **„Attribute & Varianten"** zuweisen → Odoo generiert die Varianten.

**Konfiguration auf der BoM:**
- BoM auf die **Produktvorlage** anlegen; das Kopffeld **„Produktvariante" bleibt leer** (dieses Feld ist ausschließlich für den Alternativansatz „eine eigene BoM pro Variante").
- Im Komponenten-Reiter Spalte **„Auf Varianten anwenden"** einblenden. Pro Komponentenzeile einen oder mehrere Attributwerte eintragen.
- **Verhalten:**
  - Zeile mit leerem „Auf Varianten anwenden" → Komponente gilt für **alle** Varianten.
  - Zeile mit Wert(en) → Komponente wird **nur** in Fertigungsaufträge für Varianten übernommen, die diesem Wert entsprechen (z. B. Komponente „Gehäuse weiß" mit „Farbe: Weiß" erscheint nur im MO der weißen Variante).
- Beim Anlegen des Fertigungsauftrags wählt man die konkrete Variante; die Komponentenliste des MO wird entsprechend **gefiltert** aufgebaut.
- Dieselbe Varianten-Einschränkung existiert analog für **Vorgänge**.

**Zwei Modellierungsansätze:** (a) eine BoM je Variante (Feld „Produktvariante" im Kopf gesetzt), (b) eine gemeinsame BoM mit „Apply on Variants" auf Zeilenebene — Ansatz (b) ist der von der Doku empfohlene, wartungsärmere Weg.

## 3. Fertigungsaufträge (`mrp.production`)

**Anlage:** Produkt wählen → **Stückliste wird automatisch gezogen**; Reiter „Komponenten" und „Arbeitsaufträge" aus der BoM vorbefüllt (manuell erweiterbar); Menge angeben.

**Status-Lebenszyklus:** **Entwurf (Draft) → Bestätigt (Confirmed) → In Bearbeitung (In Progress) → Abschließen (To Close) → Erledigt (Done)**; jederzeit vor Abschluss **Abgebrochen (Cancelled)**.
- *Entwurf:* angelegt, noch nicht bestätigt. (Automatisch erzeugte MOs, z. B. aus MTO/Meldebestand, entstehen direkt als „Bestätigt".)
- *Bestätigt:* Bedarfe/Reservierungen werden angelegt.
- *In Bearbeitung:* sobald ein Arbeitsauftrag gestartet wurde.
- *Abschließen (To Close):* alle Arbeitsaufträge fertig, MO wartet auf finale Buchung.
- *Erledigt:* nach **„Alle produzieren" (Produce All)** bzw. **„Produktion schließen"**.

**Komponentenverfügbarkeit:** Nach Bestätigung reserviert Odoo Komponenten aus dem Bestand (Check availability). Bei 2-/3-stufiger Fertigung entsteht zusätzlich ein Kommissionier-Transfer bzw. Einlagerungs-Transfer.

**Verbrauch & Rückmeldung:**
- Beim Abschluss werden die **Komponenten laut Stückliste (anteilig zur produzierten Menge) verbraucht** (Bestandsabgang) und die **Fertigmenge dem Bestand zugebucht**. Abweichungen regelt „Flexibler Verbrauch"; „Manueller Verbrauch"-Zeilen müssen explizit bestätigt werden.
- Produzierte Menge inkl. optionaler **Los-/Seriennummer**, dann **Validieren**.
- Teilmengen führen zum **Rückstands-Dialog** (Backorder) für die Restmenge.

**Shop-Floor-Modul (Werkstattansicht):** Karten je MO/Arbeitsauftrag mit MO-Nummer, Produkt, Menge, Status; Schritte abhaken, Mark as Done, Close Production; Zahnrad: Ausschuss (Scrap), Arbeitsauftrag/Komponente hinzufügen, Log-Notiz.

## 4. Demontageaufträge (Unbuild Orders)

**Felder:**
- **Produkt** (Pflicht) → **Stückliste** automatisch gezogen — definiert, in welche Komponenten und Mengen zerlegt wird.
- **Menge**, **Fertigungsauftrag** (optional, Referenz), **Quelllagerort** / **Ziellagerort**, **Los-/Seriennummer**, Unternehmen.

**Ausführung:** Button **„Demontieren"**. Bestandswirkung: **Fertigprodukt −Menge, Komponenten +Mengen laut BoM** (proportional). Bei Bestand ≤ 0 Warnung; bestätigen bucht trotzdem (negativer Bestand möglich). Unbrauchbare Komponenten anschließend per **Ausschussauftrag (Scrap)** ausbuchen.

## 5. Drucken von Fertigungsaufträgen

- Drucken-Menü des MO: PDF-Beleg **„Produktionsauftrag"** (Report `mrp.report_mrporder`: Kopfdaten, Komponenten/Sollmengen, Arbeitsaufträge, Barcode der MO-Nummer) sowie **Produkt-Etiketten** und **Los-/SN-Etiketten**.
- **„Print on Validation"**-Framework (Vorgangsarten → Hardware): automatischer Druck bei Validierung, u. a. **Produktetiketten** (Formate „2×7 mit Preis", „4×7 mit Preis", „4×12", „4×12 mit Preis", ZPL) und **Los-/SN-Etiketten** („4×12 – eins pro Los/SN", „eins pro Einheit", ZPL) mit Produktname, Los/SN und **Barcode**.

## 6. Produkte & Produktvarianten allgemein

- **Attribute:** Attributname, **Anzeigetyp** (Pills, Farbe, Radio, Auswahl, Multi-Checkbox), **Modus der Variantenerstellung**:
  - **Sofort:** alle Kombinationen beim Zuweisen sofort erzeugt.
  - **Dynamisch:** Variante entsteht erst bei Verwendung (z. B. in einem Auftrag).
  - **Nie:** keine Variantenerzeugung, rein informativ. Nach Zuweisung nicht mehr änderbar.
- **Attributwerte:** Wert, „Ist Sonderwert" (Freitext durch Kunden), Farbe/Bild.
- **Zuweisung am Produkt:** Reiter „Attribute & Varianten" → Varianten = kartesisches Produkt der Werte.
- **Variantenpreise:** je Wert **„Wert Aufpreis" (Value Price Extra)**; „Ausschließen für" sperrt unzulässige Kombinationen.
- Jede Variante wird eigenständig geführt (Bestand, Verkäufe, Kennzahlen).

## Quell-URLs

- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/bill_configuration.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/advanced_configuration/product_variants.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/advanced_configuration/kit_shipping.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/one_step_manufacturing.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/basic_setup/two_step_manufacturing.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/workflows/unbuild_orders.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/manufacturing/shop_floor/shop_floor_overview.html
- https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/setup_configuration/print_on_validation.html
- https://www.odoo.com/documentation/18.0/applications/sales/sales/products_prices/products/variants.html
