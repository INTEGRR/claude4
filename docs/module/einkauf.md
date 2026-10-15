# Modul Einkauf

Referenzverhalten: [docs/odoo-referenz/einkauf.md](../odoo-referenz/einkauf.md)

## Zweck

Komponenten bei Lieferanten bestellen: Angebotsanfrage → Bestellung → Wareneingang → Lieferantenrechnung. Mit E-Mail-Versand, Stornieren und Sperren.

Das **Einkaufstool** (Dokumente in Google Drive, Lieferantenakte, Postfach,
Projekte, Sendungen/Zoll) beschreibt [einkaufstool.md](einkaufstool.md).

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

## Bestellung aus Beleg erfassen (`einkauf.bestellung_erfassen`)

Für Bestellungen, die außerhalb von KRNL schon liefen: per Alibaba
bestellt und bezahlt, die Commercial Invoice liegt vor, die Ware ist
unterwegs. Eine Aktion (`ki`, prozessfrei als alternativer Einstieg wie
`bestellung_mit_positionen`) macht in **einer** Transaktion:

- **Lieferant** auflösen (Name, Referenz, ID); mit `lieferant_neu` und
  `lieferant_land` anlegen (Firma, Lieferant, Standardwährung und
  -Incoterm aus dem Beleg). Ein vorhandener gewinnt immer — es entsteht
  kein Doppelter.
- **Positionen**: `produkt` (vorhanden) oder `artikel_neu` + `sku_neu`
  (neues Kaufteil, einkaufbar, Route kaufen; eine schon vergebene SKU wird
  wiederverwendet statt verdoppelt). Preise bleiben in der Belegwährung —
  `purchase_order_lines.price_unit` hat sechs Nachkommastellen, 0,011 USD
  passt.
- **Kopf**: `waehrung`, `incoterm_code`, `referenz` → `vendor_reference`,
  `eta` → `expected_arrival`, Notiz mit Belegnummer.
- `versandkosten` → Dienstleistungszeile „Fracht laut Beleg" (der Artikel
  wird einmal angelegt); Dienstleistungen kommen nicht in den Wareneingang.
- `bestaetigen` (Vorgabe) → `confirm_purchase_order`: Kurs eingefroren,
  Wareneingang entsteht; `bestelldatum` setzt `confirmed_at` auf den
  Belegtag zurück (im Entwurf wird es `order_deadline`).
- `bezahlt` → Zahlplan-Rate „Vorkasse 100 %" (fester `betrag` =
  `bezahlt_betrag`, sonst 100 % der Bestellsumme) und
  `zahlung_erfassen(… 'po_rate' …)` in Belegwährung am `bezahlt_am` — die
  Zahlung steht damit im Register (Finanzen) und die Rate ist bezahlt.
- Fehlt ein Kurs für die Währung, rechnet KRNL 1:1 und sagt es im Ergebnis
  (EZB-Kurse holen).

Der Beleg selbst wird vom KI-Chat über **`einkauf.beleg_ablegen`**
(beleggebunden, nicht `ki`) an der Bestellung abgelegt: Inhalt base64 im
Aufruf, Drive-Upload in einem Stück, Dublettenprüfung über md5 je
Lieferant wie bei Mail-Anhängen, Verweise auf Bestellung und Lieferant,
danach liest der Dokument-Leser des Einkaufs die Datei. Nachweis:
[`tests/prozesse/bestellung-erfassen.test.ts`](../../tests/prozesse/bestellung-erfassen.test.ts),
Schema und Zeilenregel in `tests/ki-anhaenge.test.ts`.

## Wareneingang & Rückstände

