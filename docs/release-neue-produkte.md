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
| Produkt mit Varianten | geht | Attribute vorher unter Produkte → Attribute; SKU/EAN aller Varianten in einer Tabelle auf der Produktseite (seit 27.11.) |
| Teil beim Stücklistenbau anlegen | geht | mit Einheit, Einstandspreis und Kaufen/Fertigen (seit 27.11.) |
| Stückliste mit variantenabhängigen Zeilen | geht | Position ändern: Knopf „Ändern" in der Zeile (seit 27.11.) |
| Stückliste kopieren | geht (seit 23.11.) | Knopf „Kopieren" an der Stückliste; Zuordnungen wandern über Attribut und Wert mit |
| Unterbaugruppen | teilweise | Baugruppe mit eigener Stückliste wird als Lagerteil verbraucht, kein Unterauftrag; Typ „Baugruppe" in der Maske nicht wählbar |
| Anfangsbestand | geht | Inventur; vorher Einstandspreis setzen, sonst Herstellkosten zu niedrig |
| Fertigungsdateien | teilweise | Dokumente am Produkt (Google Drive nötig), nicht an der Stückliste |
| Auswahlfelder | geht (seit 27.11.) | laden 500 Einträge vor, Tippen sucht in allen |
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

**Stand 27.11. abends:** ✅ gebaut · ⬜ offen. Gebaut sind K1, **A1–A6**, die
Schutz-Pakete **S1–S8** und zwei Pakete, die im Plan nicht standen: Rückhalt
und Höchstmenge für den Einzelverkauf (0133) und der Fulfillment-Halt aus
Shopify (0134). Wie der Schutz arbeitet, steht in
[module/integrationen.md](module/integrationen.md) unter „Kontingent und
Buch". Entschieden am 27.11.: reservieren beim Eingang, Kontingent nach
erwarteter Nachfrage, Release am 29.11. um 16:30.

**Block S — Schutz am Release-Tag (muss)**

| Nr. | Paket | Größe |
|---|---|---|
| ✅ S1 | Mengen nie blind hochsetzen — gebaut als Buch je Angebot: gesendet wird die Differenz, gesenkt mit Vergleichswert, erhöht nur aus gedecktem Budget | klein–mittel |
| ✅ S2 | Reservierung mit Sperre auf dem Bestand (`move_reserve`) | klein |
| ✅ S3 | Kontingent-Modus: knappe Teile auf die Varianten aufteilen, Summe ≤ frei; Zweitangebote und der Einzelverkauf des Teils (Rückhalt/Höchstmenge, 0133) eingerechnet | groß |
| ✅ S4 | Webhook-Verarbeitung härten: Ereignisse exklusiv greifen, Bestellungen vor Bestand-Echos, bei Drosselung kurz warten, hängenden Abgleich nach 2 Minuten zurückholen | mittel |
| ✅ S5 | Überverkaufs-Wächter: Bestellung ohne volle Reservierung → Telegram und Vermerk am Auftrag | klein–mittel |
| ✅ S6 | Not-Aus: eine Aktion setzt alle auftragsgefertigten Varianten auf ausverkauft | klein |
| ✅ S7 | Abgleich heilt und meldet Abweichungen, prüft „nicht weiterverkaufen" erneut | klein |
| ✅ S8 | Lasttest gegen einen eigenständigen Shop-Nachbau (`lasttest/`), Ergebnisse unten | mittel |

**Block K — Klärfälle (gebaut am 23.11.)**

| Nr. | Paket | Größe |
|---|---|---|
| ✅ K1 | Klärfälle gesammelt auflösen: alle offenen Zeilen eines Shop-Artikels in einem Schritt zuordnen und die Bestellungen neu einlesen (heute 209 Zeilen einzeln) | klein–mittel |

**Block A — Anlegen (soll, spart dir Zeit beim Aufbau)**

