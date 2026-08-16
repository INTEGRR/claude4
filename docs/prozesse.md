# Prozessorientiertes ERP — Architektur des Umbaus

Ziel: Das ERP orientiert sich an **Prozessen statt Masken**. Prozesse sind
Daten (designbar, zur Laufzeit je Firma anpassbar), Knöpfe sind registrierte,
API-aufrufbare Aktionen, und jeder gemeldete Fehler wird automatisiert am
Prozess getestet — ohne Knöpfe zu drücken.

Der Umbau läuft in 7 Phasen (Plan beim Betreiber); dieses Dokument hält den
umgesetzten Stand fest.

## Phase 1 — Aktions-Registry (umgesetzt)

**Idee:** Das Muster des KI-Aktionskatalogs (benannte Aktion + zod-Schema +
Bereich + getrennte Ausführung + Torwächter) wird auf alle Server Actions
des Hauses verallgemeinert.

```
src/modules/prozesse/
  registry/typen.ts        RegistrierteAktion: label, bereich, schema,
                           modell, bindung (beleg|frei), uebergang {von[], nach[]},
                           formdata-Adapter, revalidate-Pfade, nurAdmin, prozessfrei
  registry/<modul>.ts      Katalog je Modul (DB-frei, unter Node testbar)
  registry/<modul>-ausfuehren.ts   Fachlogik (SQL) — aus den Alt-Actions umgezogen
  registry/index.ts        REGISTRY (satisfies Record — Vollständigkeit zur Compile-Zeit)
  ausfuehren.ts            AUSFUEHRUNG satisfies Record<AktionsName, Fn>
  torwaechter.ts           aktionPruefen (DB-frei) + aktionErlaubt + aktionAusfuehrenGeprueft
  server-aktion.ts         serverAktion(): Wrapper-Kern für Server Actions
  jobs-katalog.ts          Metadaten der Outbox-Jobs (Fähigkeit statt Anbieter)
  ereignisse.ts            Katalog eingehender Ereignisse (Webhooks, Tracking)
  introspektion.ts         Selbstauskunft für /prozesse und GET /api/aktion
```

- **Ein schreibender HTTP-Endpunkt**: `POST /api/aktion/<name>` (JSON
  `{parameter, record_id}` oder FormData). Antwort im ActionResult-Format;
  400 = fachlich, 403 = Rechte. `GET /api/aktion` liefert das komplette
  Repository. Bestehende Knöpfe bleiben Server Actions — als Dreizeiler um
  `serverAktion()`, denselben Torwächter.
- **Repository-Seite `/prozesse`**: alle registrierten Aktionen (Name, Knopf,
  Bereich, Beleg, Statusübergang, Felder) plus Dienste & Ereignisse.
- **Wächter-Tests** (`tests/prozess-registry.test.ts`): Katalog-Konsistenz,
  Rechte je Rolle, FormData-Adapter, und die statische Abdeckungsanalyse mit
  **schrumpfender Restliste** — eine migrierte Action, die nicht von der
  Liste gestrichen wird, macht die Suite rot.
- Migriert: **fehler** (Tickets) und **lager** (inkl. der
  Warenausgangs-Kette Lose → Buchen → Kartonage → Shopify-Meldung).
  Es folgen: reparatur → produkte/kontakte/personal → verkauf/versand →
  einkauf/fertigung → einstellungen/integrationen.

## Phase 2 — Prozessmodell in der Datenbank (umgesetzt)

