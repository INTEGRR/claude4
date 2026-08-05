# Modul Lager

Referenzverhalten: [docs/odoo-referenz/lager-reparatur.md](../odoo-referenz/lager-reparatur.md)

## Zweck

Zentrale Bestandsführung: alle Warenbewegungen (Eingang, Ausgang, Fertigung, Inventur, Ausschuss, Storno/Retoure) als einheitliches Bewegungs-Ledger, mit Barcode-Unterstützung.

## Lagerorte

Seed-Struktur (ein Lagerhaus `WH`, hierarchisch, Odoo-Typen):

```
WH/Stock                      (internal)   — Hauptlager
Partner/Lieferanten           (vendor)     — virtueller Herkunftsort gekaufter Ware
Partner/Kunden                (customer)   — virtueller Zielort verkaufter Ware
Virtuell/Produktion           (production) — Komponentenverbrauch / Fertigprodukt-Entstehung
Virtuell/Inventurdifferenz    (inventory_loss)
Virtuell/Ausschuss            (inventory_loss, is_scrap)
```

Interne Unterorte (Regale/Zonen) sind über `parent_id` möglich, UI im ersten Ausbau auf `WH/Stock` fokussiert. Nur **interne** Orte zählen zum eigenen Bestand. Jeder Ort kann einen **Barcode** tragen (druckbare Orts-Etiketten).

## Vorgangsarten

| Vorgangsart | Kind | Belegkreis | Quelle → Ziel | Backorder |
|---|---|---|---|---|
| Wareneingang | receipt | `WH/IN/` | Partner/Lieferanten → WH/Stock | ask |
| Warenausgang | delivery | `WH/OUT/` | WH/Stock → Partner/Kunden | ask |
| Interner Transfer | internal | `WH/INT/` | WH/Stock → WH/Stock | ask |
| Reparatur | repair | `WH/REP/` | WH/Stock → WH/Stock | never |

Je Vorgangsart: Reservierungsmethode (`at_confirm` Default, `manual` möglich), Backorder-Politik (`ask`/`always`/`never`), Retouren-Vorgangsart.

## Transfers (Pickings) & Bewegungen (Moves)

- Status: `draft → confirmed → assigned (Bereit) → done`, dazu `waiting` (fehlende Verfügbarkeit/Vorgänger) und `cancel`.
- **Reservierung**: `assigned`, wenn `on_hand − reserved` am Quellort ausreicht; Button „Verfügbarkeit prüfen"; Reservierung erhöht `stock_quants.reserved`.
- **Validieren** (`validate_picking`): Ist-Mengen erfassen (Default = Soll) → Moves `done`, Quants fortgeschrieben (Quelle −, Ziel +; nur interne Orte wirken auf den Bestand), Rückschreibung in Quellbeleg (`qty_received` / `qty_delivered`), Backorder-Dialog bei Teilmengen.
- **Stornieren**: nur nicht-erledigte Transfers; Reservierungen werden freigegeben. **Erledigte Transfers sind unveränderlich** — Korrektur ausschließlich per **Retoure** (Button „Retoure": erzeugt Gegen-Picking mit getauschten Orten, verknüpft über `return_of_id`).
- Bewegungsarten im Protokoll unterscheidbar über Quelle/Ziel bzw. Verknüpfung: Wareneingang, Warenausgang, interner Transfer, **Fertigungsverbrauch/-zugang** (`production_id`), **Demontage** (`unbuild_id`), **Reparatur** (`repair_id`), **Inventur** (Gegenort Inventurdifferenz), **Ausschuss** (Ziel Ausschuss-Ort).

## Bestände & Ansichten

- **Bestandsliste** je Variante: On Hand, Reserviert, Frei verfügbar, Eingehend, Ausgehend, Prognostiziert (Formeln siehe Datenmodell); Drill-down auf Orte.
- **Bewegungsprotokoll** je Variante (alle `done`-Moves chronologisch mit Beleg-Link) — beantwortet „warum ist der Bestand so?".
- **Nachschub-Hinweis** (einfach): Liste aller Varianten mit `forecasted < 0` als Einkaufs-Vorschlag (volle Meldebestandsregeln = Erweiterung).

## Inventur & Ausschuss

- **Inventur**: Zeile (Ort, Variante, gezählte Menge) → **Anwenden** bucht Differenz gegen `Virtuell/Inventurdifferenz` und setzt On Hand auf den Zählwert. Warnung, wenn sich der Buchbestand zwischen Zählung und Anwenden geändert hat.
- **Ausschuss**: eigenes Mini-Formular (Variante, Menge, Quellort) → Move nach `Virtuell/Ausschuss`; auch aus MO/Reparatur heraus aufrufbar.

## Barcode-Unterstützung

Pragmatischer Ansatz statt vollständiger Odoo-Barcode-App: **USB-Scanner (Keyboard-Wedge) + Scan-Feld** in den relevanten Masken.

- Globales Scan-Feld im Lagerbereich: Scan einer Belegnummer (`WH/IN/00001`, `MO/00001`) öffnet den Beleg; Scan eines Produkt-Barcodes öffnet die Variante.
- In der Transfer-Validierung: Produkt-Scan zählt die Ist-Menge der passenden Zeile hoch (+1 je Scan, Odoo-Verhalten), unbekannter Barcode ⇒ Fehlerton/Meldung.
- Etikettendruck: Produkt-Etiketten (Name, Variante, SKU, Barcode) und Lagerort-Etiketten als PDF.
- Erweiterung später: eigene mobile Scan-Ansicht (PWA) für kompletten pickinglosen Ablauf.

## Abnahmekriterien

1. Jede Bestandsänderung im System hat genau einen `done`-Move; Summe der Moves = angezeigter Bestand (Invariante, per Test abgesichert).
2. Wareneingang validieren erhöht On Hand; Warenausgang reserviert vorher und reduziert bei Validierung.
3. Storno eines reservierten Transfers gibt die Reservierung frei; erledigter Transfer lässt sich nur per Retoure ausgleichen.
4. Inventur-Anwenden erzeugt exakt die Differenzbuchung gegen den Inventurdifferenz-Ort.
5. Produkt-Scan in der Validierungsmaske erhöht die richtige Zeile; Beleg-Scan öffnet den Beleg.
