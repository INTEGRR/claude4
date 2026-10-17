# Abnahmetest — drei Monate, vorher gerechnet, live wiederholt

Der letzte Test vor dem Vertrauen: ein Drei-Monats-Plan über alle Belege
und Prozessschritte wird **zuerst rechnerisch durchgespielt** (ein Modell
ohne Datenbank sagt vorher, welche Werte nach jedem Monat stehen müssen)
und **dann live im System wiederholt** — jeder Schritt über die
Aktions-Registry und den Torwächter, Shop-Bestellungen als Webhooks, Labels
und Rückmeldungen über die Attrappen. Am Ende jedes Monats wird Feld für
Feld verglichen. Es muss passen; eine einzige Abweichung macht die Suite
rot. Entscheidungslog 2026-10-15.

## Dateien

| Datei | Rolle |
|---|---|
| `tests/abnahme/szenario.ts` | Der Plan als Daten: Stammdaten, Stückliste, Arbeitsgang, 97 Schritte in drei Monaten. Monate liegen relativ zum Lauftag (Monat 3 = laufender Monat). |
| `tests/abnahme/modell.ts` | Das Rechenmodell: Bestand, Reservierung, gleitender Durchschnitt mit den Rundungen der SQL-Funktionen, Belege, Umsatz, Zahlungen, Fälligkeiten, Shopify-Mengen. Rein, ohne Datenbank. |
| `tests/abnahme/ist.ts` | Liest denselben Stand aus der Datenbank — nur über die Funktionen und Sichten, die auch die Oberfläche nutzt. |
| `tests/abnahme/vergleich.ts` | Plättet beide Stände zu Pfaden und nennt JEDE Abweichung mit Soll und Ist. |
| `tests/abnahme/zufall.ts` | Der Zufallsgenerator: seedbar, Umfang über `faktor`, nutzt das Modell als Orakel (es entsteht nur, was machbar ist). |
| `tests/abnahme/live.ts` | Der Live-Interpreter: ein Schritt = Aktionen über den Torwächter; Webhooks, Labels, Outbox; Vergleich je Monatsende, Prüfung der an Shopify übergebenen Mengen. |
| `tests/abnahme-modell.test.ts` | Teil 1 (`npm test`): das Modell gegen Handrechnungen und Invarianten; der Generator auf Determinismus, Umfang und Invarianten. |
| `tests/prozesse/abnahme.test.ts` | Teil 2 (`npm run test:prozesse`): das feste Szenario live gegen eine frische Datenbank. |
| `tests/prozesse/abnahme-zufall.test.ts` | Teil 3 (`npm run test:prozesse`): das Zufallsszenario in zehnfachem Umfang live (`ABNAHME_FAKTOR`, `ABNAHME_SEED`). |

Alle Teile laufen bei jedem `npm run check`. Jeder Live-Lauf braucht rund
eine Minute — davon der größte Teil Datenbank anlegen und migrieren; die
~900 Schritte des Zufallsszenarios selbst laufen in etwa 30 Sekunden.

## Das Szenario

**Stammdaten:** zwei Lieferanten (EUR und USD), ein Firmenkunde, fünf
Artikel — Gehäuse, PCB, Switch (Kaufteile), Deskmat (Lagerware im Shop),
Tastatur „KB-65" (auf Auftrag gefertigt, im Shop; Stückliste 1 Gehäuse +
1 PCB + 70 Switches, Arbeitsgang Montage 30 min zu 48 €/h). Bankkonto mit
Saldo-Anker 50.000 €, USD-Kurs 0,92 (Monat 2: 0,90). Shopify im Modus
„schreiben" gegen die Attrappe.