| Nr. | Paket | Größe |
|---|---|---|
| ✅ A1 | Stückliste kopieren (auf anderes Produkt, Zuordnung über Attribut- und Wertnamen) — **gebaut am 23.11.** | mittel |
| ✅ A2 | Auswahlfelder mit Serversuche statt 500er-Grenze — **gebaut am 27.11.** | mittel |
| ✅ A3 | Stücklistenposition bearbeiten (Menge, Zuordnung, Komponente) — **gebaut am 27.11.** | klein–mittel |
| ✅ A4 | Teil-Kurzanlage um Einheit, Einstandspreis, Kauf- oder Fertigteil erweitert — **gebaut am 27.11.** | klein |
| ✅ A5 | SKU und EAN aller Varianten in einer Tabelle pflegen — **gebaut am 27.11.** | klein–mittel |
| ✅ A6 | Hinweis, wenn ein Shop-Produkt keine Routen, keine Stückliste oder keine Artikelnummern hat — **gebaut am 27.11.** | klein |

**Vorschlag für die fünf Tage**

- Tag 1: A1, A2, S1, S2 — du kannst anlegen, die zwei kleinen Löcher sind zu.
- Tag 2: S3.
- Tag 3: S4, S5, S6, S7.
- Tag 4: S8 und Nacharbeit aus dem Lasttest; A3 bis A6.
- Tag 5: Generalprobe mit echtem Shop im Modus „schreiben" an einem
  Testprodukt, Altprodukte umstellen, Stichtags-Schalter.

## Lasttest (S8) — Ergebnisse vom 27.11.

Echte App gegen einen eigenständigen Shop-Nachbau und eine
Wegwerf-Datenbank ([lasttest/README.md](../lasttest/README.md)). Sortiment:
32 Tastaturen, die sich 92 Gehäuse, zwei Plates, vier Switch-Sorten, zwei
Keycap-Sets und das PCB teilen, plus eine einzeln verkaufte Plate.

| Lauf | Käufe angenommen | Teile überverkauft | Augenblicke ohne Deckung | Bestellungen in KRNL, voll reserviert | Kauf → Auftrag (Median / 95 %) | alles verarbeitet nach |
|---|---|---|---|---|---|---|
| 300 Käufe in 20 s | 97 | keines | 0 | 97 von 97 | 0,6 s / 2 s | 5 s |
| 600 Käufe in 10 s | 103 | keines | 0 | 103 von 103 | 0,6 s / 2,1 s | 8 s |
| 400 Käufe in 15 s, Störmodus | 94 | keines | 0 | 94 von 94 | 7,7 s / 19 s | 64 s |

Störmodus: Webhooks bis 4 s verzögert, 30 % doppelt, 15 % bis 15 s
verspätet, halbes Abruf-Kontingent des Shops. In allen Läufen wurden die
Gehäuse bis auf die letzten ein bis zwei verkauft (der Puffer hält sie
zurück), und am Ende zeigte der Shop genau die Kontingente.

Was der Test unterwegs aufgedeckt hat — alles behoben:

- **Scheinbare Senkung**: ein Angebot zu senken, auf dem ein unbekannter
  Kauf liegt, gibt keinen Bestand frei. Jetzt wird gesättigt und mit
  Vergleichswert gesenkt, erhöht nur aus gedecktem Budget.
- **Drosselung fraß die Mengenmeldungen**: jedes Ereignis holte seine
  Bestellung einzeln. Jetzt holt ein Stapel gemeinsam, Echos kosten keinen
  Abruf, gedrosselte Ereignisse kommen nach fünf Sekunden wieder.
- **Verspätete Bestands-Webhooks** setzten das Buch fälschlich hoch; im
  härtesten Lauf blieben 12 von 92 Gehäusen unverkauft. Jetzt zählt eine
  Shop-Meldung nur, wenn sie jünger ist als die jüngste gezählte Bestellung.
- **Zwei gleichzeitige Erstbestellungen desselben Kunden** scheiterten an
  der doppelten Kundenanlage.
- **Webhook-Inhalt doppelt verpackt gespeichert**: Bestands- und
  Produkt-Webhooks des Shops wurden immer als „nicht verwertbar"
  übersprungen. In Produktion unbemerkt, weil dort noch keine Webhooks
  registriert sind.

Grenzen des Tests: ein Server statt vieler Vercel-Instanzen, und der
Nachbau folgt der Shopify-Dokumentation — die Generalprobe im echten Shop
ersetzt er nicht.

## Schon geprüft

- Bestand, Reservierungen und Bewertung stimmen mit den Buchungen überein;
  52 Fertigungsaufträge haben exakt nach Stückliste verbraucht (13.11.).
