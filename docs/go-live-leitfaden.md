# Go-live-Leitfaden: fünf Etappen statt alles auf einmal

Stand 2026-11-23, Zahlen aus der Produktion gelesen. Der Leitfaden sortiert,
was beim Betreiber im Kopf durcheinanderliegt: Bestand, der schon drin ist;
neue Produkte; Zählen; Umschalten; Release. Die Technik-Pakete stehen in
[release-neue-produkte.md](release-neue-produkte.md), die vollständige
Checkliste in [go-live.md](go-live.md).

## Grüne Wiese? Nein — zählen statt neu importieren

**Empfehlung: den jetzigen Stand behalten und einmal sauber zählen.**

- **Die Daten sind da und stimmig.** 2 561 Kunden (2 559 mit Shopify
  verknüpft), 416 Aufträge seit August, 58 Artikel mit 300 Varianten, 9
  Stücklisten. Neue Kunden kommen mit jeder Bestellung von selbst. Die
  Buchführung (Bestand, Reservierung, Bewertung) war am 13.11. ohne
  Abweichung.
- **Unsicher ist nicht das System, sondern das Regal.** Der Bestand beruht
  auf dem Odoo-Stand vom 30.09. plus allen Buchungen seither — gezählt
  wurde seitdem nicht. Ein neuer Odoo-Export ändert daran nichts: Odoo
  weiß über die letzten Wochen nicht mehr als KRNL.
- **Ein Neuimport macht es undurchsichtiger.** Er brächte die doppelten
  Artikel (Shop ↔ Odoo) zurück und löschte die Historie der letzten
  Wochen, an der sich Fehler nachvollziehen lassen.

Der saubere Schnitt ist eine **Stichtagsinventur**: einmal alles zählen,
alte und neue Teile, und ab dann gilt der gezählte Bestand.

## Sofort: 207 Bestellungen hängen

Seit dem 18.11. stehen **202 Aufträge als Entwurf** — unbestätigt, ohne
Reservierung, ohne Fertigungsauftrag. Grund: zwei Shop-Produkte, die KRNL
nicht kennt und die im Shop keine Artikelnummer haben:

| Shop-Produkt | Zeilen | Stück |
|---|---|---|
| ANVIL x Meinungsmache – Limited Edition Keycaps | 130 | 132 |
| ANVIL HE und MX Switch Tester | 79 | 79 |

Folge: Im November sind 251 Bestellungen eingegangen, bestätigt sind 41.
Alles, was in den hängenden Bestellungen sonst noch steht, ist in KRNL
weder reserviert noch zur Fertigung eingeplant — der Bestand in KRNL ist
seit dem 18.11. zu hoch.

Weg heraus (Etappe 1): beiden Shop-Produkten eine Artikelnummer geben, in
KRNL übernehmen, Klärfälle auflösen. Heute geht das Auflösen nur Zeile für
Zeile (209 Klicks) — dafür wird eine Sammelaktion gebaut (Paket K1).

## Die fünf Etappen

Jede Etappe hat ein klares „fertig". Die nächste beginnt erst danach.

### Etappe 1 — Aufräumen (was schon drin ist)

- [ ] Meinungsmache-Keycaps und Switch Tester: Artikelnummer im Shop,
      Übernahme in KRNL, Klärfälle auflösen (K1).
- [ ] 24 Fertigungs-Nachfragen beantworten (WH/MO/00054–00079: gebaut oder
      storniert).
- [ ] Druckbrücke wieder starten (meldet sich seit 10.11. nicht).
- [ ] Firmendaten vervollständigen, zweiter Faktor für den zweiten Admin.

**Fertig, wenn:** keine Klärfälle offen, keine Entwurfs-Aufträge aus dem
Shop, keine offene Fertigungs-Nachfrage.

### Etappe 2 — Neue Stammdaten

Was neu dazukommt (so verstanden — bitte korrigieren):

| Neu | Shop-Produkte | Varianten |
|---|---|---|
| Native 1800 Hall Effect | 1 | 2 Plates × 2 Keycap-Sets × 4 HE-Switches = 16 |
| Native 1800 MX | 1 | 2 Plates × 2 Keycap-Sets × 5 Switches = 20 |
| Founders-Ausgabe von beiden | 2 | noch einmal 16 + 20 |
| Keycap-Set (Meinungsmache) | 1 | — (läuft schon, Etappe 1) |
| Switch Tester HE und MX | 1 | — (läuft schon, Etappe 1; braucht Stückliste) |

Zusammen 72 neue Tastatur-Varianten in vier Stücklisten, die sich fast
alles teilen. Die Founders-Ausgaben brauchen dieselben Teile wie die
normalen — genau der Fall, in dem Überverkauf entsteht (siehe
release-neue-produkte.md).

- [ ] Liste der neuen Teile schreiben (PCB HE, PCB MX, Gehäuse, Plates
      FR-4 und PC, Keycap-Sets Standard und Obsidian Frosted, vier
      HE-Switches, Stabilizer groß und klein, Daughterboard, Kabel …).
- [ ] Je Tastatur: Shop-Entwurf mit Artikelnummern → Übernahme → Routen
      → Stückliste (erste von Hand, die anderen kopieren — Paket A1).
- [ ] Stückliste für den neuen Switch Tester.

**Fertig, wenn:** jede neue Variante in Verkauf → Shop-Verfügbarkeit einen
Engpass und eine baubare Menge zeigt (auch wenn sie noch 0 ist).

### Etappe 3 — Zählen (Stichtagsinventur)

- [ ] Einkaufspreise an den neuen Teilen setzen.
- [ ] Alles zählen: alte Teile, neue Teile, Fertigware. Lager → Inventur.
- [ ] Differenzen buchen. Danach gibt es keine Minusbestände mehr.

**Fertig, wenn:** kein Artikel im Minus, baubare Mengen plausibel.

### Etappe 4 — Umschalten (Go-live mit den Altprodukten)

An einem ruhigen Tag, **vor** dem Release:

- [ ] Shop-Verfügbarkeit klären (heute weichen 120 Varianten ab, 14
      würden ausverkauft).
- [ ] Odoo schreibgeschützt.
- [ ] Shopify-Modus „schreiben", Webhooks registrieren, abgleichen.
- [ ] Ein paar Tage beobachten: Bestellung → Reservierung → Shop-Menge.

**Fertig, wenn:** drei Tage ohne Abweichung zwischen KRNL und Shop.

### Etappe 5 — Release der neuen Produkte

- [ ] Schutz gegen Überverkauf fertig und im Lasttest bewiesen (S1–S8).
- [ ] Generalprobe mit einem Testprodukt im echten Shop.
- [ ] Neue Produkte im Shop aktiv schalten.

## Wer macht was

| Du | Ich (Technik) |
|---|---|
| Artikelnummern im Shop, Teileliste, Stücklisten | K1 Klärfälle gesammelt auflösen |
| Fertigungs-Nachfragen beantworten | A1 Stückliste kopieren, A2 Auswahlfelder |
| Zählen | S1–S8 Schutz am Release-Tag |
| Umschalten am Stichtag | Lasttest, Generalprobe begleiten |

## Der wichtigste Gedanke

**Go-live und Release sind zwei verschiedene Tage.** Erst die Altprodukte
umschalten und laufen lassen, dann die neuen Produkte starten. Beides am
selben Tag hieße: neues System, neue Produkte und Höchstlast gleichzeitig.