- Eingang wird im Lager-Modul abgearbeitet (Liste „Wareneingänge"). Validieren bucht `Partner/Lieferanten → WH/Stock`, aktualisiert `qty_received` und den Bestand.
- **Teillieferung**: Backorder-Dialog gemäß Vorgangsart (`ask` als Default): Rest-Eingang erzeugen / Rest aufgeben / abbrechen. Backorder bleibt mit der Bestellung verknüpft.

## Lieferantenrechnungen

- **Abrechnungsrichtlinie** (`bill_policy` je Produkt, Default `received`): `ordered` = Rechnung ab Bestätigung über bestellte Mengen; `received` = erst nach Wareneingang über erhaltene Mengen (Versuch vorher ⇒ Fehlermeldung). Dienstleistungen stehen immer auf `ordered` (Trigger, 0092).
- **Dienstleistungen** (0092) erzeugen beim Bestätigen keine Lagerbewegung; eine reine Dienstleistungs-Bestellung hat keinen Wareneingang, die Weiche „Lagerware dabei?" führt direkt zur Rechnung. Einkaufspreise haben 6 Nachkommastellen.
- Button **Rechnung erstellen** auf der Bestellung ⇒ Entwurfsrechnung mit vorbefüllten Positionen (Richtlinie beachtet, bereits abgerechnete Mengen abgezogen) → Rechnungsdatum + Lieferantenreferenz erfassen → **Buchen** (`posted`, aktualisiert `qty_billed` + `billing_status`) → **Zahlung erfassen** (`paid`, Datum).
- **Stornieren**: Entwurf ⇒ `cancel`. Gebuchte Rechnung ⇒ **Gutschrift** (`is_credit_note`, `reversed_bill_id`), die `qty_billed` wieder reduziert.
- `billing_status` auf der Bestellung: `nothing` / `waiting` / `fully_billed` gemäß Odoo-Tabelle (siehe Referenz).

## UI

- **Liste** mit Filter-Kacheln wie Odoo: **Zu senden**, **Wartend** (gesendet), **Verspätet** (Liefertermin überschritten); Status- und Lieferanten-Filter.
- **Formular**: Kopf (Lieferant, Lieferantenreferenz, Bestellfrist, erwartete Ankunft), Positionen, Buttons je Status, Smart-Buttons **Wareneingänge (n)** und **Rechnungen (n)**, Beleg-Verlauf (E-Mails, Statuswechsel).

### Querverweise (seit 2026-10-01)

Jeder Name und jede Belegnummer ist ein Link, Statusschilder führen zu den
Belegen dahinter (`<Badge href>`; Regel „ein Beleg → direkt, mehrere → die
Karte an der Bestellung", `src/app/(erp)/einkauf/querverweise.ts`):

- **Lieferant** → Lieferantenakte (`/einkauf/lieferanten/[id]`) — in
  Bestellliste und -kopf, Rechnungsliste und -kopf, Projekten (Anfragen,
  Angebote, Entscheidung, Bestellungen, Preishistorie).
- **Bestellliste**: Status „Bestellung" → Wareneingang (`/lager/[id]`),
  Abrechnung („Rechnung erwartet" / „Vollständig abgerechnet") → Rechnung;
  das Einkaufsprojekt steht als `EP/…` unter der Nummer.
- **Bestellung**: dieselben Schilder im Kopf, Projekt im Untertitel,
  Wareneingangs- und Rechnungsschilder führen zum Beleg; Anker
  `#wareneingaenge`, `#rechnungen`, `#zahlplan`.
- **Rechnung**: Bestellung, stornierte Rechnung ↔ Gutschrift in beide
  Richtungen; die 3-Way-Ampel führt zu den Wareneingängen der Bestellung;
  eine Zahlplan-Zahlung führt zum Zahlplan der Bestellung.
- **Lieferantenakte**: Status → Bestellung/Rechnung, Belege an Dateien und
  Artikel der Lieferantenpreise sind klickbar, Tracking-Nummer → Tracking-Link.
- **Einkaufstool**: Posteingang und Entwürfe verlinken Bestellung, Projekt
  und Gespräch; „Gesendet" führt zum Thread; der Anfragestatus im Projekt
  führt zum Gespräch (sonst zum Entwurf); Wiedervorlagen kennen auch
  Einkaufsprojekte.

## Abnahmekriterien

1. Bestellung mit 3 Positionen bestätigen ⇒ genau 1 Wareneingang mit 3 Moves, `expected_arrival` korrekt aus Lieferzeiten.
2. E-Mail-Versand: Lieferant erhält Mail mit PDF; Beleg zeigt Versandprotokoll; Status `sent`.
3. Teillieferung 6 von 10 mit Backorder ⇒ `qty_received = 6`, Backorder-Eingang über 4, Bestand +6.
4. `bill_policy = received`: Rechnungserstellung vor Eingang wird mit Fehlermeldung abgelehnt; nach Teileingang enthält die Entwurfsrechnung 6 Stück.
5. Gutschrift auf gebuchte Rechnung reduziert `qty_billed` und setzt `billing_status` zurück auf `waiting`.
6. Gesperrte Bestellung (`done`) ist unveränderbar bis „Entsperren".