**Grundsatz: kein doppelter Zustand.** Der Belegstatus (die ~20 vorhandenen
Statusmaschinen) bleibt die einzige Wahrheit. Ein Prozessschritt trägt ein
`zustand`-Feld und mappt damit auf den Status seiner Belegtabelle — es gibt
kein Token-Modell, das aus dem Tritt geraten könnte. Nur beleglose
Assistenten (künftig „Artikel anlegen") bekommen eine eigene Instanzzeile.

**Migration `0036_prozesse.sql`** — das Modell:

- `prozess_modelle`: Whitelist Modell → Tabelle/Statusspalte/Routenmuster.
  `prozess_beleg_daten(modell, id)` liest ausschließlich diese Tabellen
  (Bezeichner über `format %I`, nie Nutzertext).
- `prozesse` + `prozess_versionen` (entwurf|aktiv|archiviert, genau eine
  aktive je Prozess) + `prozess_schritte` (code stabil über Versionen; Art
  start|aktion|dienst|ereignis|matching|xor|ende; `aktion` = Registry-Name,
  `zustand` = Belegstatus nach dem Schritt, `rollen`, `params`, `optional`)
  + `prozess_uebergaenge` (sequence = XOR-Reihenfolge, `bedingung` jsonb).
- **Bedingungssprache** `bedingung_pruefen(daten, bedingung)`: rekursives
  jsonb — `{"alle":[…]}`, `{"eine":[…]}`, `{"nicht":…}` und Blätter
  `{"feld","op","wert"}` mit `= != in > >= < <= leer nicht_leer beginnt_mit`
  (numerischer Vergleich, wenn beide Seiten Zahlen sind). Kein eval.
- **Laufzeitänderung** = `prozess_version_kopieren(code)` → editieren →
  `prozess_version_aktivieren(id)`. Die Aktivierung validiert: genau ein
  Start, mindestens ein Ende, alles erreichbar, azyklisch (Kahn),
  XOR-Default-Regeln, `zustand` je Version eindeutig. Seeds bleiben
  unangetastet — verträgt sich mit checksummierten Migrationen.
- `prozess_overrides` binden an **Codes** (nicht Versions-IDs), überleben
  also Versionswechsel: optionale Schritte je Firma abschalten, Rollen und
  params übersteuern. `prozess_naechste_schritte` überspringt abgeschaltete
  Schritte und liefert deren Nachfolger — mit Dedupe, wenn ein Schritt auf
  zwei Wegen erreichbar würde.
- Auskunftsfunktionen: `prozess_aktive_version`, `prozess_aktueller_schritt`
  (Schritt, dessen `zustand` = Belegstatus), `prozess_naechste_schritte`
  (ausgehende Übergänge, Bedingungen gegen die Belegdaten ausgewertet,
  Overrides angewandt), `prozess_instanz_starten/_weiter` (nur beleglos,
  Nummernkreis `PRZ/`).
- `demodaten_loeschen()` behandelt die Prozessdefinitionen als Struktur
  (BEHALTEN) — Tickets und Instanzen sind Bewegung und fallen weg.

**Migration `0037_prozess_seeds.sql`** — die ersten Prozesse als Daten:
`bug_ticket` (melden → übernehmen → beheben|verwerfen; Nutzerwahl als
mehrere Übergänge, kein XOR) und `reparatur` (anlegen → bestätigen →
beginnen → optional Teile → abschließen → **XOR Garantie**: kostenpflichtig
→ Angebot, sonst Ende; Storno von überall erreichbar).

**Viewer + Panel:**

```
src/modules/prozesse/diagramm-layout.ts   pures Layout: Kahn-Topologie,
                                          Zeile = längster Pfad, Spalten je Zweig
src/components/prozess-diagramm.tsx       SVG (Server Component): Kreis Start/Ende,
                                          Rechteck Aktion, Raute XOR; aktueller
                                          Schritt mit Akzent + LED, Erledigtes
                                          gedimmt + Häkchen, Abgeschaltetes gestrichelt
src/components/prozess-panel.tsx          Diagramm + „Als Nächstes möglich"
                                          (prozess_naechste_schritte × Rolle)
```

Eingebaut auf `/tickets/[id]` und `/reparatur/[id]`: der Beleg zeigt, wo er
im Prozess steht und was jetzt möglich ist. Die Reparatur ist dafür komplett
auf die Registry migriert (9 Aktionen, `reparatur.*`).

**Tests:** `tests/prozesse-modell.test.ts` (Bedingungsmatrix, Ticket- und
Reparatur-Durchlauf, Overrides, Versionskopie + Aktivierungs-Validierung,
Instanzen), `tests/prozess-diagramm.test.ts` (Layout, DB-frei),
`tests/demodaten.test.ts` (Prozessdefinitionen überleben den Neustart).

## Phase 3 — Prozesstest-Harness + Testdatensatz (umgesetzt)

**Ein Befehl spielt jeden Kernprozess nachweisbar durch:** `npm run
test:prozesse`. Knöpfe drückt dabei niemand — jeder Schritt ist ein
Aktionsaufruf über den Torwächter, also exakt der Weg, den auch Server
Actions und `/api/aktion` nehmen.

```
src/modules/prozesse/fixtures/    der mit den Prozessen VERSIONIERTE Testdatensatz
  typen.ts                        ProzessFixture: prozess, benoetigt, aufbauen,
                                  laeufe [{pfad, eingaben, pruefen, …}]
  basis.ts                        Kunde, Gerät, Ersatzteil mit Bestand (find-or-create,
                                  Aufbau nur über die Buchungswege)
  bug-ticket.ts / reparatur.ts    Läufe: Happy Path, Verwerfen, Garantie-XOR, Storno
  index.ts                        FIXTURES satisfies Record + topologische Reihenfolge
tests/prozesse/
  harness.ts                      Wegwerf-DB je Testdatei (echte Commits — die Outbox
                                  braucht `for update skip locked`); PROZESS_DB_URL
                                  gesetzt ⇒ Staging-Modus, nichts wird angelegt/gelöscht
  laufen.ts                       der Interpreter: liest die AKTIVE Version aus der DB,
                                  prüft je Schritt Angebot (prozess_naechste_schritte),
                                  Rollen, Statusübergang (zustand) und die Ledger-Invariante
  prozesse.test.ts                alle Fixture-Läufe
  vollstaendigkeit.test.ts        die Reißleinen (s. u.)
  fakes.test.ts                   Fake-Weichen gegen die echten Client-Typen
scripts/prozessdaten.ts           baut den Fixture-Grundbestand in einer Ziel-DB auf;
                                  --reset NUR wenn settings.umgebung = {"name":"staging"}
scripts/prozess-loader.mjs        Node-Loader: löst '@/…' auf, stubbt server-only,
                                  probiert bei endungslosen relativen Importen .ts nach
```

**Vollständigkeits-Reißleinen** (tests/prozesse/vollstaendigkeit.test.ts):
jede Registry-Aktion sitzt in einem Schritt, ist `prozessfrei` oder steht
auf der SCHRUMPFENDEN Restliste `NOCH_OHNE_PROZESS` (ein Eintrag, dessen
Aktion inzwischen einen Schritt hat, macht die Suite rot); jeder
Schrittverweis (Aktion/Dienst/Ereignis/Rolle) existiert; jeder Enum-Wert
der Belegstatusmaschine ist einem Schritt zugeordnet oder ausdrücklich als
tot gelistet; jeder aktive Prozess hat eine Fixture mit gültigen Pfaden —
**ein neuer Prozess ohne Fixture bricht die Suite, der Testdatensatz wächst
also zwangsläufig mit.**

**Fake-Adapter** für Betrieb ohne echte Konten (Prozesstests, Staging):
`SHOPIFY_FAKE=1` beantwortet die GraphQL-Kapselung deterministisch
(unbekannte Operation wirft laut), `DHL_FAKE=1` liefert deterministische
Labels/Tracking/Retouren, getypt gegen die echten Client-Schnittstellen.
Mail braucht keine Weiche — ohne RESEND_API_KEY wird ohnehin nur
protokolliert. `npm run prozesse:staging` = Prozesstests mit Fakes gegen
`PROZESS_DB_URL`.

**Erster Fang des Harness** (Migration 0038): Teile, die nach dem
Bestätigen erfasst wurden, bekamen nie eine Lagerbewegung — repair_confirm
legte Moves nur beim Bestätigen an, repair_end buchte nur Teile mit Move.
`repair_add_part` zieht die Bewegung jetzt sofort nach (samt Reservierung);
die Reparaturmaske erlaubt das Nachtragen bis zum Abschluss.

`npm run check` fährt seitdem beides: die klassische Suite und die
Prozessläufe.

## Phase 4 — Maskengenerierung (umgesetzt)

**Eine Aktion beschreibt ihre Eingaben genau einmal (im zod-Schema der
Registry) — die Maske fällt daraus ab.**

```
src/modules/prozesse/schema-felder.ts   formulartaugliche Ableitung: Typ
                                        (text/mehrzeilig/nummer/schalter/auswahl/
                                        verweis/json), Pflicht, Vorgabe, Enum-Werte;
                                        *_id-Felder werden Verweise mit Quelle
src/modules/prozesse/angebote.ts        prozess_naechste_schritte → Schrittangebote:
                                        Felder, fixierte Schritt-params, Auswahllisten
                                        (Partner/Varianten/Benutzer), Rollen-Freigabe
src/components/prozess-aktionen.tsx     Client: Schritte als Tasten, dahinter das
                                        GENERIERTE Formular; Absenden an /api/aktion
                                        (Torwächter), dann router.refresh()
```

- **Das Panel ist jetzt aktiv**: auf `/tickets/[id]` und `/reparatur/[id]`
  führen die angebotenen Schritte wirklich aus. Felder, die der Schritt per
  `params` festlegt (etwa `status=behoben` am Schritt „Beheben"), erscheinen
  nicht als Eingabe — der Schritt definiert sie, das Formular zeigt nur die
  offenen Angaben. Schritte ohne offene Felder laufen nach Rückfrage direkt.
- **Beleglose Assistenten unter `/p/[prozess]`** (generisch, kennt keinen
  Prozess beim Namen): Läufe-Übersicht + Start; `/p/[prozess]/[instanz]`
  zeigt Diagramm, die möglichen Schritte als generierte Formulare und die
  gesammelten Ergebnisse. Nach jedem Aktionsschritt schaltet `/api/aktion`
  die Instanz weiter (`instanz_id` + `schritt` im Aufruf; vorher wird
  geprüft, dass der Schritt gerade angeboten wird und zur Aktion gehört).
  Führt vom Stand eine Kante zum Ende, gibt es „Assistent abschließen".
- **Pilot `artikel_anlegen`** (Migration 0039): Produkt mit Variantenmatrix
  anlegen (Schema und Fachlogik geteilt mit der KI-Aktion `produkt_anlegen` —
  eine Definition, drei Transporte: KI-Chat, generierte Maske, Prozesstest),
  optional gleich den Meldebestand einrichten. Verlinkt von /produkte
  („Anlage-Assistent"). Der XOR-Beschaffungsweg und der Shopify-Push als
  Dienstschritt folgen, sobald Einkaufs-/Fertigungs-Aktionen registriert
  bzw. Dienstschritte für Instanzen ausführbar sind (Phase 5/6).
- **Prozesstest deckt Instanzen ab**: der Interpreter erkennt beleglose
  Prozesse (modell null), startet eine Instanz, führt Schritte über den
  Torwächter aus und schaltet weiter — die Fixture `artikel_anlegen` prüft
  Variantenmatrix und Meldebestand. `tests/schema-felder.test.ts` sichert,
  dass KEIN Registry-Schema in einem Feldtyp landet, den das generierte
  Formular nicht darstellen kann.

## Phase 5a — Bug-Loop + Staging-Automation (umgesetzt)

**Jeder gemeldete Fehler kennt seinen Prozess, und jeder Fix wird im
Staging automatisiert durch die Prozesse gespielt — das Ergebnis hängt
samt Commit am Ticket.**

- **Zuordnung beim Melden** (`prozess_fuer_pfad`, Migration 0040): die
  Seite, von der das Slide-out meldet, bestimmt den betroffenen Prozess —
  über `prozess_routen` (Seiten ohne Beleg-ID) und die `routen_muster`
  der Modelle (`:id` = ein Pfadsegment), längster Treffer gewinnt.
  `fehler.ticket_melden` schreibt `prozess_code`/`schritt_code` ans Ticket.
- **Ticketseite**: Karte „Betroffener Prozess" mit Prozess, Schritt und
  dem Testlauf-Stand — grün/rot/nie gelaufen, Commit-Link, Zeitpunkt,
  Befund. Die Testfelder stammen aus 0036 (`test_ok`, `test_befund`,
  `test_commit_sha`, `test_gelaufen_am`).
- **`scripts/ticket-abschliessen.ts BUG/… <sha> [--rot] [--befund]`**
  schreibt das Ergebnis eines Prozesstest-Laufs ans Ticket und in die
  Ereignisleiste. Es setzt NUR die Testfelder — den Status „behoben"
  setzt weiterhin ein Mensch oder Claude auf Zuruf: der Test beweist,
  er entscheidet nicht.
- **GitHub-Action `.github/workflows/prozesse-staging.yml`**
  (workflow_dispatch mit Ticket/„nur"-Filter, Push auf `staging`):
  Migrationsstand → Reset mit Umgebungs-Riegel → Fixture-Grundbestand →
  alle Prozessläufe mit Fakes → Ergebnis ans Ticket (grün wie rot).
  Voraussetzung: Secret `STAGING_DATABASE_URL` + Staging-Merker
  `settings.umgebung = {"name":"staging"}` in der Zieldatenbank.
- **Der Loop ist getestet**: der bug_ticket-Prozesslauf meldet von
  `/reparatur`, prüft die automatische Zuordnung und lässt
  ticket-abschliessen.ts einmal komplett gegen die Harness-Datenbank
  laufen (test_ok + Commit am Ticket).

## Phase 5b — Externe Schritte: P4 Shop-Bestellung → Versand (umgesetzt)

**Der erste Prozess mit Außenwelt** (`shopify_bestellung_versand`,
Migration 0041; Beleg = die Lieferung/stock_picking):

```
start → ereignis „Bestellung eingegangen" (shop:bestellung_eingegangen, confirmed)
      → aktion  „Verfügbarkeit prüfen"    (assigned; mit Bestand reserviert
                                           schon die Bestätigung — der Beleg
                                           steht dann direkt HIER)
      → aktion  „DHL-Label erstellen"     (versand.label_erstellen)
      → aktion  „Warenausgang buchen"     (lager.transfer_buchen, done)
      → dienst  „Shop-Rückmeldung"        (Outbox-Job shopify_fulfillment_create)
      → ende
```

- **Versand in der Registry** (`versand.*`): label_erstellen (im Prozess),
  massendruck/label_stornieren/tracking_aktualisieren/retourenlabel als
  prozessfreie Werkzeuge; versand/actions.ts sind Dreizeiler um
  serverAktion(), die Restliste ist um den Versand kürzer.
- **Interpreter kann jetzt alle Schrittarten**: `ereignis`-Schritte speist
  die Fixture ein (Webhook-Zeile + hinterlegte Bestellung im Shopify-Fake —
  der Import verwirft den Payload und holt die Wahrheit per fetchOrder,
  genau wie im Betrieb), `dienst`-Schritte arbeiten die Outbox mit Fakes ab
  und prüfen den Job. Der Harness erzwingt die Fakes (Tests sprechen NIE
  echte Dienste an).
- **Der P4-Lauf beweist die ganze Kette**: künstlicher orders/paid →
  processPendingWebhooks → Auftrag (sale) + Lieferung → Label (Fake-DHL,
  20-stellige Sendungsnummer) → Warenausgang (Ledger-Invariante) →
  Fulfillment gemeldet (shopify_fulfillment_id) → Auftrag voll geliefert.
- **Zwei echte Fänge des Prozesstests** in dieser Phase: nachträglich
  erfasste Reparaturteile ohne Lagerbewegung (0038) und
  `sales_order_total()` skalar verwendet (liefert aber eine Zeile) — damit
  brach JEDE Einzellabel-Erstellung für Auftrags-Lieferungen
  (regeln.ts, Versicherungswert jetzt über `select gross from …`).
- Noch offen für später: der matching-Schritt (Klärliste als Prozessschritt,
  sobald die Auflöse-Aktion registriert ist) und ein Storno-Zweig.

## Phase 6a — Laufzeit-Overrides mit Verwaltung (umgesetzt)

Das Chamäleon-Stellwerk: **eine Firma passt ihre Abläufe zur Laufzeit an,
ohne Code anzufassen.** `/prozesse` hat jetzt den Reiter „Abläufe" (alle
aktiven Prozesse mit Version, Schrittzahl, Testabdeckung und
Override-Stand); die Detailseite `/prozesse/[code]` zeigt Diagramm und
Schritte und schaltet OPTIONALE Schritte je Firma ab/an — über die
Registry-Aktion `einstellungen.prozessschritt_schalten` (nur Admin,
validiert gegen die aktive Version). Overrides binden an Schritt-Codes,
überleben Versionswechsel; Nachfolger rücken in „Als Nächstes möglich"
automatisch nach (Dedupe in prozess_naechste_schritte).

## Phase 6b–e — Breitenmigration der Aktionen (umgesetzt)

**Die Restliste ist leer:** alle actions.ts-Module laufen über die
Registry — verkauf (8), einkauf (18), fertigung (20), personal +
zeiterfassung (11), kontakte (2), produkte (7), einstellungen/benutzer
(4, nur Admin), auswertungen (1). Zusammen mit fehler, lager, reparatur,
versand, produkte.produkt_anlegen und den Prozess-Verwaltungsaktionen
sind das **104 registrierte Aktionen** — jede mit Schema, Bereich,
Formdata-Adapter und API-Adresse, jede über `/api/aktion/<name>`
aufrufbar. Die statische Abdeckungsanalyse erzwingt: neue Server Actions
nutzen serverAktion() oder stehen auf der geschlossenen
Rahmenaktionen-Liste.

Statusübergänge ohne gesäten Prozess (manueller Verkauf, Einkauf P6,
Fertigung P5, Inventur P7) stehen auf der schrumpfenden
`NOCH_OHNE_PROZESS`-Liste des Vollständigkeitstests — sobald der Seed
kommt, zwingt der Test die Einträge von der Liste.

## Phase 6f — P5/P6-Seeds: Fertigung, Einkauf, Lieferantenrechnung (umgesetzt)

**Sieben Prozesse laufen end-to-end im Prozesstest** (Migration 0042):

- **`fertigung`** (manufacturing_order): anlegen → bestätigen → optional
  Verfügbarkeit → starten → fertig melden (Backflush, Ledger geprüft);
  „direkt fertig melden" aus der Bestätigung; Storno überall erreichbar.
  `to_close` steht als toter Zustand auf der Unabgebildet-Liste.
- **`einkauf_wareneingang_rechnung`** (purchase_order): anlegen → optional
  Positionen (wie „Teile" bei der Reparatur — der Standort bleibt stehen,
  der Schritt bleibt anbietbar) → bestellen (Wareneingang entsteht) →
  Rechnung erstellen. Der Wareneingang selbst wird über picking_validate
  gebucht — im Fixture-Lauf genau vor dem Rechnungs-Schritt
  (bill_policy 'received').
- **`lieferantenrechnung`** (vendor_bill): erfassen (draft) → buchen →
  bezahlen; Storno mit Gegenrechnung. Die Fixture steigt mit
  `lauf.beleg` MITTEN im Prozess ein (Rechnung entsteht vorab über die
  Buchungswege) — der Interpreter kann das jetzt.
- Die Inventur (P7) bleibt bewusst offen: inventory_counts hat keine
  Statusmaschine — sie wird ein belegloser Assistent, sobald die
  Instanz-Ausführung beleggebundene Folgeschritte beherrscht.
- Basis-Fixture erweitert um den Lieferanten; der Interpreter legt die
  Beleg-ID jedes Laufs im Kontext ab (`<prozess>_beleg_id`) — Eingabe-
  Funktionen späterer Schritte erreichen damit den Beleg (Wareneingang
  vor der Rechnung).

## Phase 6g — KI-Katalog aus der Registry (umgesetzt)

Registry-Aktionen mit **`ki: true`** (18 Stück: Statusübergänge in
Verkauf, Einkauf, Rechnung, Fertigung, Reparatur; Meldebestand, Tracking,
Kennzahlen) erscheinen im Werkzeugkatalog des KI-Agenten — zusätzlich zum
namensbasierten Anlage-Katalog (`produkt_anlegen`, `bestellung_anlegen`,
…). Beleg-IDs schlägt der Agent per sql_abfrage nach und übergibt sie als
`record_id`; ausgeführt wird **erst nach Bestätigung im Chat**, und zwar
über den Torwächter (Schema, Rechte inkl. nurAdmin, Audit) — derselbe Weg
wie Knöpfe, generierte Masken und Prozesstest. Auch das KI-Umschreiben
von Vorschlägen („die Menge auf 5") funktioniert für Registry-Aktionen
(record_id bleibt dabei unangetastet). Der Katalog-Helfer lebt in
`prozesse/introspektion.kiKatalog()` — nicht im KI-Modul, weil die
Registry ihrerseits die KI-Produktanlage importiert (kein Importkreis).

## Phase 7 — Chamäleon-Fundament (umgesetzt)

**Pivot heißt „andere Prozesse aktivieren", nicht „Code umschreiben"**
(Migration 0043):

- **Eigene Felder ohne Migration**: `feld_definitionen` (Modell, Name,
  Typ text/nummer/schalter/auswahl/datum, Pflicht, Auswahlwerte) +
  `zusatz jsonb` auf partners, product_templates, sales_orders,
  repair_orders und vorgaenge. Die generierten Masken mischen sie
  automatisch ein (angebote.ts → `zusatz.<name>`, der Client
  verschachtelt), und die Bedingungssprache erreicht sie über PFADE
  (`{"feld": "zusatz.budget", "op": ">", "wert": 1000}`) — eigene Felder
  sind sofort prozessfähig. Verwaltung über die Registry-Aktionen
  `einstellungen.feld_anlegen`/`feld_loeschen` (nur Admin).
- **Generische Vorgänge** (`vorgaenge`, Nummernkreis VG/): der Beleg für
  neue Business-Linien. `state` ist TEXT — die Zustände definiert die
  Prozessdefinition, kein Enum, keine Fachtabelle. Aktionen
  `vorgang.anlegen` (Startzustand aus der Definition) und
  `vorgang.status_setzen` (Zielzustand aus den Schritt-params). Seiten
  `/vorgaenge` (+ Detail mit Prozess-Panel und eigenen Feldern) kennen
  keinen Prozess beim Namen. Bei Erfolg „graduiert" eine Linie zur
  Fachtabelle, sonst Archiv.
- **Muster-Prozess `anfrage`** (gesät, Bereich verkauf): erfassen →
  prüfen → anbieten|ablehnen — komplett zur Laufzeit definiert. Der
  Prozesstest spielt ihn end-to-end durch und beweist dabei das eigene
  Feld (budget in Maske UND als Bedingungspfad).
- **`prozess_pakete`**: Geschäftsmodell-Vorlagen als Bündel
  (D2C-Hersteller, Händler, Werkstatt/Service).
- **Paketwechsel** (Pivot = andere Prozesse aktivieren, kein Code-Umbau):
  Registry-Aktionen `einstellungen.paket_aktivieren` (exakt die
  Paket-Prozesse aktiv, Rest aus) und `einstellungen.prozess_schalten`
  (einzeln an/aus), beide nur Admin. Der Bug-Loop (`bug_ticket`) ist
  Infrastruktur und nicht abschaltbar. UI: Paket-Karten auf
  /prozesse?reiter=ablaeufe (LEDs je enthaltenem Prozess, „aktiv"-Badge
  wenn der Ist-Zustand exakt dem Paket entspricht), Einzel-Schalter auf
  /prozesse/[code] — die Detailseite zeigt auch abgeschaltete Prozesse
  (Badge statt 404), nur /p-Assistenten verlangen aktiv.
- **Navigation als Projektion**: die Sidebar blendet klar prozessgebundene
  Gruppen (Versand, Fertigung, Einkauf, Service) aus, wenn ihr Bereich
  keinen aktiven Prozess hat — Belege bleiben per URL erreichbar,
  Grundfunktionen (Verkauf, Lager, Personal, Auswertungen, Stammdaten,
  System) bleiben immer. Rechte (Areas) bleiben das Sicherheitsraster
  darunter. Der Prozesstest spielt den Paketwechsel durch
  (werkstatt → fertigung aus, anfrage an, bug_ticket an → restauriert).
- **KI-Prozessentwurf** (`einstellungen.prozess_entwerfen`, ki: true):
  der Agent entwirft eine Prozessversion — aber immer nur als ENTWURF,
  und für neue Codes entsteht der Prozess INAKTIV. Erlaubt sind
  Laufzeit-Prozesse ohne Fachtabelle (modell `vorgang` oder beleglos);
  Aktionsnamen werden gegen die Registry geprüft, Übergangs-Enden gegen
  die Schritt-Codes, genau ein Start / mindestens ein Ende schon beim
  Entwurf. Die harte Validierung (erreichbar, azyklisch, XOR-Regeln,
  eindeutige Zustände) sitzt in `prozess_version_aktivieren` und läuft
  erst beim bewussten Klick des Menschen:
  `einstellungen.prozessversion_aktivieren` (ohne ki!) schaltet die
  Version aktiv, archiviert die bisherige und setzt den Prozess aktiv.
  /prozesse/[code] zeigt Entwürfe per `?version=N` (Diagramm + Badge),
  listet alle Versionen mit Aktivieren-Knopf und kommt jetzt auch ohne
  aktive Version aus (reiner KI-Entwurf). Der Prozesstest beweist den
  ganzen Bogen: Entwurf → inaktiv → aktivieren → der designte Prozess
  läuft sofort auf Vorgängen; Unfug (unbekannte Aktion, unerreichbare
  Schritte) wird abgefangen.
- Neustart-Riegel: feld_definitionen und prozess_pakete sind Struktur
  (BEHALTEN), vorgaenge sind Bewegung.

## Manueller Verkauf + Arbeitsgänge (Migration 0044, umgesetzt)

- **P: `verkauf`** (sales_order): Angebot anlegen → Positionen erfassen
  (optional, wiederholbar — der Zustand bleibt draft, der Schritt wird
  erneut angeboten) → bestätigen (Lieferung entsteht) | stornieren.
  `verkauf.zurueck_auf_angebot` ist bewusst prozessfrei: cancel → draft
  wäre eine Schleife im Graphen — es ist eine Korrektur, kein Ablauf.
  Toter Zustand `sent` steht auf der Unabgebildet-Liste. Das Paket
  gehört zu D2C-Hersteller und Händler (die Werkstatt bleibt schlank).
- **Fertigung, Version 2**: die Arbeitsgang-Schritte
  (`arbeitsgang_starten`/`_beenden`, optional, ohne Belegzustand — die
  Arbeitsgänge haben ihre eigene Maschine in mo_operations). Bewusst
  NICHT als Seed-Änderung, sondern als neue Version über
  `prozess_version_kopieren` → ergänzen → `prozess_version_aktivieren`
  IN der Migration — der erste Kunde der eigenen Versionsmaschine.
  Beide Schritte hängen direkt an „beginnen" (Zustand progress bleibt
  der Standort, solange gearbeitet wird; Wiederholung ergibt sich ohne
  Graph-Schleife). Fixture mit Arbeitsplatz + Arbeitsplan beweist
  Start/Ende samt verbuchter Ist-Zeit.
- NOCH_OHNE_PROZESS enthält nur noch die Lager-Aktionen (Transfers,
  Zählung/Inventur, Ausschuss, Beschaffung).

## Inline-Aktionen registriert (umgesetzt)

Die drei dokumentierten Inline-Seiten-Actions laufen jetzt über die
Registry: `versand.kartonage_speichern/_schalten/_loeschen`,
`versand.versandregel_speichern/_schalten/_loeschen/_verschieben`
(alle nur Admin, prozessfrei — Versand-Konfiguration) und
`integrationen.klaerfall_aufloesen` (neuer Katalog integrationen.ts) —
Letztere ist genau die Auflöse-Aktion, die der matching-Schritttyp der
Prozesse künftig referenziert. Die Seiten sind reine Transporte
(serverAktion); Validierung, Rechte und Audit sitzen im Torwächter, alle
drei sind über POST /api/aktion erreichbar. Die übrigen Inline-Actions
der Integrationen-Seite (Queue-Wartung: runJobs, retry, …) bleiben
bewusst außerhalb — sie schalten die Infrastruktur, keine Fachlichkeit.

## Noch offen (Kurzfassung)

- Dashboard-KPIs als Projektion der aktiven Prozesse (die Navigation ist
  es schon).
- Inventur-Assistent (braucht beleggebundene Folgeschritte in der
  Instanz-Ausführung; deckt die restlichen Lager-Aktionen ab);
  Fähigkeits-Umbenennung der Job-Kinds.
