# Release neue Produkte: Plan für die heiße Phase

Stand 2026-11-17. Festgehalten auf Wunsch des Betreibers: was zum Go-live
mit den vier neuen Produkten gehen muss, was davon heute geht, was fehlt,
und in welcher Reihenfolge es in den nächsten fünf Tagen gebaut wird. Der
allgemeine Stichtags-Plan steht in [go-live.md](go-live.md); dieses Dokument
ist der Zuschnitt auf den Produkt-Release. Grundlage: Code-Stand `d56132c`
und ein lesender Blick in die Produktion am 17.11.

## Was zum Release gehen muss

1. Vier neue Produkte mit vier Stücklisten anlegen, die sich viele Teile
   teilen. Stücklisten kopieren können.
2. Beim Bauen der Stückliste fehlende Teile gleich mit anlegen (Stabilizer,
   PCB Hall Effect, Daughterboard, Kabel).
3. Bestände der neuen Teile pflegen.
4. SKU und EAN je Variante, identisch mit Shopify.
5. Bei einer Bestellung die Teile der Stückliste reservieren.
6. Die baubare Menge gleich nach der Reservierung an Shopify melden.
7. Am Release-Tag Bestellungen im Sekundentakt ohne Überverkauf, mit
   Gegenprüfung und einem Schutz, der auch dann hält, wenn KRNL ausfällt.
8. Altprodukte danach umstellen.

## Kurzantwort: Der Pfad stimmt

Reservierung (5) und Sofortmeldung (6) sind gebaut und laufen in Sekunden.
Teile lassen sich beim Anlegen einer Stücklistenposition direkt mit anlegen
(2). Es fehlen: Stücklisten kopieren, ein paar Komfortpunkte beim Anlegen —
und für den Release-Tag der Schutz gegen Überverkauf bei geteilten Teilen.
Der ist heute **nicht** kugelsicher; das ist der wichtigste Block.

## Reihenfolge je neuem Produkt

Die Stückliste braucht das Produkt mit seinen Attributen, weil die
Zuordnung „diese Zeile gilt nur für gelbe Switches" an den Attributwerten
hängt. Erst Stückliste, dann Produkt geht deshalb nicht — erst das Produkt,
dann die Stückliste, und die **Teile** währenddessen.

1. **Shopify:** Produkt als Entwurf anlegen, mit allen Optionen und
   Varianten, je Variante SKU, EAN und Preis. Options- und Wertnamen genau
   so schreiben wie bei den bestehenden Tastaturen.
2. **KRNL:** Integrationen → Produkte aus Shopify übernehmen. Artikel und
   Varianten entstehen mit SKU, EAN und Verknüpfung — sie stimmen damit von
   selbst überein.
3. **KRNL, am Produkt:** Routen „Fertigen" und „Auf Bestellung" setzen. Der
   Import setzt sie nicht; ohne sie entsteht kein Fertigungsauftrag und die
   Shop-Menge ist 0.
4. **KRNL, Fertigung → Stücklisten:** Stückliste anlegen, Positionen mit
   Menge und „gilt für …"; fehlende Teile über „neu anlegen" im Auswahlfeld.
5. **Bestand:** Einstandspreis am Teil setzen, dann Lager → Inventur.
6. **Verkauf → Shop-Verfügbarkeit:** baubar, Engpass und Shop-Menge je
   Variante prüfen.
7. **Test:** eine Bestellung — Fertigungsauftrag und Reservierung entstehen,
   die baubare Menge sinkt bei allen Varianten mit demselben Teil.
8. **Stichtag:** Shopify-Modus „schreiben", Webhooks registrieren, einmal
   abgleichen, erst dann das Produkt im Shop aktiv schalten.

Teile (Komponenten) werden nur in KRNL angelegt, nie in Shopify. Der Weg
„erst in KRNL anlegen, dann nach Shopify schieben" geht nur im Modus
„schreiben" und erzeugt ein nacktes, sofort aktives Shop-Produkt — für den
Release ungeeignet.

## Was heute geht und was fehlt

