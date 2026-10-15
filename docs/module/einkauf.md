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

## Sendungsverfolgung im Zulauf (17TRACK, seit 2026-10-15)

Bis 0111 wurden Carrier, Tracking-Nummer und Link an Bestellung und
Eingangssendung nur gespeichert und verlinkt — abgefragt hat sie niemand.
Seit 0112 verfolgt KRNL jede Zulauf-Sendung über **17TRACK** (ein Dienst
für alle Carrier; Entscheidungslog 2026-10-15), Tabelle
`sendungsverfolgung`, eine Zeile je Beleg und Sendungsnummer:

- **Kontingent schonen — Anmeldung von Hand ist der Standard (0113):**
  das 17TRACK-Kontingent zählt angemeldete Sendungen (200 im Jahr im
  Free-Plan; Abfragen kosten nichts). Eine Sendungsnummer am Beleg wird
  deshalb nur **vorgemerkt** („Vorgemerkt · nicht angemeldet") — kostet
  nichts, liefert aber keinen Stand. **„Verfolgen (1 vom Kontingent)"** am
  Beleg meldet die Sendung an und holt den Stand; der Knopf nennt, wie
  viele Sendungen noch frei sind (gemerkter Stand aus `settings
  track17_kontingent`, aktualisiert nach jeder Anmeldung und stündlich vom
  Wächter — kein 17TRACK-Aufruf je Seitenansicht). Einstellungen →
  Schnittstellen: **„Jede Sendungsnummer automatisch anmelden"** (Registry
  `einstellungen.sendungsverfolgung_setzen`, `settings track17 {automatisch,
  reserve}`) schaltet die Automatik ein; unter der **Reserve** (Standard 20)
  meldet KRNL wieder nur von Hand an. Erschöpftes Kontingent: „Verfolgen"
  sagt es klar, der Wächter meldet eine Störung.
