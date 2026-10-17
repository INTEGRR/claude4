# Entscheidungsvorlage: Auftrag nach der Bestätigung ändern

**Stand:** 17.10.2026 · **Status:** entschieden am 17.10.2026 — **Option
(c)**, Punkte 1–3 umgesetzt (Entscheidungslog 2026-10-17). Die Fragen
„Für die Steuerberatung“ bleiben offen und werden später geklärt; die
rechtlichen Punkte sind eine Einordnung ohne Gewähr, keine Steuerberatung.

## Anlass

Kunden ändern ihre Bestellung nach dem Kauf. Typisch: andere Switches,
ein anderes Case, ein Zusatzartikel. Manchmal kostet das einen Aufpreis.
Die Rechnung geht in KRNL erst mit der Lieferung raus (Entscheidungslog
2026-10-16). Im UX-Audit fiel auf, dass bestätigte Aufträge in KRNL frei
änderbar sind (Befunde 103#1, 105#1). Gesperrt ist bisher nur der eindeutig
datenzerstörende Fall: Gelieferte, berechnete oder retournierte Zeilen
lassen sich seit 0120 nicht mehr entfernen. Alles Weitere entscheidet diese
Vorlage.

## Wie es heute läuft

### Shop-Aufträge: Shopify führt

Der Shop ändert die Bestellung (Shopify „Bestellung bearbeiten“). Der
Webhook `orders/updated` ruft `bestellaenderungNachziehen` auf
(`src/modules/integrationen/import.ts`, seit 0115):

- **Soll-Stand:** die Bestellung, wie Shopify sie jetzt liefert
  (`currentQuantity` zieht Änderungen und Erstattungen schon ab).
- **Positionen:** Menge und Preis werden angeglichen, neue Artikel kommen
  dazu, entfernte fallen weg. Die Menge sinkt nie unter das Gelieferte.
  Der Versand wird nachgeführt, der Shop-Gesamtbetrag ebenso
  (`shopify_brutto`).
- **Lieferung und Fertigung:** `sales_order_lieferung_angleichen` passt die
  offenen Lieferbewegungen und die noch nicht begonnene Fertigung an.
  Angebrochene Fertigung bleibt stehen und bekommt einen Hinweis.
- **Vor der Rechnung:** Es entsteht kein Beleg, denn die Rechnung kommt
  erst mit der Lieferung und zeigt dann den geänderten Stand.
- **Nach der Rechnung:** Wird eine schon berechnete Menge im Shop
  zurückgenommen, entsteht automatisch eine Gutschrift
  (`kundenrechnung_aenderung_gutschreiben`). Zusatzartikel werden neu
  geliefert und mit dieser Lieferung auf einer weiteren Rechnung berechnet.

### Aufträge in KRNL (B2B, von Hand)

- „Position hinzufügen/entfernen“ geht, solange der Auftrag weder gesperrt
  noch storniert ist (`sales_order_guard_editable`).
- Seit 0120 bleiben gelieferte, berechnete oder retournierte Zeilen stehen
  (`sales_order_line_guard_entfernen`).
- **Lücke, behoben am 17.10.2026:** Bisher zogen Änderungen von Hand die
  Lieferung und die Fertigung nicht nach. Eine entfernte Zeile blieb als
  Lieferbewegung stehen, wurde mitversendet und berechnet. Eine neue Zeile
  hatte keine Lieferbewegung. Jetzt laufen Änderungen von Hand denselben
  Weg wie Shop-Änderungen (Entscheidungslog 2026-10-17). Ob überhaupt
  geändert werden darf, regelt diese Vorlage.
- Den Preis einer bestehenden Zeile ändern: Dafür gibt es keine Aktion.

### Aufpreis im Shop

Shopify erlaubt beim Bearbeiten: nicht versendete Artikel hinzufügen oder
entfernen, Mengen und Versandkosten ändern. Steigt der Betrag, schickt der
Shop dem Kunden eine Zahlungsaufforderung mit Link zum Checkout, oder der
Betrag wird als bezahlt markiert. Sinkt er, wird erstattet. Versendete
Artikel sind praktisch nicht mehr änderbar. Quellen:
[Shopify – Bestellungen bearbeiten](https://help.shopify.com/en/manual/orders/edit-orders),
[Shopify – Rabatte beim Bearbeiten](https://help.shopify.com/cs/manual/fulfillment/managing-orders/editing-orders/discounts).

**Befund dazu (erledigt am 17.10.2026, 0130 — siehe Entscheidungslog):** `kundenrechnung_aus_lieferung` legte jede
Shop-Rechnung als `bezahlt` an, mit der Begründung „der Shop hat das Geld
vor dem Versand“. Wird nach einem Aufpreis versendet, bevor der Kunde
nachgezahlt hat (Shopify: `PARTIALLY_PAID`), steht die Rechnung trotzdem
auf bezahlt. Die offene Forderung sah man dann nur im Shop. Jetzt bleibt
sie offen mit dem Restbetrag und schließt, sobald Shopify `PAID` meldet.

## Rechtlicher Rahmen (Einordnung, ohne Gewähr)

1. **Vor der Lieferung** ist eine Änderung eine Vertragsänderung zwischen
   Kunde und Shop. Steuerlich passiert nichts, solange noch keine Rechnung
   ausgestellt ist. Die spätere Rechnung zeigt den tatsächlich gelieferten
   Stand. Das ist der Normalfall bei KRNL, weil die Rechnung mit der
   Lieferung entsteht.
2. **Vorkasse:** Bei bezahlten Shop-Bestellungen entsteht die Umsatzsteuer
   schon mit der Vereinnahmung der Anzahlung (Mindest-Istversteuerung,
   § 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG), nicht erst mit der Lieferung.
   Ändert sich der Betrag vor der Lieferung, wird die Steuer im Zeitraum der
   Änderung berichtigt (§ 17 UStG). Das betrifft die USt-Voranmeldung und
   damit die Buchhaltung (auf Hold), nicht den Beleg in KRNL.
3. **Nach der Rechnung** wird nicht überschrieben. Es gibt eine Korrektur
   als eigenen Beleg (Storno oder Teil-Korrektur mit Bezug auf die
   Rechnung) oder eine weitere Rechnung für Zusätzliches. Das macht KRNL
   bereits so (GoBD: Unveränderbarkeit, § 146 Abs. 4 AO; Pflichtangaben
   § 14 Abs. 4 UStG). Der Gesetzestext:
   [§ 14 UStG](https://www.gesetze-im-internet.de/ustg_1980/__14.html).
4. **Rechnungspflicht:** Rechnungen an Unternehmer sind Pflicht
   (§ 14 Abs. 2 UStG), an Privatkunden nicht. Bei B2B im Inland gilt die
   E-Rechnung. Bei einer Anzahlung von Unternehmern gilt die
   Anzahlungsrechnung (§ 14 Abs. 5 UStG). Für B2B-Vorkasse ist das ein
   eigenes Thema.

### Für die Steuerberatung

- KRNL nennt Korrekturbelege „Gutschrift“ (`GU-`). Im Umsatzsteuerrecht
  meint „Gutschrift“ die Abrechnung durch den Leistungsempfänger
  (§ 14 Abs. 2 Satz 2 UStG). Für eine kaufmännische Korrektur ist
  „Rechnungskorrektur“ bzw. „Stornorechnung“ üblich. Ist die Bezeichnung
  für uns unschädlich, oder soll KRNL umbenennen?
- B2B-Vorkasse: Braucht es Anzahlungsrechnungen?
- Wann ist bei einem Aufpreis nach Vorkasse der Zeitpunkt der
  Umsatzsteuer?

## Optionen

| | (a) Nur der Entwurf ist änderbar | (b) Aktion „Auftrag ändern“ in KRNL | (c) Shopify bleibt einzige Änderungsquelle |
|---|---|---|---|
| **Kern** | Nach der Bestätigung keine Positionsänderung mehr in KRNL; Änderung = Storno und neuer Auftrag | Geführte Änderung vor der Lieferung (Zeilen, Menge, Preis) mit Angleich von Lieferung und Fertigung; nach der Rechnung automatisch Korrektur oder Zusatzrechnung | Shop-Aufträge nur im Shop ändern (KRNL folgt, wie heute); in KRNL nur B2B-Aufträge, dort wie (b) |
| **Shop-Aufträge** | Widerspricht dem heutigen Shop-Weg (der Shop ändert trotzdem) | Doppelte Quelle: KRNL-Änderung und Shop laufen auseinander | Eindeutig: der Shop führt, KRNL zieht nach |
| **Aufpreis** | Neuer Auftrag, neue Zahlung | Zahlung muss KRNL selbst anstoßen | Shopify-Zahlungsaufforderung, KRNL liest den Zahlstatus |
| **Fertigung** | Storno wirft begonnene Arbeit weg | Angebrochene Fertigung bleibt mit Hinweis | wie (b) |
| **Aufwand** | klein (Knöpfe aus, Wächter) | groß (Maske, Preislogik, Korrekturpfade, Tests) | klein bis mittel (Knöpfe für Shop-Aufträge aus, Hinweis „im Shop ändern“, Zahlstatus-Befund) |

## Empfehlung: (c)

Shopify ist bei Shop-Aufträgen schon heute die Wahrheit für Storno
(Entscheidungslog 2026-10-02) und für Bestelländerungen (0115). KRNL zieht
Positionen, Lieferung, Fertigung und Belege korrekt nach. Konkret:

1. Am Shop-Auftrag „Position hinzufügen/entfernen“ ausblenden. Stattdessen
   der Hinweis „Änderungen im Shopify-Admin — KRNL übernimmt sie
   automatisch“ mit Link, wie beim Storno.
2. B2B-Aufträge bleiben in KRNL änderbar, solange nichts geliefert ist.
   Seit 17.10.2026 ziehen Lieferung und Fertigung dabei mit.
3. Den Zahlstatus-Befund schließen: Eine Shop-Rechnung ist nur bezahlt,
   wenn Shopify `PAID` meldet. Bei `PARTIALLY_PAID` bleibt sie offen mit
   dem Restbetrag und schließt beim nächsten `orders/updated`.
4. Danach erst entscheiden, ob es (b) für B2B braucht (Preisänderung an
   bestehender Zeile, geführte Maske).

Zur Entscheidung stehen: Option (c) ja/nein, die Punkte 1–3 umsetzen
ja/nein, und die Klärung der Fragen „Für die Steuerberatung“.
