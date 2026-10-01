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
- **Live-Reservierung** (seit 0086): Wird an einem internen Ort Ware frei — Bestand rauf (Inventur, Wareneingang, Fertigmeldung, Retoure) oder Reservierung runter (Storno) —, reserviert die Datenbank sofort die wartenden Bewegungen desselben Artikels: Transfers mit Reservierung „bei Bestätigung" und Komponenten laufender Fertigungsaufträge, ältester Termin zuerst, sonst Teilreservierung. Constraint-Trigger auf `stock_quants`, am Ende der Transaktion — ausdrückliche Reservierungen derselben Buchung haben Vorrang (die Fertigmeldung bedient zuerst ihren Auftrag). Ein Status „wartet" veraltet damit nicht mehr; „Verfügbarkeit prüfen" bleibt als Knopf, ist aber nicht mehr nötig. Funktion `wartende_bewegungen_reservieren(variant, ort)`; Entscheidungslog 2026-09-29.
- **Validieren** (`validate_picking`): Ist-Mengen erfassen (Default = Soll) → Moves `done`, Quants fortgeschrieben (Quelle −, Ziel +; nur interne Orte wirken auf den Bestand), Rückschreibung in Quellbeleg (`qty_received` / `qty_delivered`), Backorder-Dialog bei Teilmengen.
- **Kommissionieren** (seit 0091): Lieferungen im Status `assigned` können vor dem Packtisch gesammelt werden (Handy/Tablet oder Packzettel). Der Fortschritt steht je Bewegung in `stock_moves.qty_kommissioniert` — getrennt von `qty_done`, gebucht wird erst beim Warenausgang. Die Lieferung trägt `kommissioniert_am/_von` als Tatsache, der Status bleibt `assigned`; `kommissionierung_von/_seit` ist die Sperre gegen zwei Sammler (30 Minuten). Ablauf und Oberfläche: [versand.md](versand.md), Abschnitt „Kommissionieren".
- **Stornieren**: nur nicht-erledigte Transfers; Reservierungen werden freigegeben. **Erledigte Transfers sind unveränderlich** — Korrektur ausschließlich per **Retoure** (Button „Retoure": erzeugt Gegen-Picking mit getauschten Orten, verknüpft über `return_of_id`).
- Bewegungsarten im Protokoll unterscheidbar über Quelle/Ziel bzw. Verknüpfung: Wareneingang, Warenausgang, interner Transfer, **Fertigungsverbrauch/-zugang** (`production_id`), **Demontage** (`unbuild_id`), **Reparatur** (`repair_id`), **Inventur** (Gegenort Inventurdifferenz), **Ausschuss** (Ziel Ausschuss-Ort).

## Bestände & Ansichten

- **Bestandsliste** je Variante: On Hand, Reserviert, Frei verfügbar, Eingehend, Ausgehend, Prognostiziert (Formeln siehe Datenmodell); Drill-down auf Orte.
- **Bewegungsprotokoll** je Variante (alle `done`-Moves chronologisch mit Beleg-Link) — beantwortet „warum ist der Bestand so?".
- **Nachschub-Hinweis** (einfach): Liste aller Varianten mit `forecasted < 0` als Einkaufs-Vorschlag (volle Meldebestandsregeln = Erweiterung).
- **Querverweise (2026-10-01)**: In Transferliste und -formular sind Partner (→ Kontakt), Quellbeleg (`origin_model` → Verkauf/Einkauf/Reparatur/Fertigung/Vorgang, eine Zuordnung in `lager/herkunft.ts`), Status-Schild, Rückstand/Retoure in beide Richtungen, die Reparatur, deren Rückversand der Transfer ist, und die Produkte der Positionen verlinkt. Filter **`/lager?auftrag=<Verkaufsauftrag>`** zeigt alle Transfers eines Auftrags (Hinweisleiste mit Auftrag und „Filter aufheben"; Art- und Zustandsfilter bleiben kombinierbar) — Ziel des Lieferstatus-Schilds im Verkauf.

## Inventur & Ausschuss

- **Inventur**: Zeile (Ort, Variante, gezählte Menge) → **Anwenden** bucht Differenz gegen `Virtuell/Inventurdifferenz` und setzt On Hand auf den Zählwert. Warnung, wenn sich der Buchbestand zwischen Zählung und Anwenden geändert hat.
  Mehrbestand erreicht wartende Lieferungen und Fertigungskomponenten sofort (Live-Reservierung, siehe oben).
- **Ausschuss**: eigenes Mini-Formular (Variante, Menge, Quellort) → Move nach `Virtuell/Ausschuss`; auch aus MO/Reparatur heraus aufrufbar.

## Barcode-Unterstützung

Pragmatischer Ansatz statt vollständiger Odoo-Barcode-App: **USB-Scanner (Keyboard-Wedge) + Scan-Feld** in den relevanten Masken.

- Globales Scan-Feld im Lagerbereich: Scan einer Belegnummer (`WH/IN/00001`, `MO/00001`) öffnet den Beleg; Scan eines Produkt-Barcodes öffnet die Variante.
- In der Transfer-Validierung: Produkt-Scan zählt die Ist-Menge der passenden Zeile hoch (+1 je Scan, Odoo-Verhalten), unbekannter Barcode ⇒ Fehlerton/Meldung.
- Etikettendruck: **Artikel-Etiketten** (Name, Merkmale der Variante, Barcode bzw. SKU als Code, SKU) über `lager.artikeletikett_drucken` — an der Variante mit Anzahl und nach dem **Wareneingang** (Karte „Artikel-Etiketten" am erledigten Eingang, je Zeile vorbelegt mit der gebuchten Menge, 0 = auslassen); am Etikettendrucker des Arbeitsplatzes im Format dieses Druckers, sonst als PDF im Browser (docs/module/versand.md „Etiketten", seit 2026-10-01). Lagerort-Etiketten sind noch offen.
- Mobile Scan-Ansicht fürs Sammeln: `/kommissionieren` (Handscanner per Bluetooth oder Handykamera, seit 0091). Lagerplätze je Artikel sind noch nicht modelliert — gesammelt wird nach Artikelname.

## Abnahmekriterien

1. Jede Bestandsänderung im System hat genau einen `done`-Move; Summe der Moves = angezeigter Bestand (Invariante, per Test abgesichert).
2. Wareneingang validieren erhöht On Hand; Warenausgang reserviert vorher und reduziert bei Validierung.
3. Storno eines reservierten Transfers gibt die Reservierung frei; erledigter Transfer lässt sich nur per Retoure ausgleichen.
4. Inventur-Anwenden erzeugt exakt die Differenzbuchung gegen den Inventurdifferenz-Ort.
5. Produkt-Scan in der Validierungsmaske erhöht die richtige Zeile; Beleg-Scan öffnet den Beleg.