| Monat | Was passiert |
|---|---|
| 1 | Anfangsbestand 1 Deskmat per Inventur. PO1 (EUR: 40 Gehäuse, 40 PCB, 30 Deskmats), Teillieferung 40/40/20 mit Rückstand, Fracht 120 € nach Gewicht verteilt, Rechnung gebucht und überwiesen. PO2 (USD: 5.000 Switches + 60 USD Fracht) als „Bestellung aus Beleg" mit Vorkasse — Rechnung ist über die Vorkasse gedeckt. Sechs Shop-Bestellungen (vier Tastaturen, Deskmats), drei Tastaturen gefertigt, fünf Lieferungen per DHL-Label versendet; eine Tastatur bleibt als Fertigungsauftrag offen. Miete, Lizenz, Darlehensauszahlung 12.000 €. |
| 2 | Rückstand von PO1 kommt, zweite Rechnung. PO3 (EUR) mit Fracht nach Wert, PO4 (USD zum neuen Kurs, Rechnung bleibt offen). Sechs Shop-Bestellungen (eine mit Menge 2), B2B-Auftrag mit 3 Tastaturen + 5 Deskmats (per „Buchen" geliefert), Ausschuss 2 PCB, ein Shop-Storno nach der Fertigung (die Tastatur geht zurück in den freien Bestand), USt-Termin erfasst und bezahlt, Darlehensrate 1. |
| 3 | Demontage einer Tastatur (Komponenten zurück), Fertigung auf Lager (2 Stück), sechs Shop-Bestellungen, B2B-Auftrag storniert vor der Fertigung, Inventurdifferenz −15 Switches, Rechnung PO4 überwiesen, Darlehensrate 2, Lizenz zum Jahresende gekündigt, USt-Termin offen. Eine Shop-Bestellung bleibt in der Fertigung. |

Ergebnis am Ende: 20 Aufträge (18 verkauft, 2 storniert), 4 Bestellungen,
5 Rechnungen (alle bezahlt), 15 Fertigungsaufträge (13 fertig, 1 offen,
1 storniert), 1 Demontage, 16 Fulfillments an Shopify.

## Was verglichen wird (je Monatsende)

- **Bestand je Artikel:** Lagerbestand, reserviert, frei, bewertete Menge,
  Bestandswert (4 Stellen), gleitender Durchschnitt (6 Stellen); Lagerwert
  gesamt; baubare Tastaturen.
- **Shopify:** Soll-Menge je verknüpftem Artikel (`shopify_soll_menge`),
  zuletzt gemeldete Menge (`pushed_qty`), MTO-Einrichtung, Anzahl
  Fulfillments — und die Mengen im letzten `inventorySetQuantities`-Aufruf
  der Attrappe müssen den Soll-Mengen entsprechen.
- **Belege nach Zustand:** Aufträge, Bestellungen, Fertigungsaufträge,
  Lieferungen, Wareneingänge, Rechnungen, Demontagen — und seit 0115 die
  **Kundenrechnungen** je Art und Status (`rechnung:bezahlt` für Shop,
  `rechnung:offen` für B2B, `gutschrift:…` nach Shop-Storno).
- **Umsatz:** je Auftragsmonat netto/Steuer/brutto und Anzahl, Shop brutto,
  B2B netto, Summe der gültigen Kundenrechnungen brutto (Positionen ×
  Preis, Steuer je Position gerundet, Shop-Versand einmal je Auftrag);
  Deckungsbeitrag-Sicht (Erlös der Lieferungen, Wareneinsatz zu
  heutigen Einstandspreisen).
- **Fertigung:** Material- und Lohnkosten, gefertigte Stück.
- **Cashflow:** Zahlungen je Monat (ein/aus/Anzahl), Kontosaldo je Konto
  (`finanz_saldo`, inkl. „Ohne Konto" für die Vorkasse).
- **Verbindlichkeiten:** offene Rechnungsbeträge; **Fälligkeiten** bis
  Ende Monat 5 (`finanz_faellig`) je Quelle: Rechnungen, Verträge,
  Darlehensraten, Steuern, offene Kundenrechnungen (Forderungen der
  B2B-Aufträge, fällig 14 Tage nach der Lieferung).
- **Verträge** (Status, Kündigungsdatum, gezahlt), **Darlehen** (Status,
  Restschuld, bezahlte Raten, nächste Fälligkeit, Annuität), **Steuern**
  (offen/bezahlt).

## Soll-Werte (Lauftag 2026-10-15)

Auszug aus dem Modell — der vollständige Stand steht im Lauf-Protokoll
(`HARNESS_SPUR=1`, Zeile „Monat n: Soll = Ist"). Mit anderem Lauftag
verschieben sich nur Monatsnamen und die Fälligkeiten „ab heute".

| Kennzahl | Ende Monat 1 | Ende Monat 2 | Ende Monat 3 |
|---|---|---|---|
| Gehäuse: Bestand / frei / Ø-Preis | 37 / 36 / 38,668673 | 48 / 47 / 38,580956 | 44 / 43 / 38,580955 |
| PCB: Bestand / frei / Ø-Preis | 37 / 36 / 21,289154 | 46 / 45 / 21,659783 | 42 / 41 / 21,659781 |
| Switches: Bestand / frei / Ø-Preis | 4.790 / 4.720 / 0,2576 | 7.160 / 7.090 / 0,251768 | 6.865 / 6.795 / 0,251768 |
| Deskmat: Bestand / frei / Ø-Preis | 15 / 15 / 9,556513 | 15 / 15 / 9,133907 | 11 / 11 / 9,133909 |
| Tastatur: Bestand / frei / Ø-Preis | 0 / 0 / 101,9899 | 1 / 0 / 101,8645 | 2 / 1 / 101,86455 |
| Lagerwert gesamt | 3.595,6913 | 4.889,7661 | 4.639,8604 |
| baubar / an Shopify: Tastatur, Deskmat | 36 / 34, 15 | 45 / 43, 15 | 41 / 40, 11 |
| Fulfillments an Shopify | 5 | 10 | 16 |
| Umsatz brutto (Monat 1 / 2 / 3) | 1.154,30 | 1.154,30 / 1.356,60 / 809,20 | 1.154,30 / 1.356,60 / 1.657,67 |
| Fertigung: Stück / Material / Lohn | 3 / 233,9697 / 72 | 12 / 936,1007 / 288 | 17 / 1.325,4235 / 408 |
| Saldo Geschäftskonto / Ohne Konto | 57.771,70 / −1.343,20 | 52.613,87 / −1.343,20 | 47.734,49 / −1.343,20 |
| Offene Verbindlichkeiten | 0 | 765 (PO4) | 0 |
| Darlehen: Restschuld / nächste Rate | 12.000 / 09-05 | 11.522,62 / 10-05 | 11.043,33 / 11-05 |
| Fällig bis Jahresende: Verträge / Raten / Steuern | 5 (2.667) / 4 (2.101,52) / — | 5 (2.667) / 3 (1.576,14) / 1 (2.300) | 4 (2.578) / 2 (1.050,76) / 1 (1.950) |
| Deckungsbeitrag: Erlös / Wareneinsatz | 771 / 363,3088 | 2.591 / 1.266,652 | 3.304 / 1.608,7819 |

Von Hand nachrechenbar (und in `tests/abnahme-modell.test.ts` festgehalten):
Switch-Einstand 0,28 USD × 0,92 = 0,2576 €; Vorkasse PO2 = (1.400 + 60)
USD, US-Lieferant ohne deutsche USt (0121) = 1.460 USD × 0,92 = 1.343,20 €; Rechnung PO1 = 2.470 netto +
469,30 Steuer = 2.939,30 €; Lohn 24 € je Tastatur; Rechnung PO4 =
810 + 40 = 850 USD × 0,90 = 765 €.

## Zufallsszenario ×10

Das feste Szenario ist von Hand nachrechenbar, aber klein. Der Generator
(`tests/abnahme/zufall.ts`) erzeugt denselben Schritt-Typ zufällig und
vielfach — Faktor 10 heißt rund zehnmal so viel wie der feste Plan:

| | fest | zufällig ×10 (Seed 20261015) |
|---|---|---|
| Schritte | 97 | 903 |
| Shop-Bestellungen / B2B-Aufträge | 18 / 2 | 185 / 24 |
| Bestellungen / Wareneingänge / Rechnungen | 4 / 5 / 5 | 44 / 60 / 54 |
| Fertigmeldungen / Fertigung auf Lager / Demontagen | 13 / 1 / 1 | 114 / 12 / 3 |
| Versand (Label bzw. Buchen) | 16 | 196 |
| Stornos (Shop / B2B) | 1 / 1 | 12 / 1 |
| Verträge / Darlehen / Steuertermine | 2 / 1 / 3 | 20 / 3 / 4 |
| Inventuren / Ausschuss / Nebenkosten | 2 / 1 / 2 | 19 / 13 / 32 |

Zufällig sind Mengen, Preise, Kurse, Beträge, Zahltage, Laufzeiten,
Darlehensarten (Annuität, Rate, endfällig), Teillieferungen, die Basis
der Nebenkosten, Zahlungszeitpunkte, Stornos, Kündigungen — und die
Reihenfolge, in der all das über die Tage verteilt passiert.

**Machbarkeit durch das Orakel.** Der Generator führt jeden erzeugten
Schritt sofort im Modell aus und fragt es vor dem nächsten: Ist der
Fertigungsauftrag voll reserviert? Ist die Lieferung versandbereit? Wie
viel ist frei (Ausschuss, Inventur, Demontage)? Gibt es Abrechenbares?
So entsteht nur, was das System auch annimmt — Wartezeiten entstehen
trotzdem von selbst (Engpässe bei Komponenten lassen Fertigungsaufträge
auf den nächsten Wareneingang warten, die Live-Reservierung verteilt dann
nach Reihenfolge).

**Seed und Umfang.** Derselbe Seed ergibt denselben Plan; ein roter Lauf
nennt Seed und Faktor im Testnamen:

    ABNAHME_FAKTOR=10 ABNAHME_SEED=20261015 npm run test:prozesse

Standard ist Faktor 10 mit Seed 20261015.

**Ergebnis (2026-10-15):** drei Seeds mit Faktor 10 live gegengerechnet,
jeder in Monat 1, 2 und 3 **Soll = Ist in jedem Feld**:

| Seed | Schritte | Shop / B2B | Bestellungen | Fertigmeldungen | Stornos |
|---|---|---|---|---|---|
| 20261015 | 903 | 185 / 24 | 44 | 114 | 13 |
| 7 | 906 | 181 / 22 | 46 | 115 | 22 |
| 2026 | 837 | 180 / 22 | 34 | 119 | 13 |

Der erste Lauf fand noch eine Lücke im Generator, nicht im System: zwei
Steuertermine derselben Art für denselben Zeitraum (Unique-Constraint in
`steuerzahlungen`); die Gewerbesteuer hat seitdem ihre eigene Art.

## Was der Lauf gezeigt hat

Der erste Vergleich war in Monat 1 exakt und wich in Monat 2 in acht
Feldern ab — beide Male war das **Modell** zu naiv, nicht das System.
Beides steht jetzt im Modell und in der Doku:

- **Live-Reservierung (0086) gilt auch für MTO-Lieferungen.** Die Tastatur
  aus dem Shop-Storno ging nicht in den freien Bestand, sondern sofort an
  die nächste wartende Shop-Lieferung — obwohl die ihren eigenen
  Fertigungsauftrag hat (der trotzdem produziert, Route „auf Auftrag").
  Folge: eine Tastatur mehr auf Lager als „nötig", der Shop sieht eine
  weniger. Gewollt (frei gewordene Ware erreicht Wartende), aber bei MTO
  diskussionswürdig; siehe Entscheidungslog.
- **Frachtzeilen werden nach Bestellmenge berechnet** (Dienstleistungen
  haben seit 0092 `bill_policy = ordered`) — die USD-Rechnung enthält die
  Fracht, die nie „ankommt".
- **Demontage prüft nur den Lagerbestand, nicht die Reservierung:** die
  in Monat 3 demontierte Tastatur war für eine Lieferung reserviert; der
  Fertigungsauftrag dieser Lieferung baute sie später nach. Endstand
  stimmig, zwischendurch stand die Reservierung ohne Ware. Kandidat für
  eine Prüfung „Bestand frei?" in `unbuild_apply`.
- **Vorkasse ohne Konto** landet in `finanz_saldo` unter „Ohne Konto" —
  die Bestellung aus Beleg kennt kein Bankkonto. Für die Liquidität ist das
  sichtbar, aber ein Bankkonto-Feld an der Aktion wäre besser.
- **AVCO driftet um Rundungsreste:** jede Abgangsschicht rundet auf vier
  Stellen, der Durchschnitt wird danach neu gerechnet (9,556510 →
  9,556513 nach drei Deskmat-Lieferungen). Das Modell rechnet es genauso;
  wer Preise von Hand nachrechnet, muss die Schichten nachvollziehen.

**Kundenrechnungen (2026-10-16):** Nach Migration 0115 meldete der Lauf
genau die erwartete Abweichung — `faellig.kundenrechnung` fehlte im Modell
(B1: 809,20 € offen ab Monat 2). Das Modell bucht die Rechnung jetzt in
`liefern()`; danach Soll = Ist im festen Szenario und im Zufallslauf
(Seed 20261015, 903 Schritte, 196 Lieferungen → 196 Rechnungen, 12
Shop-Stornos ohne Beleg, weil nur offene Lieferungen storniert werden).

## Erweitern

Ein neuer Schritt ist ein neuer `Schritt`-Typ in `szenario.ts`, eine
Buchungsregel im Modell (`modell.ts`, `buchen()`) und eine Aktionsfolge im
Interpreter (`abnahme.test.ts`, `ausfuehren()`). Eine neue Kennzahl ist ein
Feld in `Stand` (modell.ts) plus die passende Abfrage in `ist.ts`. Alles,
was `Stand` hat, wird automatisch verglichen.
