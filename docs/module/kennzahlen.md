# Modul Kennzahlen

Migration: `0023_kennzahlen.sql` · Seite: `/auswertungen/kennzahlen`

## Zweck

Die Seite „Mengen & Abverkauf" zählt Stücke. Hier stehen die Zahlen, an denen sich das Geschäft messen lässt: Was bleibt vom Umsatz übrig, wie lange liegt Kapital im Regal, hält der Lieferant seine Termine, und kommt zu viel zurück.

Grundsatz wie überall im Haus: **keine zweite Wahrheit**. Jede Kennzahl leitet sich aus `stock_moves` und `stock_valuation_layers` ab — es gibt keine gepflegten Kennzahlenwerte, die auseinanderlaufen könnten.

## Warum materialisierte Sichten

Die Abfragen gehen über das gesamte Ledger und rechnen mit korrelierten Unterabfragen je Monat und Variante. Live bei jedem Seitenaufruf wäre das zu teuer. Deshalb sechs materialisierte Sichten, die `refresh_analytics()` neu berechnet:

- **Cron**: `/api/cron?task=analytics` (nachts)
- **Auf Knopfdruck**: „Neu berechnen" im Seitenkopf (Rolle mit Schreibrecht auf `auswertungen`)

Der Zeitpunkt des letzten Laufs steht in `settings.analytics.refreshed_at` und im Seitenkopf — damit niemand eine Momentaufnahme für Echtzeit hält.

## Die sechs Sichten

### `mv_stock_value_history` — Bestandswert im Zeitverlauf

Wert und Menge je Variante zum **Monatsende**, gelesen aus der jüngsten Wertschicht bis zu diesem Zeitpunkt. Das geht nur, weil `stock_valuation_layers` append-only ist und `qty_after`/`value_after` mitführt — Bestandsschnappschüsse braucht es nicht.

Damit gleiche Zeitstempel (Sammelbuchungen) eine verlässliche Reihenfolge haben, hat die Wertschicht jetzt eine laufende Nummer `seq`.

### `mv_contribution_margin` — Deckungsbeitrag

Die Marge entsteht **bei der Auslieferung**, nicht bei der Bestellung:

```
Umsatz        = gelieferte Menge × Preis der Auftragszeile × (1 − Rabatt)
Wareneinsatz  = Wert der ausgebuchten Ware aus der Wertschicht (AVCO)
```

Retouren laufen in die Gegenrichtung (Kunde → Lager) und werden mit umgekehrtem Vorzeichen gerechnet — sonst stünde ein zurückgenommener Artikel als Gewinn im Buch.

### `mv_inventory_turnover` — Umschlag und Reichweite

```
Umschlag    = Wareneinsatz (12 Monate) ÷ durchschnittlicher Bestandswert (12 Monate)
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
- **Inkrementelle Aktualisierung** (`REFRESH … CONCURRENTLY`) — bei der Datenmenge dieses Betriebs läuft der vollständige Lauf in Millisekunden. Die Unique-Indizes liegen aber bereits, falls das später nötig wird.

## Abnahmekriterien

1. Umsatz minus Wareneinsatz aus der Wertschicht ergibt den Deckungsbeitrag; ein Rabatt mindert den Umsatz.
2. Eine Teilretoure dreht Menge, Umsatz und Wareneinsatz anteilig zurück.
3. Eine Bestellposition mit Wareneingang vor dem Plantermin zählt als pünktlich, eine ohne Eingang und mit Termin in der Vergangenheit als überfällig.
4. „Neu berechnen" aktualisiert alle sechs Sichten und den Zeitstempel im Seitenkopf.
5. Trägt keine Variante einen positiven Deckungsbeitrag, sagt die Seite das ausdrücklich, statt ein leeres Diagramm zu zeigen.
