# Modul Fertigung

Referenzverhalten: [docs/odoo-referenz/fertigung.md](../odoo-referenz/fertigung.md)

## Zweck

Tastaturen (und künftig weitere Produkte) anhand von Stücklisten fertigen. Kernanforderungen: Stücklisten mit ~20 Positionen (Menge + Maßeinheit je Position), **variantenabhängige Komponenten** („Auf Varianten anwenden"), Fertigungsaufträge mit Bestandswirkung, **druckbare Fertigungsaufträge mit Barcode**, Demontage.

## Stücklisten (BoM)

- Kopf: Produkt (Vorlage), optionale exklusive Variante, Referenzmenge + Maßeinheit, Typ (`manufacture`; `kit` als vorbereiteter Enum-Wert), Verbrauchsregel (`blocked`/`allowed`/`warning`).
- Positionen: Komponente (Variante), Menge, Maßeinheit, optional „Manueller Verbrauch".
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
- **Starten**: Status `progress` (Zeitstempel; Arbeitsaufträge/Workcenter sind bewusst NICHT im ersten Ausbau — Erweiterungspunkt).
- **Produzieren** (`produce_mo`): produzierte Menge erfassen (Default = Sollmenge).
  - Bucht Komponentenverbrauch `WH/Stock → Virtuell/Produktion` (anteilig zur produzierten Menge) und Fertigprodukt-Zugang `Virtuell/Produktion → WH/Stock`.
  - Abweichender Ist-Verbrauch je Komponente editierbar; Verhalten gemäß BoM-Verbrauchsregel (blockieren/erlauben/warnen).
  - Teilmenge ⇒ Backorder-Dialog: Rest-MO (`backorder_of_id`) oder Rest verwerfen.
  - Danach `done`; wenn `sales_order_id` gesetzt und alle MOs des Auftrags `done` ⇒ Integration-Job `shopify_tag_add` („ready-to-ship") einreihen und zugehörige Lieferung reservieren.
- **Stornieren**: offene Komponenten-Moves → `cancel`, Reservierungen freigeben.

## Demontage (Unbuild)

Formular: Variante, BoM (auto), Menge, optionaler Ursprungs-MO, Quell-/Ziellagerort. Aktion **Demontieren**: Fertigprodukt −Menge, Komponenten +Mengen laut (gefilterter) BoM, proportional. Warnung bei resultierendem Negativbestand mit explizitem Bestätigen (Odoo-Verhalten). Defekte Teile anschließend über Ausschuss-Buchung (Lager-Modul) ausbuchen.

## Drucken (Kernanforderung)

- **Fertigungsauftrag-PDF** (`@react-pdf/renderer`), angelehnt an Odoos `Production Order`-Report:
  - Kopf: MO-Nummer **als Code-128-Barcode**, Produkt + Variante (Attributwerte), Menge, geplantes Datum, Quell-Verkaufsauftrag (inkl. Shopify-Ordername).
  - Tabelle: Komponenten mit Soll-Menge + Maßeinheit (die gefilterte, eingefrorene Liste), Checkbox-Spalte zum Abhaken am Arbeitsplatz.
  - Fußzeile: Notizen.
- **Produkt-Etikett** je gefertigter Einheit: Produktname + Variante, SKU, Barcode (EAN falls vorhanden, sonst Code 128 der SKU). Druck aus dem MO heraus („n Etiketten drucken").
- Alle PDFs serverseitig erzeugt, in Supabase Storage abgelegt und im Browser geöffnet (Print-Dialog).

## Abnahmekriterien

1. BoM „Tastatur" mit 20 Positionen, davon Gehäuse-Zeilen je Farbe gefiltert: MO für „Weiß" enthält genau die weiße Gehäuse-Zeile + alle ungefilterten Zeilen; MO für „Schwarz" entsprechend.
2. `produce_mo` mit voller Menge: Komponentenbestände sinken exakt um Soll×Menge, Fertigbestand steigt; alle Moves `done` und im Bewegungsprotokoll sichtbar.
3. Teilproduktion 3 von 5: Backorder-MO über 2 entsteht, Originol-MO `done` mit `qty_produced = 3`.
4. Unbuild von 1 Tastatur stellt die Komponentenmengen der passenden Variante wieder her.
5. MO-PDF enthält scanbare MO-Nummer (Code 128) und die korrekte gefilterte Komponentenliste.
6. Nach Abschluss des letzten MOs eines Shopify-Auftrags liegt ein `shopify_tag_add`-Job in der Outbox.