- **Anmelden:** `einkauf.kopf_aendern` (Tracking-Nummer der Bestellung) und
  `einkauf.sendung_anlegen/aendern/verschiffen` (HBL/AWB der
  Eingangssendung) legen die Zeile an (vorgemerkt bzw. — mit Automatik —
  „Angemeldet") und reihen dann den Outbox-Job `track17_registrieren` ein;
  der meldet die Nummer an (kostet einmalig Kontingent) und holt den ersten
  Stand. Der Carrier-Text wird auf
  den 17TRACK-Code abgebildet (`track17-logik.ts`: DHL, DHL Express, DPD,
  GLS, UPS, FedEx, K+N, Schenker, Maersk, …), sonst erkennt 17TRACK ihn
  selbst. Abgelehnte Nummern (Format, Carrier nicht erkennbar) stehen als
  **„Nicht verfolgbar"** mit Grund — Seefracht-HBLs sind meist nicht
  verfolgbar, Luft- und Kuriersendungen schon. Limit-Ablehnungen wiederholt
  die Outbox mit Backoff. Angemeldet wird mit `lang: de` — DHL, DPD & Co.
  liefern ihre Ereignisse dann auf Deutsch (dieselben Texte wie auf der
  Carrier-Seite).
- **Erster Stand — Nachfassen:** direkt nach der Anmeldung hat 17TRACK
  meist noch nichts („No tracking information at this time",
  -18019909) und sammelt erst. Die Zeile steht dann auf **„Angemeldet ·
  17TRACK sammelt noch"** und nennt die nächste Abfrage: der Job
  `track17_nachfassen` fragt nach 5, 15 und 45 Minuten nach; danach nimmt
  der stündliche Abruf frische Sendungen (noch ohne Stand) **jede Stunde**
  mit, nicht erst nach sechs. „Noch nicht im Tracking" heißt dagegen: der
  Carrier selbst kennt die Nummer noch nicht (oft erst nach der Abholung).
- **Stand:** Statuswechsel schiebt 17TRACK per Webhook
  (`/api/webhooks/17track`, Signatur SHA-256 „Rohtext/Key"), stündlich
  fragt der Cron `tracking` nach (je Sendung höchstens alle sechs Stunden,
  Stapel 40). Status: Angemeldet, Noch nicht im Tracking, Angekündigt,
  Unterwegs (Unterstatus „in der Zollabfertigung" u. a.), Abholbereit, In
  Zustellung, Zustellung fehlgeschlagen, Zugestellt, Problem, Abgelaufen.
  Zugestellt/abgelaufen beendet die Verfolgung. Jede Änderung ist ein
  Protokolleintrag am Beleg (Actor `track17`).
- **Telegram (0114):** abholbereit, zugestellt, Zustellung fehlgeschlagen,
  Problem und abgelaufen gehen als Nachricht an den Betreiber-Kanal
  (Benachrichtigungsart `zulauf`, Schalter unter Einstellungen →
  Benachrichtigungen) — mit Sendung, Beleg, Lieferant, letztem Ereignis
  und Link, genau einmal je Zustand.
- **„Zuletzt abgefragt" ist immer sichtbar** — wann und wie (Anmeldung,
  stündlicher Abruf, Meldung von 17TRACK, von Hand): an der Bestellung
  (Karte „Details", unter den Tracking-Feldern), an der Eingangssendung
  (Karte „Sendung"), im Zulauf-Kalender und am Wareneingang (Panel
  „Zulauf"). Dazu der Verlauf der Ereignisse.
- **Jetzt abfragen:** Registry-Aktionen `einkauf.zulauf_verfolgen`
  (Bestellung) und `einkauf.sendung_verfolgen` (Eingangssendung),
  prozessfrei (Abfragewerkzeug ohne Zustandswechsel), auch für den KI-Chat
  („Wo ist die Sendung zu P00012?"). Melden die Nummer notfalls sofort an.
- **Geänderte Nummer** legt die alte Verfolgung still; ohne Nummer wird
  nichts verfolgt. Ist 17TRACK nicht angebunden (`TRACK17_API_KEY`), steht
  die Zeile ehrlich auf „Nicht verfolgbar — 17TRACK nicht angebunden" und
  bekommt beim nächsten Speichern mit angebundenem Dienst eine neue Chance.
- **Betrieb:** Einstellungen → Schnittstellen zeigt Stand, Variablen,
  Kontingent und die Webhook-Adresse; der Dienste-Wächter prüft das
  Kontingent höchstens stündlich (erschöpft = Störung). Aufrufe stehen im
  Transaktionsprotokoll (System `track17`). Das Kontingent zählt
  angemeldete Sendungen, nicht Abfragen — KRNL fragt sparsam (Budget in
  [integrationen.md](integrationen.md#17track--zulauf-sendungsverfolgung-seit-2026-10-15)).
  Attrappe `TRACK17_FAKE=1` (Prozesstests, Staging).

## UI

- **Liste** mit Filter-Kacheln wie Odoo: **Zu senden**, **Wartend** (gesendet), **Verspätet** (Liefertermin überschritten); Status- und Lieferanten-Filter.
- **Formular**: Kopf (Lieferant, Lieferantenreferenz, Bestellfrist, erwartete Ankunft), Positionen, Buttons je Status, Smart-Buttons **Wareneingänge (n)** und **Rechnungen (n)**, Beleg-Verlauf (E-Mails, Statuswechsel).
- **Details-Karte (Einkäufer, Zahlungsbedingung, Incoterm, Termine, Carrier, Tracking)** hat ein eigenes „Speichern" — seit 2026-10-15 markiert sie geänderte, noch nicht gespeicherte Eingaben („Änderungen noch nicht gespeichert"), fragt beim Verlassen der Seite nach, und **„Speichern & bestätigen"** erledigt Details und Bestätigung in einem Zug (zwei Registry-Aktionen nacheinander). Grund: Tippen und dann oben „Bestellung bestätigen" drücken verlor die Eingaben stumm.

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