| Punkt | Stand | Bemerkung |
|---|---|---|
| Produkt mit Varianten | geht | Attribute vorher unter Produkte → Attribute; SKU/EAN nur einzeln je Variante |
| Teil beim Stücklistenbau anlegen | geht | nur Bezeichnung und Artikelnummer; Einheit immer „Stück", Preis 0, immer Kaufteil |
| Stückliste mit variantenabhängigen Zeilen | geht | Position ändern heißt löschen und neu anlegen |
| Stückliste kopieren | geht (seit 23.11.) | Knopf „Kopieren" an der Stückliste; Zuordnungen wandern über Attribut und Wert mit |
| Unterbaugruppen | teilweise | Baugruppe mit eigener Stückliste wird als Lagerteil verbraucht, kein Unterauftrag; Typ „Baugruppe" in der Maske nicht wählbar |
| Anfangsbestand | geht | Inventur; vorher Einstandspreis setzen, sonst Herstellkosten zu niedrig |
| Fertigungsdateien | teilweise | Dokumente am Produkt (Google Drive nötig), nicht an der Stückliste |
| Auswahlfelder | Risiko | laden höchstens 500 Varianten (heute 300 aktiv) — darüber fehlen Teile in der Liste und es entstehen Dubletten |
| Reservierung bei Bestellung | geht | nur bei bezahlten Bestellungen, in derselben Transaktion wie der Import |
| Shop-Menge nach Reservierung | geht | Sekunden nach dem Webhook; im Probelauf wird nichts gesendet |
| SKU/EAN-Abgleich | teilweise | der letzte Schreiber gewinnt, kein Abweichungsbericht; unbekannte SKU → Auftrag bleibt unbestätigt (Klärfall) |
| Import aus Datei | fehlt | kein CSV für Artikel oder Stücklisten |

## Release-Tag: Überverkauf

### Wo er heute entstehen kann

1. **Geteilte Teile werden mehrfach angeboten.** Jede Variante meldet die
   volle baubare Menge. Zehn grüne Gehäuse, zwei Varianten: beide zeigen 8
   (Puffer 2), zusammen 16. Bei 30 Varianten bis zu 240 Angebote auf zehn
   Gehäuse. Shopify zählt je Variante herunter und weiß nichts vom
   gemeinsamen Teil.
