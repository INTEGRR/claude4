# Modul Kennzahlen

Migrationen: `0023_kennzahlen.sql`, `0088_auswertungen_live.sql` · Seite: `/auswertungen/kennzahlen`

## Zweck

Die Seite „Mengen & Abverkauf" zählt Stücke. Hier stehen die Zahlen, an denen sich das Geschäft messen lässt: Was bleibt vom Umsatz übrig, wie lange liegt Kapital im Regal, hält der Lieferant seine Termine, und kommt zu viel zurück.

Grundsatz wie überall im Haus: **keine zweite Wahrheit**. Jede Kennzahl leitet sich aus `stock_moves`, `stock_valuation_layers` und den Aufträgen ab — es gibt keine gepflegten Kennzahlenwerte, die auseinanderlaufen könnten.

## Live gerechnet (seit 0088)

Bis Migration 0088 waren es materialisierte Sichten, die ein Cron nachts neu
berechnete — auf Vercel lief dieser Cron nie, die Zahlen standen still, und
Inventur oder Preispflege tauchten nicht auf. Jetzt sind es **normale
Sichten gleichen Namens**: jede Anzeige rechnet aus dem, was in der
Datenbank steht (bei der Datenmenge des Betriebs in Millisekunden). Es gibt
keinen „Stand", keinen Knopf „Neu berechnen" und keinen Cron mehr;
`refresh_analytics()` bleibt als wirkungslose Hülle für Altaufrufer. Die
Namen `mv_*` sind historisch.

**Einstandspreis heute** (`einstandspreis_aktuell(variant)`): gleitender
Durchschnitt, sonst Einkaufspreis, sonst Stücklistenkosten (Komponenten zu
ihrem heutigen Einstandspreis, mehrstufig). Damit rechnen Wareneinsatz und
Bestandswert der Kennzahlen.

**Der Einkaufspreis ist führend:** Ändert sich
`product_templates.standard_cost`, bucht ein Trigger je Variante eine
Neubewertungsschicht (Wert = Menge × neuer Preis − bisheriger Wert) und
bewertet bisher unbewertete Menge mit. Ein Preis von 0 wertet nicht ab (er
heißt „unbekannt"). So heilt auch Bestand, der per Inventur mit 0 €
eingebucht wurde.

## Die sechs Sichten

### `mv_stock_value_history` — Bestandswert im Zeitverlauf

Wert und Menge je Variante zum **Monatsende**, gelesen aus der jüngsten Wertschicht bis zu diesem Zeitpunkt. Das geht nur, weil `stock_valuation_layers` append-only ist und `qty_after`/`value_after` mitführt — Bestandsschnappschüsse braucht es nicht.

Damit gleiche Zeitstempel (Sammelbuchungen) eine verlässliche Reihenfolge haben, hat die Wertschicht jetzt eine laufende Nummer `seq`.

### `mv_contribution_margin` — Deckungsbeitrag

Die Marge entsteht **bei der Auslieferung**, nicht bei der Bestellung:

```
Umsatz        = gelieferte Menge × Preis der Auftragszeile × (1 − Rabatt)
Wareneinsatz  = gelieferte Menge × Einstandspreis heute
```

Retouren laufen in die Gegenrichtung (Kunde → Lager) und werden mit umgekehrtem Vorzeichen gerechnet — sonst stünde ein zurückgenommener Artikel als Gewinn im Buch. **Aufträge ohne Lieferschein** (historisch übernommene Shopify-/Odoo-Aufträge, Status `sale`, voll geliefert) zählen am **Auftragsdatum** mit — so erscheinen auch die Verkaufszahlen vergangener Jahre.

Der Wareneinsatz steht bewusst zu **heutigen** Einstandspreisen (Wunsch des Betreibers 2026-09-29: jede Rechnung auf Basis dessen, was jetzt in der Datenbank steht). Der bilanzielle Wert der Abgänge bleibt in den Wertschichten und unter Lager → Bewertung.

### `mv_inventory_turnover` — Umschlag und Reichweite

```
Umschlag    = Wareneinsatz (12 Monate) ÷ durchschnittlicher Bestandswert (12 Monate)
Bestandswert heute = Bestand × Einstandspreis heute
Reichweite  = Bestand ÷ Tagesverbrauch der letzten 90 Tage
```

Als Verbrauch zählt alles, was das Lager Richtung Kunde **oder Produktion** verlassen hat — bei einem Fertiger ist der Eigenverbrauch der größere Teil. Die Ampel in der Oberfläche: unter 14 Tagen wird es eng, über 365 Tagen liegt Kapital tot.

### `mv_supplier_otd` — Lieferantentreue

Je Lieferant und Monat: bestellte Positionen, davon geliefert, davon **pünktlich** (Wareneingang ≤ `date_planned`), überfällige, durchschnittliche Abweichung in Tagen und die Mengentreue (`qty_received / qty`).

Als Ist-Termin gilt der erste Wareneingang der Variante in einer Lieferung zu dieser Bestellung.

### `mv_rma_analysis` — RMA-Quote

Reparaturaufträge je Monat und Variante gegen die im selben Monat ausgelieferte Menge. Die Quote ist bewusst eine **Näherung** — ein Gerät kann Monate nach dem Kauf zurückkommen — und taugt als Trend, nicht als Gewährleistungsrechnung.

### `mv_labor_hours` — Arbeitszeit

Erfasste Minuten und Lohnkosten je Monat, Mitarbeiter, Art (Anwesenheit/Auftragszeit) und Arbeitsplatz. Speist die Arbeitszeit-Säulen und ergänzt die Herstellkosten aus [personal.md](personal.md).

## Bewusst nicht gebaut

- **Bestandswert-Schnappschüsse als Tabelle** — die Wertschichten liefern die Historie exakt; eine zweite Tabelle wäre eine zweite Wahrheit.
- **Kennzahlen je Kunde/Region** — dafür fehlen im Shop-Betrieb die Stammdaten (keine Gebiete, keine Vertriebsteams).
- **Plan-/Ist-Vergleich, Budgets** — es gibt keine Planung im System, an der sich ein Ist messen ließe.
- **Vorberechnung** — bei der Datenmenge dieses Betriebs rechnen die Sichten live in Millisekunden; eine Momentaufnahme wäre nur eine Quelle für veraltete Zahlen.

## Abnahmekriterien

1. Umsatz minus Menge × Einstandspreis heute ergibt den Deckungsbeitrag; ein Rabatt mindert den Umsatz; ein geänderter Einkaufspreis wirkt sofort.
2. Eine Teilretoure dreht Menge, Umsatz und Wareneinsatz anteilig zurück.
3. Eine Bestellposition mit Wareneingang vor dem Plantermin zählt als pünktlich, eine ohne Eingang und mit Termin in der Vergangenheit als überfällig.
4. Inventur und Preispflege erscheinen ohne Neuberechnung in allen Kennzahlen; ein Auftrag ohne Lieferschein zählt am Auftragsdatum.
5. Trägt keine Variante einen positiven Deckungsbeitrag, sagt die Seite das ausdrücklich, statt ein leeres Diagramm zu zeigen.
