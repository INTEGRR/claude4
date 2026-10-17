# Modul Verkauf

Referenzverhalten: [docs/odoo-referenz/verkauf.md](../odoo-referenz/verkauf.md)

## Zweck

Verkaufsaufträge verwalten — bei uns entstehen sie fast ausschließlich **automatisch aus Shopify** (bereits bezahlt, direkt im Status „Verkaufsauftrag"). Manuelles Anlegen muss trotzdem möglich sein (B2B, Sonderfälle).

## Status-Maschine (`sales_orders.state`)

```
draft ──(Per E-Mail senden)──▶ sent
draft/sent ──(Bestätigen)──▶ sale ──(Stornieren — nur manuelle Aufträge)──▶ cancel
Shop-Auftrag ──(Storno/Erstattung in Shopify → Webhook)──▶ cancel
cancel/sent ──(Auf Angebot zurücksetzen — nur manuelle Aufträge)──▶ draft
sale: Sperren/Entsperren über Flag `locked` (kein eigener Status — Odoo-18-Verhalten)
```

- **Bestätigen** (`confirm_sales_order`):
  1. Nummer aus Sequenz (falls noch keine), Status → `sale`.
  2. **Lieferauftrag anlegen**: ein Picking (Vorgangsart Warenausgang, `WH/Stock → Partner/Kunden`) mit einem Move je lagergeführter Position; Status `confirmed`, Reservierung gemäß Vorgangsart.
  3. **Fertigung anlegen (MTO)**: für jede Position, deren Produkt `route_manufacture + route_mto` hat und eine aktive Stückliste besitzt → ein Fertigungsauftrag je Position (Variante, Menge, `sales_order_id` als Quellbeleg), Status direkt `confirmed`. Odoo-Verhalten: MTO beschafft auch bei vorhandenem Bestand.
  4. Produkte ohne Fertigungsroute werden nur über den Lieferauftrag bedient (ab Lager).
- **Stornieren** (`cancel_sales_order`, Stand 0110): offene Lieferungen samt Reservierung → `cancel`; nicht begonnene Fertigungsaufträge werden storniert (seit 0029), angebrochene bleiben mit Hinweis; offene Druckaufträge und wartende Shop-Rückmeldungen werden zurückgezogen; danach storniert der Nachlauf DHL-Labels nicht übergebener Sendungen (ausgebucht, aber nicht übergeben → Aufgabe fürs Lager). **Shop-Aufträge storniert Shopify** (Entscheidungslog 2026-10-02): kein Knopf, sondern der Link „In Shopify stornieren"; KRNL meldet keinen Storno an Shopify.
- **Sperren**: `locked = true` → Beleg schreibgeschützt (UI + DB-Check in Update-Funktionen).

## Auftragspositionen

Produkt-Auswahl auf **Varianten-Ebene** (Suche über SKU/Name inkl. Attributwerte). Felder: Variante, Beschreibung, Menge, Maßeinheit, Einzelpreis, Rabatt %, Steuersatz, berechnete Spalten **Geliefert** und **Abgerechnet**. Strukturzeilen `section`/`note` für Gliederung.

## Berechnete Status

- **Lieferstatus** (`delivery_status`): `pending` → `partial` → `full`, abgeleitet aus den Pickings (siehe Datenmodell). Anzeige als Badge in Liste + Formular.
- **Abrechnungsstatus** (`invoice_status`): `no` / `to_invoice` / `invoiced` gemäß Abrechnungspolitik des Produkts (Standard: nach bestellter Menge). Kundenrechnungen selbst sind im ersten Ausbau **nicht** enthalten (Shopify rechnet ab); das Feld hält den Weg frei.

## Shopify-Aufträge (siehe auch Modul Integrationen)

- `source = 'shopify'`, `shopify_order_id`/`shopify_order_name` gesetzt, Kunde per `shopify_customer_id`-Upsert.
- Bezahlte Shopify-Orders entstehen direkt in `sale` (Bestätigungslogik läuft identisch durch — Lieferung + MOs).
- Auf dem Formular: Link zur Order im Shopify-Admin, Anzeige der gesetzten Tags, Fulfillment-/Zahlungsstatus aus Shopify (read-only Info).
- Stornierte oder voll erstattete Shopify-Orders (`orders/cancelled`-Webhook) stornieren den Verkaufsauftrag samt allem Nachgelagerten (siehe Stornieren). Das ist der einzige Storno-Weg für Shop-Aufträge — Shopify führt. Gab es schon eine Rechnung (Ware versandt), bekommt jede gültige Rechnung ihre Storno-Gutschrift — bezahlt, weil der Shop erstattet hat (0115).
- **Positionen entfernen** (seit 0120): nur solange die Zeile weder geliefert noch abgerechnet noch in einer Retoure ist — sonst Korrektur über Retoure bzw. Gutschrift (`sales_order_line_entfernbar` liefert den Grund, das Formular blendet „Entfernen" dann aus). Seit 2026-10-17 ziehen Hinzufügen und Entfernen am bestätigten Auftrag Lieferung und Fertigung nach (`sales_order_lieferung_angleichen`, derselbe Weg wie eine Shop-Änderung). Wie Aufträge nach der Bestätigung grundsätzlich geändert werden, ist offen ([Entscheidungsvorlage](../vorlagen/auftragsaenderung.md)).
- **Bestellung im Shop geändert** (seit 0115): Shopify-Bestelländerungen (anderes Case, Switches getauscht, Artikel dazu, Menge weniger) kommen über `orders/updated` an. Soll je Variante ist `currentQuantity`; Positionen, Lieferung und Fertigung folgen vor dem Versand ohne Beleg, nach der Rechnung entsteht die Gutschrift automatisch — Details unter **Kundenrechnungen** und im Modul Integrationen.
- **Versand außerhalb von KRNL** (seit 2026-10-15): meldet Shopify die Order als erfüllt, ohne dass KRNL eine Sendung dazu hat (Sendcloud läuft parallel), bucht KRNL den Warenausgang der offenen Lieferungen nach — der Auftrag ist geliefert, die Lieferung trägt die Trackingdaten des Shops („extern · DHL …" in der Lieferungsliste). Ein noch offener Fertigungsauftrag bleibt stehen und wird zur Nachfrage ans Team Fertigung (Aufgabe): Fertig melden (Material verbrauchen, Erzeugnis buchen) oder stornieren und den Bestand korrigieren — die Nachfragen stehen als Karte auf `/fertigung` und haken sich mit der Entscheidung von selbst ab. Vor der Umstellung versendete Aufträge holt der Versand-Abgleich offener Shop-Aufträge nach (Monitor, Cron). Details im Modul Integrationen (Order-Import).

## Kundenrechnungen (Migration 0115, seit 2026-10-16)

Rechnungen an Kunden kommen aus KRNL, nicht mehr aus Shopify
(Entscheidungslog 2026-10-16). Tabellen `kundenrechnungen` (RE-/GU-Nummern
aus eigenen Nummernkreisen, Enum `kundenrechnung_status` offen → bezahlt /
storniert) und `kundenrechnung_positionen`; Prozess `kundenrechnung`
(Schritte rechnung → zahlen → ende, stornieren jederzeit).

**Die Rechnung entsteht mit der Lieferung.** Der Trigger auf
`stock_pickings` ruft beim Buchen eines Warenausgangs zu einem
Verkaufsauftrag `kundenrechnung_aus_lieferung` (Einstellung
`rechnung.automatisch`, Standard an; sonst Knopf „Rechnung erstellen" an
der gebuchten Lieferung, Registry `verkauf.rechnung_erstellen`):

- **Positionen** = gelieferte Menge je Variante (mehrere Bewegungen einer
  Variante werden eine Zeile) × Netto-Stückpreis der Auftragszeile, Steuer
  je Position gerundet; Bezeichnung mit Variantenname („NATIVE 75 -
  Standard / FR4 / Silent Red"), Rabatt als Listenpreis vor Rabatt
  (`sales_order_lines.listenpreis`, nur wenn der Shop einen Rabatt gab).
- **Versand** einmal je Auftrag auf der ersten gültigen Rechnung
  (`sales_orders.versandkosten` netto, Steuer zum Satz der Positionen).
- **Shop-Aufträge sind sofort bezahlt** — die Zahlung lief im Shop;
  Zahlungsart aus `paymentGatewayNames` („Shopify Payments", „PayPal",
  „Klarna" …), Rechnungsanschrift aus `billingAddress`. **Firmenkunden
  (manuelle Aufträge)** sind offen: Zahlungsart „Überweisung", fällig nach
  Zahlungsbedingung des Kunden, sonst `rechnung.zahlungsziel_tage` (14).
- Kopf: Rechnungs- und Leistungsdatum (Buchung der Lieferung),
  Kundennummer (Kontakt-Ref, sonst Shopify-Kundennummer), Kundenreferenz
  (Shop-Bestellnummer, sonst Auftragsnummer), Ansprechpartner.

**Korrekturen nur per Gutschrift — nie durch Ändern.** Eine ausgestellte
Rechnung wird nicht editiert (GoBD). `kundenrechnung_gutschrift(rechnung,
positionen, grund)` erzeugt die GU-Nummer mit Bezug zur Rechnung
(`storno_von_id`) und senkt `qty_invoiced` der Auftragszeilen:

- **Teilgutschrift** (Registry `verkauf.gutschrift_erstellen`, Positionen
  mit Menge wählen): die Rechnung bleibt gültig.
- **Storno** (`verkauf.rechnung_stornieren`) = volle Gutschrift, die
  Rechnung wird `storniert`. Bei Shop-Zahlung ist die Gutschrift sofort
  bezahlt (der Shop erstattet); bei bezahlter Überweisungsrechnung ist sie
  **offen** und steht als Erstattung (Auszahlung) in `finanz_faellig`.
- **Änderung im Shop nach der Rechnung:** der Import ruft
  `kundenrechnung_aenderung_gutschreiben(auftrag, variante, menge)` — die
  Gutschrift über die zurückgenommene Menge entsteht auf der jüngsten
  gültigen Rechnung, ohne Zutun. Kommt Ware dazu, entsteht die zweite
  Lieferung und mit ihr die zweite Rechnung (ohne Versand). Das war der
  Fehler des alten Weges: Gutschrift ohne neue Rechnung.

**Zahlung, Mahnung, Forderungen.** `verkauf.rechnung_zahlen` bucht die
Einzahlung ins Zahlungsregister (`zahlungen.quelle = 'kundenrechnung'`,
mit Bankkonto und Betrag — Teilzahlungen erlaubt) oder markiert ohne Konto
als bezahlt (Bar, Shop). `kundenrechnung_offen(id)` = brutto − Zahlungen;
bei 0 kippt der Status auf `bezahlt`. Eine Rechnung über 0,00 € (Garantie,
Ersatz zum Nulltarif) entsteht seit 0124 gleich als `bezahlt` —
ausgeglichen, nie offen, nie gemahnt. Offene Rechnungen (Forderung, `ein`)
und offene Gutschriften (Erstattung, `aus`) stehen in `finanz_faellig`
und damit in der Cashflow-Sicht. **Mahnstufen 1–3** (`verkauf.rechnung_mahnen`,
nur nach Fälligkeit und mit offenem Betrag): Zahlungserinnerung, 1. Mahnung, 2. Mahnung — je als
PDF mit Frist `rechnung.mahnfrist_tage`; überfällige Rechnungen zählt die
Navigation (`/verkauf/rechnungen`, rot).

**PDF** (`/api/verkauf/rechnung/<id>`, `?art=mahnung`; `@react-pdf`,
`src/modules/verkauf/rechnung-pdf.ts`): Shop-Rechnungen zeigen Bruttopreise
mit „inkl. 19 % MwSt." wie die bisherigen Shopify-Belege, B2B-Rechnungen
netto mit Steuerblock; Fuß mit Pflichtangaben der GmbH (Registergericht,
HRB, Steuernummer/USt-IdNr., Geschäftsführung, Bank) aus
`settings.company` (Einstellungen → Firma).

**DATEV** (`/api/verkauf/datev?von&bis`, Finanzen-Recht): Buchungsstapel
EXTF 700 — Rechnung im Soll Debitor (Kundennummer, sonst
`rechnung.debitorenkonto`) gegen Erlöskonto je Steuersatz
(`rechnung.erloeskonto_19/7/0`, SKR03 8400/8300/8120 oder SKR04
4400/4300/4120), Gutschrift im Haben, Umlaute ASCII-sicher
(`src/modules/verkauf/datev-export.ts`, reine Logik). „Zeitraum als übergeben
markieren" (`verkauf.datev_uebergeben`) setzt `datev_uebergeben_am`.

**Einstellungen** (Einstellungen → Belege): Automatik, Zahlungsziel,
Mahnfrist, Kontenrahmen und Konten (`einstellungen.rechnungen_setzen`,
`settings.rechnung`); **Nummernkreise** jetzt setzbar
(`einstellungen.nummernkreis_setzen` → `sequence_setzen`, Prefix und
nächste Nummer — z. B. RE- ab 7813, damit die Nummern nach Shopify
lückenlos weitergehen).

**UI:** `/verkauf/rechnungen` (Filter offen/überfällig/bezahlt/Gutschriften/
storniert, Kacheln offene Forderungen, überfällig, Umsatz des Monats,
DATEV-Karte), `/verkauf/rechnungen/<id>` (Positionen, Zahlungen,
Gutschriften, Knöpfe aus dem Prozess, PDF, Mahnung, Notizen); am Auftrag
die Karte **Rechnungen**.

**Tests:** `tests/kundenrechnungen.test.ts` (reine Bausteine: Felder aus
der Shop-Bestellung, DATEV-Zeilen), `tests/prozesse/kundenrechnungen.test.ts`
(Shop-Änderung vor dem Versand, Rechnung aus Fertigung + Label,
Teilerstattung → Gutschrift, Artikel dazu → zweite Rechnung, Firmenkunde
mit Mahnung und Teilzahlung, Storno, DATEV), Fixture `kundenrechnung`
(drei Läufe), Abnahmetest (Rechnungen je Status, Rechnungssumme,
Forderungen in `finanz_faellig`).

### Probelauf (Migration 0117, seit 2026-10-16)

Die Rechnung aus KRNL ist ein heikles Thema: Nummernkreise sind lückenlos,
DATEV bekommt, was einmal da ist. Deshalb hat die Kundenrechnung einen
**Modus** (`settings.rechnung.modus`, Einstellungen → Belege; `automatisch`
bleibt als Spiegel `modus <> 'aus'` für ältere Leser):

| Modus | Verhalten |
|---|---|
| `test` (Vorgabe jeder Instanz) | **Probelauf**: mit jeder gebuchten Lieferung entsteht eine *Testrechnung* mit `probe = true` und eigenem Nummernkreis `PROBE-RE-`/`PROBE-GU-`. Sie verhält sich wie eine echte (bezahlt bei Shop-Aufträgen, offen bei Firmenkunden, Gutschrift bei Shop-Änderung, berechnete Mengen, Zahlung, Mahnstufe), zählt aber nirgends: nicht im DATEV-Stapel, nicht in `finanz_faellig`, nicht im Umsatz der Rechnungsliste, nicht im Zähler der Navigation. PDF mit rotem Banner „TESTBELEG". |
| `scharf` | Echte Rechnungen `RE-`/`GU-` mit jeder Lieferung. Nur einstellbar, wenn **kein** Testbeleg mehr in der Datenbank steht. |
| `aus` | Keine Automatik; Rechnung nur von Hand aus der Lieferung (`verkauf.rechnung_erstellen`) — im Modus `test` ergibt auch der Knopf einen Testbeleg. |

Die eine Leseweise des Modus ist `rechnung_modus()` (SQL), der Trigger und
die Seiten fragen sie. **Vergleich** mit dem Shop: Verkauf → Rechnungen →
Filter „Probelauf" zeigt je Bestellung die Summe der Testbelege (Rechnungen
minus Gutschriften) gegen `sales_orders.shopify_brutto` — den Gesamtbetrag
laut Shop (`currentTotalPriceSet`, brutto inkl. Versand), den der Import
beim Anlegen und jeder Abgleich nachführt. Abweichungen sind rot, Bestellungen
ohne Shop-Betrag (vor 0117 importiert, noch kein Abgleich) stehen als „kein
Shop-Betrag".

**Beenden:** `verkauf.rechnung_probelauf_loeschen` (Administrator,
Einstellungen → Belege → „Probelauf löschen") ruft
`kundenrechnung_probelauf_loeschen()`: löscht alle Testbelege samt ihrer
Zahlungen im Register, rechnet `qty_invoiced` der betroffenen Auftragszeilen
aus den verbliebenen echten Belegen neu, bestimmt den Auftragsstatus neu und
setzt die Probe-Nummernkreise auf 1. Echte Belege bleiben unberührt. Danach:
Nummernkreise `RE-`/`GU-` und Firmendaten prüfen, Modus `scharf`,
sevDesk-Rechnungsausgang abschalten (Einrichtungsaufgabe `rechnung_probelauf`; Korrektur 0118: die heutigen Rechnungen kommen aus sevDesk, nicht aus einer Shopify-App).

Nachweis: `tests/prozesse/kundenrechnungen.test.ts` („Rechnungs-Probelauf
(0117)"): Testrechnung und -gutschrift mit PROBE-Nummern, berechnete Mengen
wie im Ernstfall, nicht in Fälligkeiten und DATEV, PDF mit Probe, Sperre
beim Scharfschalten, Löschen mit Rückrechnung, danach nahtlose RE-Nummer.

## UI

- **Liste**: Nummer, Shopify-Name, Kunde, Datum, Status-Badges (Status/Liefer-/Abrechnungsstatus), Summe; Filter nach Status/Quelle; Volltextsuche.
- **Formular**: Kopf (Kunde, Datum, Quelle), Positionstabelle, Buttons je Status (Bestätigen, Per E-Mail senden, Stornieren, Sperren), Smart-Buttons **Lieferungen (n)** und **Fertigungsaufträge (n)** mit Verknüpfung, Aktivitäten-/Notiz-Verlauf (einfacher Chatter: Statuswechsel + Notizen protokolliert in `audit_log`).
- **Querverweise (2026-10-01, „Status sind Wege")**: Kunde → Kontakt (`/kontakte/<id>`), Status-Schild → Auftrag. Das **Lieferstatus-Schild** führt bei genau einer offenen (oder überhaupt nur einer) Lieferung direkt zu ihr, sonst zur Transferliste des Auftrags (`/lager?auftrag=<id>`, bei nur erledigten mit `&offen=0`). „**N offen**" (Fertigung) führt zu `/fertigung?auftrag=<id>`. Im Formular sind zusätzlich Positionen → Variante, MO-Produkt → Produkt, Sendungen → Lieferung sowie die Herkunft (Reparatur, aus der das Angebot entstand; Vorgang über `origin`) verlinkt.

## Abnahmekriterien

1. Manuell angelegter Auftrag mit Tastatur-Variante (route_manufacture+mto): Bestätigen erzeugt genau 1 Lieferung + 1 MO mit korrekt gefilterten BoM-Komponenten; beide per Smart-Button erreichbar; MO trägt den Auftrag als Quelle.
2. Auftrag mit Lagerprodukt ohne Fertigungsroute: nur Lieferung, kein MO.
3. Stornieren storniert die offene Lieferung, MO bleibt mit Warnhinweis bestehen.
4. Gesperrter Auftrag lässt sich weder in UI noch per API ändern, bis entsperrt.
5. Validierte Teillieferung setzt `qty_delivered` der Positionen und `delivery_status = partial`.
6. Gebuchte Lieferung eines Shop-Auftrags erzeugt genau eine bezahlte Rechnung (Positionen mit Variantenname, Versand einmal); die eines Firmenauftrags eine offene mit Fälligkeit — sie steht in `finanz_faellig`.
7. Shop-Änderung vor dem Versand ändert Auftrag, Lieferung und Fertigung, aber keinen Beleg; nach der Rechnung entsteht die Gutschrift (Menge weniger) bzw. die zweite Rechnung (Ware dazu) von selbst.
8. Storno = volle Gutschrift mit Bezug, Rechnung `storniert`; Teilgutschrift lässt die Rechnung bestehen; keine Rechnung wird je editiert.
