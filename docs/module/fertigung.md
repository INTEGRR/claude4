# Modul Fertigung

Referenzverhalten: [docs/odoo-referenz/fertigung.md](../odoo-referenz/fertigung.md)

## Zweck

Tastaturen (und künftig weitere Produkte) anhand von Stücklisten fertigen. Kernanforderungen: Stücklisten mit ~20 Positionen (Menge + Maßeinheit je Position), **variantenabhängige Komponenten** („Auf Varianten anwenden"), Fertigungsaufträge mit Bestandswirkung, **druckbare Fertigungsaufträge mit Barcode**, Demontage.

## Stücklisten (BoM)

- Kopf: Produkt (Vorlage), optionale exklusive Variante, Referenzmenge + Maßeinheit, Typ (`manufacture` oder `kit`/Phantom), Verbrauchsregel (`blocked`/`allowed`/`warning`).
- Positionen: Komponente (Variante), Menge, Maßeinheit, Verbrauchsart (`backflush` = wird bei der Fertigmeldung automatisch verbraucht, `manual` = muss erfasst werden).
- **„Auf Varianten anwenden"** (Kernfeature, Odoo-18-Semantik):
  - Pro Position können 0..n Attributwerte des Endprodukts hinterlegt werden (`bom_line_variant_filters` → `product_template_attribute_values`).
  - Leere Liste ⇒ Position gilt für **alle** Varianten.
  - Nicht leer ⇒ Position gilt nur für Varianten, die **mindestens einen** der Werte tragen.
  - Beispiel: BoM „Tastatur" enthält Zeile „Gehäuse weiß" mit Filter `Farbe: Weiß` und Zeile „Gehäuse schwarz" mit Filter `Farbe: Schwarz`. Ein MO für die Variante „Tastatur – Weiß" übernimmt nur die weiße Gehäuse-Zeile.
- UI: Positionstabelle mit einblendbarer Spalte „Auf Varianten anwenden" (Multi-Select der Attributwerte des Produkts); Vorschau-Funktion „BoM für Variante X anzeigen" (gefilterte Ansicht + Verfügbarkeits-Ampel je Komponente).
- Eine Vorlage kann mehrere BoMs haben (aktiv/inaktiv, Variantenexklusiv); Auflösung bei MO-Anlage: exakte Varianten-BoM vor Vorlagen-BoM.

## Fertigungsaufträge (MO)

Status-Maschine (Odoo 18): `draft → confirmed → progress → to_close → done`, jederzeit vorher `cancel`.

- **Anlage**: Variante wählen → BoM wird automatisch aufgelöst → Komponentenbedarf wird **eingefroren** (Snapshot der gefilterten BoM-Zeilen als `stock_moves` mit `production_id`), Menge skaliert proportional (`qty_to_produce / bom.qty`). Komponenten manuell ergänzbar. MOs aus Verkaufsauftrag (MTO) entstehen direkt in `confirmed`.
- **Bestätigen**: Komponenten-Moves → `confirmed`, Reservierung versuchen (`assigned` bei Verfügbarkeit); Verfügbarkeits-Ampel je Komponente (on_hand/reserviert/fehlt), Button „Verfügbarkeit prüfen".
- **Starten**: Status `progress` (Zeitstempel). Arbeitsgänge werden einzeln gestartet und beendet — das Starten des ersten Arbeitsgangs startet auch den Auftrag.
- **Produzieren** (`produce_mo`): produzierte Menge erfassen (Default = Sollmenge).
  - Bucht Komponentenverbrauch `WH/Stock → Virtuell/Produktion` (anteilig zur produzierten Menge) und Fertigprodukt-Zugang `Virtuell/Produktion → WH/Stock`.
  - Abweichender Ist-Verbrauch je Komponente editierbar; Verhalten gemäß BoM-Verbrauchsregel (blockieren/erlauben/warnen).
  - Teilmenge ⇒ Backorder-Dialog: Rest-MO (`backorder_of_id`) oder Rest verwerfen.
  - Danach `done`; wenn `sales_order_id` gesetzt und alle MOs des Auftrags `done` ⇒ zugehörige Lieferung reservieren — der Auftrag erscheint damit in der „Versandbereit"-Liste des Versand-Moduls (DHL-Label + Shopify-Fulfillment, siehe [versand.md](versand.md)).
- **Stornieren**: offene Komponenten-Moves → `cancel`, Reservierungen freigeben.

## Phantom-Baugruppen (Ausbau 3, Migration 0021)

Eine Baugruppe mit `bom_type = 'kit'` existiert nur auf dem Papier — sie liegt nie im Regal. Überall, wo eine Stückliste aufgelöst wird, treten ihre Bestandteile an ihre Stelle:

- `bom_explode(bom_id, variant_id, menge)` löst **rekursiv** auf (Baugruppe in Baugruppe, maximal 8 Stufen; darüber bricht die Funktion mit klarer Meldung ab statt endlos zu laufen). Der Variantenfilter „Auf Varianten anwenden" gilt auf jeder Stufe.
- Rückgabe je Zeile: Komponente, Menge, Maßeinheit, Verbrauchsart, Stufe und `phantom_path` („Gehäuse-Set / Schraubensatz") — die Herkunft bleibt am Fertigungsauftrag sichtbar (`stock_moves.phantom_path`).
- Verwendet in: `create_manufacturing_order` (Komponentenbedarf), `unbuild_apply` (Demontage), `confirm_sales_order` (Kit-Lieferung), `valuation_initialize` (Stücklistenwert).

## Arbeitsplätze und Arbeitsgänge (Ausbau 3, Migration 0021)

- **`work_centers`** (mrp.workcenter): Kürzel, Name, **Stundensatz**, Plätze, Leistung in Prozent (80 % = braucht 25 % länger). Gepflegt unter *Fertigung → Arbeitsplätze*.
- **`bom_operations`** (mrp.routing.workcenter): Arbeitsgänge der Stückliste mit Zeit je Referenzmenge und einmaliger Rüstzeit je Auftrag.
- **`mo_operations`** (mrp.workorder): Kopie am Auftrag mit **eingefrorenem Stundensatz**. Vorgabezeit = (Rüstzeit + Zeit × Menge) ÷ Leistung.
- Erfassung: „Starten" setzt die Uhr, „Fertig" beendet den Gang — mit Minutenangabe oder automatisch aus der gelaufenen Zeit. Bei der Fertigmeldung werden noch offene Gänge mit ihrer anteiligen Vorgabezeit geschlossen (`mo_operations_finalize`), damit auch eine Teilfertigung ihre Lohnkosten trägt.

## Backflush (Ausbau 3, Migration 0021)

Billige Massenteile (Schrauben, Schaumstoff, Gummifüße) laufen bei der Fertigmeldung automatisch im Sollverhältnis mit. Positionen mit Verbrauchsart `manual` verlangen dagegen eine Eingabe — ohne sie bricht `mo_produce` mit einer klaren Meldung ab. Umstellbar direkt in der Positionstabelle der Stückliste.

## Herstellkosten (Ausbau 3, Migration 0021)

Das Fertigprodukt wird **nicht** mehr zum gepflegten Standardpreis eingebucht, sondern zu dem, was es gekostet hat:

```
Material = Summe der Wertschichten der verbrauchten Komponenten (AVCO, Migration 0018)
Lohn     = Summe (erfasste Minuten ÷ 60 × Stundensatz) über alle Arbeitsgänge
Einstand je Stück = (Material + Lohn) ÷ gefertigte Menge
```

Der Wert steht als `unit_cost` auf der Fertigmeldungs-Bewegung und geht damit in den gleitenden Durchschnittspreis der Variante ein. `manufacturing_orders.material_cost/labor_cost/unit_cost` und die View `production_cost` halten das Ergebnis für Auswertungen fest.

## Demontage (Unbuild)

Formular: Variante, BoM (auto), Menge, optionaler Ursprungs-MO, Quell-/Ziellagerort. Aktion **Demontieren**: Fertigprodukt −Menge, Komponenten +Mengen laut (gefilterter) BoM, proportional. Warnung bei resultierendem Negativbestand mit explizitem Bestätigen (Odoo-Verhalten). Defekte Teile anschließend über Ausschuss-Buchung (Lager-Modul) ausbuchen.

## Drucken

Umgesetzt als HTML-Druckansicht (`/fertigung/<id>/druck`, `window.print()`)
mit serverseitigen SVG-Barcodes (bwip-js) — bewusst kein PDF-Renderer und
keine Datei-Ablage, der Beleg entsteht bei jedem Aufruf frisch:

- Kopf: **zwei beschriftete Code-128-Barcodes** — `FERTIGUNG` (MO-Nummer,
  schließt am Scanner die Produktion ab) und `VERSAND` (Nummer der
  Lieferung des Auftrags, öffnet am Packtisch die Sendung; entfällt bei
  Lagerfertigung ohne Auftrag). Dazu Produkt + Variante, Menge, Termin,
  Quell-Verkaufsauftrag (inkl. Shopify-Ordername, Kunde).
- **Artikel-Code** des Erzeugnisses (EAN falls gepflegt, sonst Code 128
  der SKU) — wird am Packtisch je gepacktem Stück gegengescannt; derselbe
  Code klebt auf dem fertigen Artikel.
- Tabelle: Komponenten mit Soll-Menge + Maßeinheit (die gefilterte,
  eingefrorene Liste), Checkbox-Spalte zum Abhaken am Arbeitsplatz;
  Fußzeile: Notizen, Unterschriften. Der Zettel wandert mit der Ware bis
  zum Packtisch (Ablauf: docs/module/versand.md).
- Für Lieferungen ohne Fertigung gibt es das Gegenstück **Packzettel**
  (`/lager/<id>/druck`, docs/module/versand.md).

## Abnahmekriterien

1. BoM „Tastatur" mit 20 Positionen, davon Gehäuse-Zeilen je Farbe gefiltert: MO für „Weiß" enthält genau die weiße Gehäuse-Zeile + alle ungefilterten Zeilen; MO für „Schwarz" entsprechend.
2. `produce_mo` mit voller Menge: Komponentenbestände sinken exakt um Soll×Menge, Fertigbestand steigt; alle Moves `done` und im Bewegungsprotokoll sichtbar.
3. Teilproduktion 3 von 5: Backorder-MO über 2 entsteht, Originol-MO `done` mit `qty_produced = 3`.
4. Unbuild von 1 Tastatur stellt die Komponentenmengen der passenden Variante wieder her.
5. MO-PDF enthält scanbare MO-Nummer (Code 128) und die korrekte gefilterte Komponentenliste.
6. Nach Abschluss des letzten MOs eines Shopify-Auftrags ist dessen Lieferung reserviert und erscheint in der „Versandbereit"-Liste.
7. Eine Stückliste mit Phantom-Baugruppe erzeugt Komponentenbewegungen für deren **Bestandteile**, nicht für die Baugruppe; die Herkunft steht am Auftrag.
8. Eine Position mit Verbrauchsart `manual` blockiert die Fertigmeldung, bis sie erfasst ist; `backflush`-Positionen laufen automatisch mit.
9. Nach der Fertigmeldung entspricht der Bestandswert des Fertigprodukts Material + Lohn — nachvollziehbar über die Wertschichten und die Karte „Herstellkosten".
