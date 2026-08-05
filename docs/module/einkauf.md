# Modul Einkauf

Referenzverhalten: [docs/odoo-referenz/einkauf.md](../odoo-referenz/einkauf.md)

## Zweck

Komponenten bei Lieferanten bestellen: Angebotsanfrage → Bestellung → Wareneingang → Lieferantenrechnung. Mit E-Mail-Versand, Stornieren und Sperren.

## Lieferanten & Preise

- Lieferant = `partners`-Eintrag mit `is_vendor` (Name, E-Mail für Bestellversand, Adresse, USt-ID, Zahlungsziel).
- **Lieferantenpreisliste** (`vendor_prices`) am Produkt: Lieferant, Mindestmenge, Preis, Lieferzeit (Tage), Lieferanten-Artikelnummer, Priorität. Beim Erfassen einer Bestellposition werden Preis + Lieferzeit des gewählten Lieferanten automatisch übernommen (beste Zeile: passender Lieferant, `min_qty` erfüllt, kleinste Sequenz).

## Status-Maschine (`purchase_orders.state`, Odoo-18-Werte)

```
draft (Angebotsanfrage) ──(Per E-Mail senden)──▶ sent
draft/sent ──(Bestellung bestätigen)──▶ purchase ──(Sperren)──▶ done
purchase/done ──(Entsperren)──▶ purchase
draft/sent/purchase ──(Stornieren)──▶ cancel ──(Auf Entwurf setzen)──▶ draft
```

- **Per E-Mail senden**: Compose-Dialog mit Vorlage („Angebotsanfrage P00001 von {Firma}"), Empfänger = Lieferanten-E-Mail, **Bestell-PDF als Anhang** (Positionen, Mengen, Preise, Liefertermin). Versand über Resend (Outbox-Job), Protokoll am Beleg. Status → `sent`. Zusätzlich Button „PDF herunterladen".
- **Bestätigen** (`confirm_purchase_order`): Status → `purchase`, `confirmed_at` gesetzt, `expected_arrival` = heute + max. Lieferzeit der Positionen; **Wareneingang automatisch anlegen** (Picking Vorgangsart Wareneingang, `Partner/Lieferanten → WH/Stock`, ein Move je Position, Menge in Lager-UoM umgerechnet, `origin` = Bestellung).
- **Sperren**: Status `done` (Odoo nutzt `done` als „Locked"); Beleg schreibgeschützt. Option „Bestätigte Bestellungen automatisch sperren" als Einstellung.
- **Stornieren**: nur wenn kein Wareneingang validiert ist ⇒ offene Eingänge → `cancel`, Status → `cancel`. Mit validierten Eingängen: blockieren mit Hinweis (Korrektur über Retoure).

## Bestellpositionen

Variante, Beschreibung, **Menge + Einkaufs-Maßeinheit**, Einzelpreis, Steuersatz; berechnete Spalten **Erhalten** (`qty_received`, aus validierten Eingängen, in Einkaufs-UoM zurückgerechnet) und **Abgerechnet** (`qty_billed`, aus gebuchten Rechnungen).

## Wareneingang & Rückstände

- Eingang wird im Lager-Modul abgearbeitet (Liste „Wareneingänge"). Validieren bucht `Partner/Lieferanten → WH/Stock`, aktualisiert `qty_received` und den Bestand.
- **Teillieferung**: Backorder-Dialog gemäß Vorgangsart (`ask` als Default): Rest-Eingang erzeugen / Rest aufgeben / abbrechen. Backorder bleibt mit der Bestellung verknüpft.

## Lieferantenrechnungen

- **Abrechnungsrichtlinie** (`bill_policy` je Produkt, Default `received`): `ordered` = Rechnung ab Bestätigung über bestellte Mengen; `received` = erst nach Wareneingang über erhaltene Mengen (Versuch vorher ⇒ Fehlermeldung).
- Button **Rechnung erstellen** auf der Bestellung ⇒ Entwurfsrechnung mit vorbefüllten Positionen (Richtlinie beachtet, bereits abgerechnete Mengen abgezogen) → Rechnungsdatum + Lieferantenreferenz erfassen → **Buchen** (`posted`, aktualisiert `qty_billed` + `billing_status`) → **Zahlung erfassen** (`paid`, Datum).
- **Stornieren**: Entwurf ⇒ `cancel`. Gebuchte Rechnung ⇒ **Gutschrift** (`is_credit_note`, `reversed_bill_id`), die `qty_billed` wieder reduziert.
- `billing_status` auf der Bestellung: `nothing` / `waiting` / `fully_billed` gemäß Odoo-Tabelle (siehe Referenz).

## UI

- **Liste** mit Filter-Kacheln wie Odoo: **Zu senden**, **Wartend** (gesendet), **Verspätet** (Liefertermin überschritten); Status- und Lieferanten-Filter.
- **Formular**: Kopf (Lieferant, Lieferantenreferenz, Bestellfrist, erwartete Ankunft), Positionen, Buttons je Status, Smart-Buttons **Wareneingänge (n)** und **Rechnungen (n)**, Beleg-Verlauf (E-Mails, Statuswechsel).

## Abnahmekriterien

1. Bestellung mit 3 Positionen bestätigen ⇒ genau 1 Wareneingang mit 3 Moves, `expected_arrival` korrekt aus Lieferzeiten.
2. E-Mail-Versand: Lieferant erhält Mail mit PDF; Beleg zeigt Versandprotokoll; Status `sent`.
3. Teillieferung 6 von 10 mit Backorder ⇒ `qty_received = 6`, Backorder-Eingang über 4, Bestand +6.
4. `bill_policy = received`: Rechnungserstellung vor Eingang wird mit Fehlermeldung abgelehnt; nach Teileingang enthält die Entwurfsrechnung 6 Stück.
5. Gutschrift auf gebuchte Rechnung reduziert `qty_billed` und setzt `billing_status` zurück auf `waiting`.
6. Gesperrte Bestellung (`done`) ist unveränderbar bis „Entsperren".