2. **Die Menge wird absolut gesetzt.** Shopify verkauft ein Stück (10 → 9),
   KRNL hat die Bestellung noch nicht importiert, ein Abgleich für eine
   andere Bestellung läuft und setzt wieder 10. Das elfte Stück ist
   verkäuflich (`inventar.ts`, Rückmeldung „Shop niedriger").
3. **Unbezahlte Bestellungen reservieren nicht** und werden über Nr. 2
   wieder aufgefüllt.
4. **Doppelreservierung:** `move_reserve` liest den Bestand ohne Sperre —
   zwei gleichzeitige Importe können beide die letzten Stücke reservieren.
5. **Stau:** Gleichzeitige Webhook-Läufe greifen dieselben Ereignisse;
   Bestand-Echos reihen sich vor Bestellungen ein; bei Drosselung durch
   Shopify wartet ein Ereignis 1 bis 15 Minuten; ein abgestürzter Abgleich
   blockiert bis zu 10 Minuten.
6. **Niemand wird gewarnt**, wenn eine Bestellung nicht mehr aus dem Bestand
   gebaut werden kann.

### Was heute schon schützt

Shopify verkauft je Variante nicht unter 0 (KRNL stellt „nicht
weiterverkaufen" ein). Bestellungen werden sofort nach dem Webhook
verarbeitet, minütlich und alle 15 Minuten nachgefasst, doppelte Ereignisse
sind ausgeschlossen. Puffer, Schwelle je Teil, „zurückhalten" und „aus" je
Artikel gibt es.

### Was gebaut wird

Das Prinzip: **Die Summe der gemeldeten Mengen aller Varianten, die ein
knappes Teil brauchen, darf den freien Bestand dieses Teils nie
übersteigen.** Dann zählt Shopify selbst atomar herunter, und es kann auch
dann nichts überverkauft werden, wenn KRNL langsam ist oder steht. KRNL
verteilt nur nach — zuerst senken, dann erhöhen.

## Arbeitspakete

**Block S — Schutz am Release-Tag (muss)**

| Nr. | Paket | Größe |
|---|---|---|
| S1 | Mengen nie blind hochsetzen: Erhöhung nur mit Vergleichswert, nicht solange Bestell-Ereignisse offen sind | klein–mittel |
| S2 | Reservierung mit Sperre auf dem Bestand (`move_reserve`) | klein |
| S3 | Kontingent-Modus: knappe Teile auf die Varianten aufteilen, Summe ≤ frei; Zweitangebote und der Einzelverkauf des Teils (Rückhalt/Höchstmenge, 0133) eingerechnet | groß |
| S4 | Webhook-Verarbeitung härten: Ereignisse exklusiv greifen, Bestellungen vor Bestand-Echos, bei Drosselung kurz warten, hängenden Abgleich nach 2 Minuten zurückholen | mittel |
| S5 | Überverkaufs-Wächter: Bestellung ohne volle Reservierung → Telegram und Vermerk am Auftrag | klein–mittel |
| S6 | Not-Aus: eine Aktion setzt alle auftragsgefertigten Varianten auf ausverkauft | klein |
| S7 | Abgleich heilt und meldet Abweichungen, prüft „nicht weiterverkaufen" erneut | klein |
| S8 | Lasttest: 500 Bestellungen gleichzeitig gegen die Attrappe, Beweis „nie mehr verkauft als Teile da" | mittel |

**Block K — Klärfälle (gebaut am 23.11.)**

| Nr. | Paket | Größe |
|---|---|---|
| K1 | Klärfälle gesammelt auflösen: alle offenen Zeilen eines Shop-Artikels in einem Schritt zuordnen und die Bestellungen neu einlesen (heute 209 Zeilen einzeln) | klein–mittel |

**Block A — Anlegen (soll, spart dir Zeit beim Aufbau)**

| Nr. | Paket | Größe |
|---|---|---|
| A1 | Stückliste kopieren (auf anderes Produkt, Zuordnung über Attribut- und Wertnamen) — **gebaut am 23.11.** | mittel |
| A2 | Auswahlfelder mit Serversuche statt 500er-Grenze | mittel |
| A3 | Stücklistenposition bearbeiten (Menge, Zuordnung) | klein–mittel |
| A4 | Teil-Kurzanlage um Einheit, Einstandspreis, Kauf- oder Fertigteil erweitern | klein |
| A5 | SKU und EAN aller Varianten in einer Tabelle pflegen | klein–mittel |
| A6 | Hinweis, wenn ein Shop-Produkt keine Routen oder keine Stückliste hat | klein |

**Vorschlag für die fünf Tage**

- Tag 1: A1, A2, S1, S2 — du kannst anlegen, die zwei kleinen Löcher sind zu.
- Tag 2: S3.
- Tag 3: S4, S5, S6, S7.
- Tag 4: S8 und Nacharbeit aus dem Lasttest; A3 bis A6.
- Tag 5: Generalprobe mit echtem Shop im Modus „schreiben" an einem
  Testprodukt, Altprodukte umstellen, Stichtags-Schalter.

## Schon geprüft

- Bestand, Reservierungen und Bewertung stimmen mit den Buchungen überein;
  52 Fertigungsaufträge haben exakt nach Stückliste verbraucht (13.11.).
- Sicherheitsreview der öffentlichen Zugänge, Abhängigkeiten ohne bekannte
  Lücke, täglicher Sicherheits-Check per Telegram läuft seit dem 14.11.
- Retourenportal, Seitenaufteilung der Listen, Stichtag ohne Rechnungen.

## Offen beim Betreiber (Stand 17.11.)

- Shopify-Modus steht auf „Probelauf": nichts wird an den Shop gemeldet.
- 120 Varianten weichen ab; 14 würden beim Umschalten ausverkauft (alle
  Black-on-Black), 50 wieder verkaufbar (alle FR-4). In Verkauf →
  Shop-Verfügbarkeit die Spalte „Engpass" ansehen.
- 17 Fertigungsaufträge warten auf „gebaut oder storniert"
  (WH/MO/00054–00071); daran hängen die Minusbestände.
- Druckbrücke meldet sich seit dem 10.11. nicht.
- Firmendaten unvollständig, ein Admin ohne zweiten Faktor.
- Alle Lieferungen der letzten sieben Tage liefen über Sendcloud (21 von 21).

## Entscheidungen, die noch fehlen

1. **Unbezahlte Bestellungen:** reservieren sie schon beim Eingang, oder
   erst bei Zahlung? Reservieren ist sicherer gegen Überverkauf, bindet aber
   Teile für Bestellungen, die platzen können.
2. **Aufteilung im Kontingent-Modus:** gleichmäßig auf alle Varianten, oder
   nach erwarteter Nachfrage (Gewicht je Variante)? Und ab welcher Menge
   eines Teils gilt es als knapp?
3. **Release-Datum** — S1 bis S8 müssen davor fertig und getestet sein.
