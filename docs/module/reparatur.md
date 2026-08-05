# Modul Reparatur

Referenzverhalten: [docs/odoo-referenz/lager-reparatur.md](../odoo-referenz/lager-reparatur.md) (Abschnitt Repairs)

## Zweck

Reparatur zurückgesandter Tastaturen mit sauberer Bestandswirkung: verbrauchte Ersatzteile verlassen das Lager, entnommene Teile werden entsorgt oder wiederverwendet.

## Ablauf (an Odoo angelehnt)

1. **Retoure** (optional, wenn Gerät vom Kunden kommt): Auf dem ursprünglichen Verkaufsauftrag → Lieferung → „Retoure" ⇒ Rücktransfer `Partner/Kunden → WH/Stock`; validieren bucht das Gerät zurück in den Bestand und korrigiert `qty_delivered`.
2. **Reparaturauftrag** anlegen: Kunde, zu reparierendes Produkt (Variante), Menge, **Garantie-Flag** (`under_warranty`), geplantes Datum, Verantwortlicher, optionale Verknüpfung zum Rücktransfer, Notizen.
3. **Teile** (Reiter „Teile"), je Zeile mit Typ:
   - **Hinzufügen (add)**: Ersatzteile, die eingebaut werden ⇒ Verbrauch aus `WH/Stock`.
   - **Entfernen (remove)**: Teile, die aus dem Gerät ausgebaut werden ⇒ Buchung an Zielort (Default `Virtuell/Ausschuss`).
   - **Recyceln (recycle)**: ausgebaute, wiederverwendbare Teile ⇒ Zugang in `WH/Stock`.
4. **Status-Maschine**: `new → (Bestätigen) confirmed → (Reparatur starten) under_repair → (Reparatur beenden) repaired`; jederzeit vorher `cancel`.
   - **Bestätigen** reserviert die Add-Teile (Verfügbarkeits-Ampel).
   - **Beenden** bucht alle Teile-Bewegungen über die Reparatur-Vorgangsart (`repair_id` an den Moves); bei Soll ≠ Ist Nachfrage-Dialog (Odoos „Uncomplete Moves").
5. **Rücklieferung**: neuer Warenausgang an den Kunden (Button „Rücklieferung erstellen", vorbefüllt).
6. **Abrechnung**: bei Garantie keine; sonst Button **„Angebot erstellen"** ⇒ Verkaufsauftrag mit den verbrauchten Teilen (+ manuell Arbeitszeit als Dienstleistungsposition), Weiterverarbeitung im Verkaufsmodul.

## UI

- Liste mit Status-Filter und Verantwortlichem; Formular mit Teile-Tabelle, Status-Buttons, Smart-Buttons **Bewegungen (n)**, **Retoure**, **Angebot**.

## Abnahmekriterien

1. Reparatur mit 2 Add-Teilen + 1 Remove-Teil beenden: Add-Teile −2 im Bestand, Remove-Teil liegt im Ausschuss-Ort, alle Moves tragen `repair_id`.
2. Recycle-Teil erhöht den Bestand.
3. Garantie-Reparatur erzeugt kein Angebot; kostenpflichtige erzeugt Verkaufsauftrag mit den Teilen.
4. Storno gibt reservierte Teile frei.