- Sicherheitsreview der öffentlichen Zugänge, Abhängigkeiten ohne bekannte
  Lücke, täglicher Sicherheits-Check per Telegram läuft seit dem 14.11.
- Retourenportal, Seitenaufteilung der Listen, Stichtag ohne Rechnungen.

## Offen beim Betreiber (Stand 27.11., aus der Produktion gelesen)

Erledigt seit dem 17.11.:

- ✅ Klärfälle aufgelöst: keine offene Klärzeile, kein Shop-Auftrag mehr
  als Entwurf (waren 236 Zeilen in 229 Bestellungen).
- ✅ Fertigungs-Nachfragen WH/MO/00054–00079 beantwortet; offen sind nur
  noch 11 laufende Aufträge (WH/MO/00080–00104).
- ✅ Native 1800 (HE und MX, je Plague Black, Emerald Green, Founders),
  Meinungsmache-Keycaps und Switch Tester aus Shopify übernommen.

Offen:

- ⬜ Native 1800: 144 Varianten ohne Artikelnummer, keine Stückliste,
  keine Routen; die neuen Teile sind noch nicht angelegt.
- ⬜ Fehlende Teile aus Odoo anlegen (Case Pink, Case Red, Gateron Ink
  Pink, Gottlos-auf-Mutter-Keycaps, Packaging Roll).
- ⬜ Doppelte Artikel zusammenführen; Rückhalt und Höchstmenge für einzeln
  verkaufte Teile setzen.
- ⬜ Stichtagsinventur — 10 Artikel stehen im Minus.
- ⬜ Shopify-Modus steht auf „Probelauf"; Webhooks danach (erneut)
  registrieren, damit die Halt-Webhooks dabei sind.
- ⬜ Druckbrücke, Firmendaten, zweiter Faktor für einen Admin.
- ⬜ Generalprobe mit Testprodukt im echten Shop.

## Entscheidungen, die noch fehlen

Alle drei am 27.11. entschieden:

1. **Unbezahlte Bestellungen** reservieren beim Eingang; versandt wird erst
   nach Zahlung.
2. **Kontingent nach erwarteter Nachfrage** (Gewicht je Artikel und
   Optionswert). Eine Knappheits-Schwelle braucht es nicht — reicht ein Teil
   für alle, bekommt jede Variante ihren Deckel.
3. **Release am 29.11. um 16:30.**

## Vor dem Release vom Betreiber zu tun (zum Schutz)

- Gewichte setzen: Verkauf → Shop-Verfügbarkeit, je Artikel und je
  Optionswert (z. B. beliebter Switch 3, Exot 0,5). Leer = 1.
- Shopify auf „schreiben" stellen — die erste Meldung setzt jedes Angebot
  einmal absolut, danach laufen Buch und Differenzen. Webhooks registrieren.
- Generalprobe an einem Testprodukt im echten Shop: ein Kauf, eine
  Bestandsänderung in KRNL, ein Storno — und prüfen, dass die
  Differenz-Meldung (`inventoryAdjustQuantities`) vom Shop angenommen wird.
- **Verkaufsstart per Knopfdruck** (seit 27.11.): den sechs neuen
  Tastaturen in der Produktliste dasselbe Shop-Projekt geben (anhaken →
  „Shop-Projekt setzen"), in der Shop-Verfügbarkeit an ihrer Karte
  **„Verkauf stoppen"** drücken (Shopify bekommt 0, passend zu den schon
  angelegten Shop-Seiten) — und am 29.11. um 16:30 **„Verkauf starten"**:
  alle Artikel der Karte gehen auf „berechnet", die Regeln greifen.
- Webhooks lassen sich schon im Probelauf registrieren (seit 27.11.).
- Not-Aus kennen: Verkauf → Shop-Verfügbarkeit → „Not-Aus".
- **Founders-Nummern** (seit 27.11.): in der Produktliste die beiden
  Founders-Editionen anhaken → „Nummerierte Auflage" → Name
  „Founders Edition", Nr. 1 bis 96. Danach vergibt KRNL die Nummern von
  selbst, in Bestellreihenfolge.
- **Am Release-Tag offen haben:** Verkauf → Abverkauf (Command Center) —
  dort steht, welches Teil als Nächstes ausgeht, und der Knopf
  „Ausverkauft setzen".
