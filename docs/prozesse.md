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
  und für neue Codes entsteht der Prozess INAKTIV. Neue Prozesse sind
  Laufzeit-Prozesse ohne Fachtabelle (modell `vorgang` oder beleglos);
  BESTEHENDE Prozesse (beliebiger Beleg) lassen sich UMBAUEN — die
  nächste Version erbt das Modell, der Agent schlägt sie vollständig neu
  vor (aktuelle Schritte per sql_abfrage nachschlagen). Erlaubte Arten:
  start/aktion/dienst/ereignis/xor/ende — Aktionsnamen werden gegen die
  Registry geprüft, job_kind gegen den Job-Katalog, Topics gegen den
  Ereignis-Katalog, Übergangs-Enden gegen die Schritt-Codes, genau ein
  Start / mindestens ein Ende schon beim Entwurf. Die harte Validierung (erreichbar, azyklisch, XOR-Regeln,
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

## Inventur-Assistent + beleggebundene Folgeschritte (Migration 0045, umgesetzt)

Assistenten (beleglose Prozesse) können jetzt MITTEN im Ablauf auf einem
im Vorschritt erzeugten Beleg weiterarbeiten: das Ergebnis jedes Schritts
wandert in die Instanz (`daten->>'beleg_id'`), und eine beleggebundene
Aktion ohne explizite record_id nimmt diesen Beleg als Bezug — in
/api/aktion (instanz_id) genauso wie im Prozesstest-Interpreter. Erster
Kunde ist der **Inventur-Assistent** (`/p/inventur`, Bereich lager, in
allen Paketen): Zählung erfassen (erzeugt inventory_count) → Differenz
buchen (arbeitet auf genau dieser Zählung) → fertig; den
Shop-Inventarabgleich stößt der Quants-Trigger als Infrastruktur selbst
an. Die Fixture beweist, dass der Bestand exakt der Zählung folgt.
NOCH_OHNE_PROZESS: nur noch Transfers, Ausschuss, Beschaffung.

Auch die Dashboard-Kacheln sind seither eine Projektion der aktiven
Prozesse (Fertigung/Versand/Reparatur verschwinden mit ihrem Prozess;
Verkauf und Lager bleiben als Grundfunktionen) — Navigation und
Startseite folgen demselben Muster.

## Klärliste als Prozessschritt + Nachzügler-Heilung (Migration 0046, umgesetzt)

Der Shopify-Prozess hat als Version 2 (wieder über die Versionsmaschine)
seinen **matching-Schritt**: „Klärliste auflösen" zwischen Bestellung und
Verfügbarkeit, Klärtabelle `shopify_unmatched_lines`, Auflöse-Aktion
`integrationen.klaerfall_aufloesen`. Dazu die fehlende **Heilung**: ein
Auftrag, der wegen unbekannter SKU unbestätigt liegen blieb, bekommt beim
erneuten Import (Auflösung ruft ihn sofort an; sonst der nächste
Abgleich) die geklärten Positionen mit dem ECHTEN Shop-Preis nachgezogen
(`attached_at` hält die Übernahme idempotent fest) und wird bei Bezahlung
bestätigt — das deckt auch „erst importiert, später bezahlt" ab, was
vorher schlicht liegen blieb. Der Interpreter spielt matching-Schritte
durch (offene Zeile muss provoziert sein, Auflösung über den Torwächter,
Liste danach leer; ein Folge-Auslöser liefert den geheilten Beleg), und
die Fixture beweist den ganzen Weg: unbekannte SKU → Klärfall → Auflösung
→ Auftrag bestätigt → Label → Warenausgang → Shop-Rückmeldung, inklusive
gemerkter Zuordnung an der Variante.

**Die Restliste ist leer**: `NOCH_OHNE_PROZESS` enthält nichts mehr —
jede der Aktionen hat einen Prozessschritt oder ist BEGRÜNDET prozessfrei
(Korrekturen wie Transfer-Storno/-Retoure, Verwaltung, alternative
Einstiege wie die Beschaffung; Begründung als Kommentar am Katalogeintrag).

## Komponierte Prozesse (Migrationen 0049/0050, umgesetzt)

Drei BPMN-Konzepte im Beleg-als-Token-Modell — ohne Token-Engine:

- **Mehrfach-Starts**: ein Prozess darf mehrere Einstiege haben; die
  Validierung verlangt nur noch MINDESTENS einen Start, erreichbar sein
  muss jeder Schritt von irgendeinem Start aus.
- **Teilprozesse** (Schrittart `prozess`, Call-Activity-Äquivalent): ein
  Schritt verweist auf einen Kindprozess; der Kindbeleg hängt über die
  Beleg-Herkunft (origin) oder eine Fremdschlüsselspalte
  (`teilprozess_link {"spalte": …}`) am Elternbeleg. Solange der
  Teilprozess läuft, wird der Schritt wartend angeboten; sind alle
  Kindbelege am Ende (Semantik: ihr Prozess bietet nichts mehr an —
  `teilprozess_stand()`), rücken die Nachfolger nach. Jeder Teil bleibt
  einzeln testbar.
- **Beleg-Filter** (`prozesse.beleg_filter`, Bedingungssprache): mehrere
  Prozesse je Belegart; `prozess_fuer_beleg()` wählt (spezifische Filter
  gewinnen). Eingangs-Transfers → Wareneingang, Ausgangs-Transfers →
  Shop-Versand; die Transfer-Detailseite zeigt das passende Panel.

Pilot ist der **Einkauf** (V2): zwei Starts („Meldebestand erreicht" →
`lager.beschaffung_ausfuehren` mit der Regel als record_id | „Bedarf
erkannt" → Bestellung anlegen) laufen bei „Bestellen" zusammen; danach
Teilprozess **Wareneingang** (eigener Prozess am Eingangs-Transfer:
validieren/buchen, Storno als Ausstieg), Rechnung erstellen, Teilprozess
**Lieferantenrechnung** (bestehender Prozess bis „bezahlt"), Ende. Die
Fixtures spielen beide Starts und die ganze Kette end-to-end durch; der
Interpreter kennt Teilprozess-Schritte (Auslöser treibt den Kindbeleg,
danach müssen ALLE Kindbelege fertig sein) und die
record_id-Konvention für Anlage-Schritte an fremden Belegen.

Bewusste Grenzen: `purchase_orders.done` bleibt der manuelle
Sperr-Zustand (kein Automatik-Mapping); direkte Teilprozess-Rekursion
ist verboten, tiefere Zyklen zwischen Prozessen prüft die Aktivierung
noch nicht.

## Verkauf komponiert: Auftrag → Lieferung (Migrationen 0064/0065, umgesetzt)

Das Spiegelbild des Einkaufs-Piloten: Der Verkauf endete bisher an einer
offenen Kante („Lieferung läuft") — der Versand lief als eigener Prozess
DANEBEN, nicht IN der Kette. Jetzt hängt er als Teilprozess am
Ausgangs-Transfer, den `confirm_sales_order` mit der Bestätigung ohnehin
anlegt (genau wie die Bestellbestätigung den Eingangs-Transfer):
**Angebot → Positionen → Bestätigen → Teilprozess Lieferung → Ende**, der
Storno-Ausstieg bleibt. Der Auftrag ist erst fertig, wenn die Ware raus
ist, und das Diagramm zeigt dem Kunden seinen Ablauf von Anfang bis Ende.
Der Versandprozess heißt jetzt neutral **„Lieferung & Versand"** — sein
Beleg-Filter (origin_model = sales_order) deckt seit 0050 jeden
Verkaufsauftrag ab, nicht nur Shop-Bestellungen; der Code
`shopify_bestellung_versand` bleibt als technische ID (Instanzen und
Vorgänge referenzieren ihn).

Der Umbau legte einen echten Fehler frei: Der Versandprozess verlangte die
**Shop-Rückmeldung von jedem** Ausgangs-Transfer — auch von manuell
erfassten Aufträgen, die nie eine bekommen. Unsichtbar, solange der
Verkauf vorher endete; mit der Kette hätte jeder manuelle Auftrag ewig
gewartet. Die Kante konnte nicht danach fragen, ob der Auftrag aus dem
Shop kam, weil Bedingungen nur die Spalten des eigenen Belegs sehen — am
Transfer steht die Herkunft nur als origin_model/origin_id. Deshalb
reichert `prozess_beleg_daten()` Belege mit Herkunft jetzt generisch um
die Felder des Herkunftsbelegs an, flach unter dem Präfix **`herkunft_`**
(rein additiv, Tabellennamen weiter nur über den Modell-Katalog). Damit
trägt die Kante zur Rückmeldung die Bedingung
`herkunft_source = shopify`, der Schritt ist optional, und manuelle
Lieferungen sind mit dem gebuchten Warenausgang fertig.

Bewusste Grenze: Nach der Lieferung endet die Kette. Eine Abrechnung
fehlt, weil es kein Kundenrechnungs-Modul gibt (aus demselben Grund flog
in 0052 die invoice_status-Kachel). Kommt ein AR-Modul, kommt der
Abrechnungs-Teilprozess dahinter — wie im Einkauf.

## Belegsignale folgen dem Prozessschritt (Migration 0052, umgesetzt)

Felder wie `billing_status` bleiben als **Fakten** am Beleg (Historie,
Wieder-Einschalten findet alles wieder), aber ihre **Signalwirkung** —
„hier fehlt noch etwas" — gilt nur, solange der zugehörige Schritt Teil
des Ablaufs ist. `prozessschritt_aktiv(prozess, schritt)` ist die eine
Frage, die Oberflächen dafür stellen (Schritt in der aktiven Version
vorhanden und nicht per Override abgeschaltet). Gekoppelt sind bisher:

- Einkaufsliste + Bestelldetail: Spalte „Abrechnung", Karte „Rechnungen"
  und „Rechnung erstellen" hängen an
  `prozessschritt_aktiv('einkauf_wareneingang_rechnung','rechnung')`.
- Navigation: der Punkt **Beschaffung** (samt Zähler) erscheint nur mit
  aktivem Einkaufs- oder Fertigungsprozess — Vorschläge, die nirgendwo
  münden können, sind kein Signal. Meldebestände bleiben Daten.
- Verkaufsdetail: die Abrechnungs-Kachel (`invoice_status`) ist raus —
  es gibt kein Kundenrechnungs-Modul, das Signal zeigte ins Leere. Das
  Feld bleibt am Beleg; kommt ein AR-Modul, kommt die Kachel mit
  `prozessschritt_aktiv()` zurück.

## Konsistenz-Wächter beim Schalten (umgesetzt)

Teilprozess-Kanten sind harte Abhängigkeiten. Zwei Wächter in
`einstellungen.prozess_schalten` / `einstellungen.paket_aktivieren`:

- **Abschalten blockt**: ein Prozess, den ein aktiver Elternprozess als
  Teilprozess einbindet, lässt sich nicht abschalten — die Meldung nennt
  Elternprozess und Schritt. Erst den Eltern abschalten (oder den Schritt
  aus der Version nehmen).
- **Einschalten und Paketwechsel ziehen mit**: das Aktivieren eines
  Prozesses (und jedes Paket) aktiviert seine Teilprozesse transitiv
  mit — ein Paket, das den Einkauf nennt, bekommt Wareneingang und
  Lieferantenrechnung automatisch dazu; das Ergebnis nennt die
  mitgezogenen Prozesse. Zusätzlich weist der Paketwechsel (weich, kein
  Fehler) auf Schritte hin, deren Aktion in einen Bereich ohne aktiven
  Prozess zeigt — Belege daraus laufen ohne Prozessbegleitung.

Der statische Vollständigkeitstest prüft dieselbe Invariante am
Auslieferungszustand; die Wächter halten sie unter Laufzeit-Schaltungen.

## Befugnisse + Bestellfreigabe (Migration 0056, umgesetzt)

Rechte auf Prozessschritte, personengebunden — die Bereichsmatrix bleibt
der Sicherheitsboden darunter:

- **users.befugnisse** (z. B. `einkauf:freigabe`): Zusatzrechte je
  Benutzer, vergeben in der Benutzerverwaltung (Katalog in
  `permissions.ts` → BEFUGNISSE). Orthogonal zur Rolle — ein
  Büro-Mitarbeiter kann Freigeber sein, ein anderer nicht.
- **prozess_schritte.befugnis** (+ Override je Firma): ein Schritt kann
  neben `rollen` eine Befugnis verlangen. Der **Torwächter erzwingt das
  hart auf jedem Transportweg** (Knopf auf der Belegseite, /api/aktion,
  KI-Chat) — nicht nur im Prozess-Panel. Admin besteht immer. Die
  Versionskopie nimmt die Spalte mit; der KI-Entwurf kann sie setzen.
- **Pilot Bestellfreigabe**: Limit als Einstellung
  (`settings freigaben.einkauf_limit`, netto; leer = aus — nichts ist
  hartkodiert, Pflege auf /einstellungen). Der Riegel sitzt als Trigger
  an der Statusmaschine: draft/sent → purchase geht über dem Limit nur
  mit vorliegender Freigabe. `purchase_order_approve()` gibt frei (einmal,
  nur offene Bestellungen, mit Audit); Positionsänderungen lassen die
  Freigabe erlöschen — freigegeben wurde eine Summe, kein Beleg. Der
  Schritt „Bestellung freigeben" (Einkauf V6, optional, Befugnis
  `einkauf:freigabe`) macht das im Diagramm sichtbar und konfigurierbar.

Jede künftige Freigabe (Gutschrift, Rabatt, Fertigungsstorno) ist damit
nur noch: Befugnis in den Katalog, Schritt mit Befugnis in den Prozess.

## Daily Routine: Befehlsfeld, Ad-hoc-Masken, Lern-Gedächtnis (0057, umgesetzt)

Task-first statt Kachel-Moloch — man kommt ins System, um EINEN Task zu
machen:

- **Befehlsfeld** im Zentrum der Übersicht: Aktionen und Seiten matchen
  sofort und lokal (kein LLM im heißen Pfad), Belege per entprellter
  Suche (`/api/suche`, rollengefiltert), und wenn nichts passt, geht der
  Freitext an den KI-Agenten (`/ki?frage=…`, stellt die Frage
  automatisch).
- **Ad-hoc-Masken** `/aktion/<name>`: jede frei gebundene Registry-Aktion
  bekommt ihre GENERIERTE Maske (dieselbe Feldmaschine wie das
  Prozess-Panel, `aktionsAngebot()`), sofort offen, abgeschickt über den
  Torwächter. Deterministisch und in Millisekunden — die KI ist
  Dolmetscher (Absicht → Aktion), nicht Maskenbauer.
- **Lern-Gedächtnis je Benutzer** (`nutzungs_zaehler`): der Torwächter
  zählt ausgeführte Aktionen, das Befehlsfeld gemeldete Seiten
  (`/api/nutzung`, nur 'seite' — Aktionszähler sind nicht von außen
  hochtreibbar). Häufiges steht als Chips unterm Feld und boostet das
  Ranking. Überlebt den Demodaten-Neustart (BEHALTEN-Liste), fällt mit
  dem Benutzer.
- **Signalkarten „Heute anstehend"**: nur Karten mit Handlungsbedarf
  (Freigaben, überfälliger Zulauf, Integrationsfehler, Versandbereit,
  Beschaffung, Abwesenheitsanträge, Tickets) — rollen- und
  prozessgefiltert. Keine Signale: eine grüne Zeile, sonst nichts.
- **Strg/Cmd+K überall**: dasselbe Befehlsfeld als Overlay auf jeder
  Seite (Knopf ⌘K in der Kopfleiste), gemeinsamer Katalog in
  `modules/befehle.ts`.
- **Beleg + Aktion in einem Zug**: „P01670 freigeben" matcht die JETZT
  möglichen Prozessschritte des Belegs (`prozess_naechste_schritte`,
  rollengefiltert). Parameterlose Schritte laufen nach Rückfrage direkt
  (Torwächter prüft), mit Feldern geht es zur Belegseite.
- **KI-Zuruf an der Ad-hoc-Maske**: „ist aber Lieferant" →
  `/api/ki/aktion/aendern` schreibt den Feldsatz um (gegen dasselbe
  Schema geprüft), die Maske baut sich in Echtzeit um — ausgeführt wird
  weiterhin nur über den Absende-Knopf.

## PWA, Spracheingabe, deutsche Feldbeschriftungen (umgesetzt)

Das ERP fühlt sich installiert wie eine native App an — und man kann
hineinsprechen:

- **PWA-Installation**: `src/app/manifest.ts` liefert das Web-App-Manifest
  (`display: standalone`, Icons 192/512 + maskable, generiert in
  `public/`), `layout.tsx` trägt die `appleWebApp`-Metadaten und den
  Viewport (`viewportFit: cover`, Theme-Farbe hell/dunkel). Damit bieten
  Chrome/Edge den Installieren-Knopf an, auf iOS „Zum Startbildschirm" —
  randlos, ohne Browserleiste. Bewusst OHNE Service-Worker-Caching: ein
  ERP zeigt live Daten, nie einen alten Bestand aus dem Cache.
- **Composer im Claude-App-Stil** (`.composer` in `globals.css`): eine
  runde Kapsel mit Eingabefeld, Mikrofon und Senden-Pfeil INNEN — benutzt
  vom Befehlsfeld (Übersicht + Strg/Cmd+K), vom KI-Chat und von der
  Zuruf-Zeile der Ad-hoc-Masken. Auf dem Handy sitzt das
  Dashboard-Befehlsfeld fixiert unten am Daumen (Safe-Area beachtet), die
  Treffer klappen nach oben auf.
- **Spracheingabe über Whisper** (`src/components/spracheingabe.tsx` +
  `/api/transkription`): der Browser nimmt nur noch AUF (MediaRecorder,
  Auto-Stopp nach 90 s), transkribiert wird serverseitig über die
  OpenAI-Audio-API (`modules/ki/transkription.ts`, Modell per
  `TRANSKRIPTION_MODELL`, Standard `whisper-1`) — keine
  Browser-Raterei, ein Modell für alle Geräte. Klick startet die
  Aufnahme (Puls), zweiter Klick stoppt, der Text landet im Feld;
  abgeschickt wird bewusst per Hand (Enter oder Pfeil). Ohne
  `OPENAI_API_KEY` oder Mikrofon-API erscheint der Knopf gar nicht.
- **Deutsche Feldbeschriftungen**: das `TEXTE`-Wörterbuch in
  `schema-felder.ts` deckt alle ~175 Formularfelder der Registry ab
  (`list_price` → „Verkaufspreis (netto)", `uom_id` → „Einheit",
  `street` → „Straße" …) — generierte Masken sprechen durchgehend
  Deutsch, nicht mehr Spaltennamen-Englisch.

## Finanzen: Cashflow, Verträge, Darlehen, Steuern, Prognose (0058–0061, umgesetzt)

Die Geldseite des ERP — gebaut für eine Frage: **wie viel Fremdkapital
braucht der Wareneinkauf in den nächsten 12 Monaten?** Vier Migrationen,
je einzeln releasebar:

- **Zahlungsregister (0058)**: `zahlungen` ist das Ist — jede Bewegung mit
  eingefrorenem Kurs und `betrag_eur` als Rechenwahrheit, Storno statt
  Löschen. `bankkonten` + manuelle `kontostaende`-Anker (kein Bankimport);
  `finanz_saldo()` = Anker + Zahlungen danach. Teilzahlungen auf
  Lieferantenrechnungen mit **Anrechnungsregel**: Zahlplan-Raten derselben
  Bestellung mindern den offenen Rechnungsbetrag (30/70-Fälle zählen nie
  doppelt). `zahlplan_raten` je Bestellung (Anteil ODER Betrag, Auslöser
  Bestellung/Verschiffung/Ankunft/Termin, Versatz); `pay_vendor_bill` ist
  jetzt ein Wrapper um `zahlung_erfassen` — der Prozess „Lieferantenrechnung"
  schreibt unverändert, aber ins Register. `finanz_faellig(bis)` sammelt
  alles Anstehende (exists-Weiche: je Bestellung zählt ENTWEDER Zahlplan
  ODER Rechnung).
- **Verträge (0059)**: Fixkosten als `vertraege` (VT/, Intervall, Zahltag,
  Mindestlaufzeit = rollierende Verlängerung, Kündigungsfrist). Die
  Kündigungs-Mathematik (`vertrag_naechstes_kuendbar_zum`,
  `vertrag_kuendigung_ansteht` mit Vorlauf aus settings) speist das violette
  Signal „Kündigungsfrist läuft ab"; `vertrag_zahlungen_bis` projiziert die
  Termine in die Prognose. Ein Prozess `vertrag_fixkosten`
  (anlegen → kündigen) in allen Paketen; „beendet" setzt der Tageslauf.
- **Darlehen + Steuern (0060)**: `darlehen` mit generiertem Tilgungsplan
  (Annuität A=S·i/(1−(1+i)^−n), lineare Rate, endfällig;
  Regenerier-Riegel sobald Raten bezahlt sind), Auszahlung bucht die
  Einzahlung ins Register. `steuerzahlungen` (USt/GewSt/KSt, negativ =
  Erstattung, unique je Art+Zeitraum); `ust_zahllast_vorschlag(monat)`
  rechnet Umsatzsteuer − Vorsteuer aus den Belegen und wird per Klick (oder
  Cron) als Termin übernommen — gebucht wird nie automatisch.
- **Umsatzplan + Prognose (0061)**: `umsatzplan` (Monat × best/base/worst,
  Vorschlag = Vorjahresmonat × Trend, Handeingaben gewinnen dauerhaft).
  `finanz_prognose(szenario, raster)` über 13 Wochen oder 12 Monate:
  Planumsatz taggenau mit Kanal-Split (historische Shopify-Quote) und
  Zahlungsversatz; Bestellabflüsse aus drei DISJUNKTEN Quellen (offene
  Zahlplan-Raten, offene Rechnungen ohne Zahlplan, Restobligo bestätigter
  Bestellungen); Verträge/Darlehen/Steuern; USt-Automatik
  (`ust_zahllast_quote_pct` × Planumsatz) nur für Monate ohne erfasste
  Zeile. Herzstück ist das **kumulative Deckungskonto** der
  Wareneinsatz-Quote: Soll C_t = Σ Quote × Planumsatz, Deckung D =
  Bestandswert + Zulaufwert bestätigter Bestellungen, Abfluss = ΔR mit
  R_t = max(0, C_t − D). Ware, die da oder konkret bestellt ist, zählt
  nie doppelt — eine neu erfasste Bestellung wandert von der Quote zu den
  konkreten Zahlungen. `finanz_unterdeckung()` = Fremdkapitalbedarf
  (Tiefpunkt gegen Liquiditätspuffer) — violett im Cockpit und als
  Dashboard-Signal. Alle Quoten/Sätze/Zahltage im settings-Schlüssel
  `finanzen`, pflegbar unter Einstellungen → Finanzen; nichts ist im Code
  festgelegt.

Rechte: Bereich `finanzen` sehen nur Admins oder Träger der Befugnis
`finanzen:zugriff` (`BEFUGNIS_AREAS` in `permissions.ts` — Gehälter gehen
nicht jede Büro-Rolle an). Cron `?task=finanzen` (täglich 5 Uhr) beendet
abgelaufene Verträge, legt den USt-Vorschlag des Vormonats an und zieht
die Umsatzplan-Vorschläge nach — idempotent. Tests: Anrechnung,
Fälligkeits-Auslöser, Kündigungsfristen, Tilgungs-Mathematik,
USt-Nachrechnung und die vier Deckungskonto-Prüffälle auf neutralisierter
Datenlage (`tests/finanzen.test.ts`).

## Sprachmodus /sprechen: Echtzeit-Gespräch mit Sammel-Transaktion (0062, umgesetzt)

Freisprech-Dialog wie mit einem Gaming-Assistenten — „Ich zähle 788 Switches
Gateron Blue, was hast du im System?" → gesprochene Sofort-Antwort. Technik:
**OpenAI Realtime** (Speech-to-Speech), WebRTC direkt Browser ↔ OpenAI; der
Server (`/api/sprechen/session`) mintet nur kurzlebige Client Secrets
(`SPRECHEN_MODELL`, Standard gpt-realtime-2.1; `SPRECHEN_STIMME`). Kein
API-Key im Client. **Achtung Kosten:** Realtime rechnet Audio-Tokens ab
(Input je 100 ms, Output je 50 ms) — lange Gespräche kosten spürbar; nach
fünf Minuten Stille trennt der Client selbst.

Kernprinzip **Sammeln statt Sofort-Buchen**: Lesewerkzeuge antworten live
(`produkt_bestand` — unscharfer Resolver mit Wortstamm-Suche und Bestand;
`aktionen_suchen` — beide KI-Kataloge, rechtegefiltert, Felder mit deutschen
Labels; `datenfrage` — kleines Anthropic-Modell mit Schema-Doku +
Read-only-SQL, nur bei gesetztem ANTHROPIC_API_KEY). Schreibwünsche landen
über `vorgang_sammeln` NUR in der Sammel-Transaktion der Sitzung
(`sprach_vorgaenge`, Status offen) — Schema und Rechte werden beim Sammeln
sofort geprüft (Torwächter, die Stimme meldet Lücken), gebucht wird nichts.
Nach dem Beenden zeigt `/sprechen` die **Prüftabelle**: Zeilen mit
angesagter Zusammenfassung, Zählmengen korrigierbar, Verwerfen je Zeile,
dann **„Alle offenen buchen"** — sequenziell über
`aktionAusfuehrenGeprueft`, Zählungen als Kette erfassen → buchen (der
Bestands-Wächter von `inventory_apply` greift im Buchungsmoment). Nicht
gebuchte Sammlungen warten beim nächsten Besuch als „offene Sammlung".

Oberfläche: das KRNL-Hexcore ist die einzige Zustandsanzeige (pulsiert beim
Hören, atmet beim Antworten), darunter ein kompaktes Live-Log mit den
besprochenen Werten statt eines Volltranskripts. **Hosentaschen-Modus** für
In-Ears: app-seitig schwarz + berührungsgesperrt (Doppeltipp entsperrt),
Wake Lock hält den Schirm — bewusst keine echte OS-Sperre, die würde auf
iOS das Mikrofon kappen. Jede Sitzung hinterlässt ein Protokoll
(`sprachprotokolle` + `…_eintraege`: Transkript client-gepuffert,
Werkzeug-Einträge serverseitig); die KI-SQL-Sperrliste deckt die
Protokolltabellen ab. Sichtbar für Bereich `ki`, Aktionen können nie mehr
als die Rolle des Sprechers (Torwächter, nurAdmin, Befugnisse).

Das Sprechen ist der **Kern-Einstieg** ins ERP, keine Randnotiz: der
Sidebar-Eintrag steht ganz oben neben der Übersicht, und der KI-Chat
(Slide-out im Header wie Seite `/ki`) kann beides — tippen UND reden. Der
Hexcore-Knopf im Composer öffnet den **Buddy-Modus**: dieselbe Sprachsitzung
als Vollfläche im Chat (wie der Voice-Mode der Claude-/ChatGPT-Apps), nach
dem Beenden führt ein Hinweis zur Prüftabelle auf `/sprechen`. Die
Sitzungslogik lebt dafür in einem geteilten Hook
(`sprechen/nutze-gespraech.tsx`) — Seite und Buddy sind nur zwei
Oberflächen derselben Sitzung.

## Prozess-Werkstatt (/prozesse/werkstatt): mit dem Agenten bauen

Prozesse entstehen nicht nebenbei im Alltags-Chat, sondern in der
**Werkstatt** (Einstieg: violetter Knopf auf /prozesse, Befehlsfeld
„Prozess-Werkstatt"; Bereich `einstellungen`): Der KI-Chat läuft dort im
**Werkstatt-Kontext** — der Agent wird zum Prozess-Architekten
(`werkstattSystemZusatz()` aus `src/modules/ki/wissen.ts`: Bestand per SQL
nachschlagen und als Tabelle zeigen, Schrittliste bestätigen lassen,
Entwürfe NUR über `aktion_vorschlagen` mit `einstellungen.prozess_entwerfen`).
Der Kontext ist ein serverseitig geprüftes Enum (nur Admins), kein Freitext.
Auf der Seite: die Entwurfsliste aller Prozesse, und per `?code=` die
**Diagramm-Vorschau der neuesten Entwurfsversion** (React Flow, geteiltes
Lese-Modul `version-diagramm.ts`) mit Sprung zur Detailseite — dort wird
nach Sichtprüfung von Hand aktiviert. `werkstatt` ist als Prozess-Code
reserviert (Routen-Kollision, per Schema-refine + Test abgesichert).

## Prozess-Aufnahme beim Kunden (Sprachinterview → Entwurf → Diagramm)

Die Spitze des Prozess-First-Ansatzes: Beim Kunden wird der **Ist-Prozess im
Gespräch aufgenommen** — der violette Knopf „Sprach-Interview starten" in
der **Werkstatt** (nur Admin, braucht OPENAI_API_KEY + ANTHROPIC_API_KEY;
bewusst NICHT im Alltags-Assistenten /sprechen) startet eine
Realtime-Sitzung mit Interview-Anleitung: die KI fragt nach Auslöser,
Schritten, Zuständigkeiten, Entscheidungen und Ausnahmen, fasst
abschnittsweise zusammen und lässt bestätigen. Bewusst nur zwei Werkzeuge
(`aufnahme_abschliessen`, `sitzung_beenden`) — interviewt wird, nicht im ERP
hantiert.

Beim Abschluss übernimmt die Arbeitsteilung nach Stärke: Das
Sitzungstranskript (serverseitig in `sprachprotokoll_eintraege`, der Client
spült seinen Puffer vor dem Abschluss) geht an den Claude-Agenten
(`AUFNAHME_MODELL`, Standard = Agentenmodell), der es — angeleitet von der
versionierten Wissensbasis `src/modules/ki/wissen.ts` (Schritt-Granularität,
XOR-Muster, Abbruchwege, Interview-Leitfragen) — in einen
`einstellungen.prozess_entwerfen`-Aufruf strukturiert — Ist-Prozesse immer
als `vorgang`-Modell mit frei definierten Zuständen, also **ohne eine Zeile
Entwicklung**. Ausführung über denselben geprüften Weg wie jede KI-Aktion
(Torwächter, nurAdmin, log_event); lehnt die Validierung ab, darf das
Modell bis zu dreimal nachbessern. Ergebnis ist IMMER nur ein **Entwurf**
(inaktive Prozessversion): der Entwurf-Code geht strukturiert an die
Oberfläche zurück (`beiEntwurf`-Callback des Hooks), die Werkstatt springt
direkt auf die Diagramm-Vorschau — die Sichtprüfung mit dem Kunden ist das
BPMN-Diagramm, aktiviert wird auf /prozesse/&lt;code&gt; von Hand.

## Onboarding einer frischen Instanz (Weiche + fünf Schritte)

Jede neue Kundeninstanz startet leer (Deploy migriert und seedet nur den
Administrator). Der **erste Admin-Login** landet automatisch in der
Ersteinrichtung `/einrichtung` — erkannt an drei Merkmalen zugleich:
settings-Schlüssel `einrichtung` fehlt, Firmenname steht noch auf dem
Migrations-Default, genau ein Nutzer. Dort steht zuerst die Weiche:

- **Demo-Modus**: spielt per Registry-Aktion
  `einstellungen.demodaten_einspielen` die komplette Beispielfirma ein
  (Tastaturfertigung mit Varianten, Betriebshistorie, Finanzen) — zum
  Ausprobieren und für den Rundgang. Der Idempotenz-Wächter verweigert
  das, sobald echte Produkte existieren; die Gefahrenzone räumt die
  Beispieldaten später restlos ab.
- **Richtig loslegen**: die fünf Schritte unten.

Die fünf Schritte lösen ein, was die öffentliche Startseite verspricht
(Aufnehmen → Zeichnen → Läuft) — [website.md](website.md) beschreibt die
Gegenseite:

| # | Schritt | Was passiert | Aktionen |
|---|---|---|---|
| 01 | **Instanz** | Firmendaten und Geschäftsmodell-Paket. Rechts steht, was an der Instanz schon wahr ist: echter Host, Region, Anzahl eingespielter Migrationen, Rückholpunkt und Daten-TÜV. Keine erfundene Fortschrittsanzeige. | `einstellungen.firma_speichern`, `einstellungen.paket_aktivieren` |
| 02 | **Team** | Personen und Rollen (Rollen entscheiden später, wer welchen Prozessschritt sehen und buchen darf — auch per Sprache), dazu das Ersetzen des Start-Passworts. | `einstellungen.benutzer_anlegen`, `einstellungen.benutzer_passwort` |
| 03 | **Aufnehmen** | Vier Fragen (Auslöser, Schritte, Zuständigkeiten, Ausnahmen). Die Antworten gehen als Transkript an **dieselbe** Strukturierung wie das Sprach-Interview der Werkstatt (`/api/aufnahme` → `aufnahmeStrukturieren`) und enden in einem Entwurf. | `einstellungen.prozess_entwerfen` (aus der Strukturierung heraus) |
| 04 | **Zeichnen** | Das **echte** Diagramm des Entwurfs (`versionDiagramm` + `ProzessFlow`, dieselbe Ansicht wie unter /prozesse). Jeder Schritt lässt sich als „stimmt nicht" markieren: dann geht es mit einer Korrekturrunde zurück nach 03. Ohne Markierung wird die Abnahme protokolliert. | `einstellungen.prozess_abnahme` |
| 05 | **Läuft** | Kennzahlen des Entwurfs (Schritte, Rollen, generierte Masken) und das Schalten der Version. Danach ist der Ablauf das System. | `einstellungen.prozessversion_aktivieren` |

Das Paket in Schritt 01 ist weiterhin der folgenreichste Klick: ohne Wahl
bleiben ALLE Prozesse aktiv und die Navigation zeigt das Maximum (Chamäleon).

**Die Abnahme ist ein Beleg, keine Bildschirmgeste.** Migration 0067 gibt
`prozess_versionen` die Spalten `abnahme_am`, `abnahme_durch`,
`abnahme_notiz`; `einstellungen.prozess_abnahme` schreibt sie und
protokolliert im Audit-Log. Bewusst an der Version festgemacht und nicht an
der Aktivierung: aktiviert wird eine Version vielleicht mehrfach
(Rückfall auf eine ältere), abgenommen wird sie einmal.

Nach der Aufnahme lädt die Seite mit `?entwurf=<code>` neu — der Server
kennt den Entwurf, der Assistent steigt in Schritt 04 ein. Die getippten
Antworten überleben das in der `sessionStorage` (für Korrekturrunden);
sie gehören weder in die Datenbank noch in die URL.

**Ohne KI-Schlüssel** bleiben die Schritte 01/02 vollständig nutzbar,
Schritt 03 sagt das offen und die Einrichtung lässt sich trotzdem
abschließen — der erste Ablauf entsteht dann später in der Werkstatt. Kein
Schritt ist eine Sackgasse.

Der Abschluss (`einstellungen.einrichtung_abschliessen`) schreibt den
settings-Schlüssel `einrichtung` — der überlebt auch die Gefahrenzone,
die Weiche erscheint also nie wieder. Alle Aktionen sind nurAdmin,
prozessfrei und laufen durch den Torwächter; Nicht-Admins sehen bis zur
Einrichtung nur einen Hinweis. Wächter: tests/einrichtung.test.ts
(Registry-Statik, Demodaten-Guard, Weichen-Heuristik) und
tests/demodaten.test.ts (kein automatischer Beispieldaten-Pfad).

## Strukturregeln eines Prozessentwurfs (BUG/00015)

Drei Regeln entscheiden, ob eine Prozessversion geschaltet werden kann:

1. **XOR-Default** — an einer Verzweigung darf höchstens EINE ausgehende
   Kante ohne Bedingung sein (der Standardweg), und sie muss die LETZTE
   sein. Sonst greift sie, bevor die Bedingungen geprüft werden.
2. **Erreichbarkeit** — jeder Schritt braucht einen Weg von einem Start aus.
3. **Azyklik** — Schleifen sind verboten; Wiederholungen bildet man als
   eigenen Zustand oder als neuen Vorgang ab.

Sie stehen an **zwei** Stellen, und das ist Absicht:

- `prozess_version_aktivieren` (SQL) ist die **letzte Instanz** — Entwürfe
  können auch per Migration oder Handarbeit entstehen.
- `prozesse/entwurf-pruefen.ts` (pur, ohne Datenbank) prüft dieselben Regeln
  schon in `einstellungen.prozess_entwerfen`. Grund: ein Entwurf, der nicht
  aktivierbar ist, ist kein Entwurf, sondern eine Falle — und die KI
  (`aufnahmeStrukturieren`, drei Runden) kann den Fehler nur beheben, wenn
  sie ihn beim Entwerfen bekommt.

Wächter: tests/entwurf.test.ts (die Regeln einzeln) und
tests/prozesse/prozesse.test.ts (beide Ebenen: Entwurf lehnt ab, und an der
Aktion vorbei greift der SQL-Wächter).

**Bedingungsfelder**: Was in einer `bedingung` stehen darf, liefert
`prozess_beleg_daten` — die Spalten des Belegs, `zusatz.*`, die
`herkunft_*`-Felder (Migration 0065) und beim Verkaufsauftrag zusätzlich
`fertigung_noetig` und `fertigung_automatisch` (Migration 0068). Der
Unterschied zwischen beiden ist genau BUG/00014: fertigbar ist eine Position
mit Stückliste und Route „fertigen"; automatisch angelegt wird nur, was
zusätzlich „auf Bestellung fertigen" trägt. `sales_order_fertigungslage()`
nennt die Lücke mit Grund, und der Auftrag zeigt sie an.

## Schutzschicht für den Kundenbetrieb (Entscheidung 08/2026)

KRNL wird an mehrere Kunden ausgerollt, mit häufigen Feature-Updates. Der
Schutz gegen Datenverlust ist gestapelt — kein einzelner Mechanismus, sondern
vier Schichten:

- **Instanz pro Kunde**: jeder Kunde bekommt ein eigenes Deployment und eine
  eigene Datenbank (eigenes Supabase-Projekt). Updates rollen in Ringen aus:
  erst die eigene ANVIL-Instanz, dann ein Pilotkunde, dann der Rest. Ein
  fehlerhaftes Update trifft so höchstens einen Kunden, Restore geht pro
  Kunde, und es gibt kein mandantenübergreifendes Leck-Szenario.
- **Point-in-Time-Recovery** je Kundenprojekt aktivieren (Supabase-Add-on)
  und den Restore vierteljährlich in ein Wegwerf-Projekt PROBEN — ein
  ungetestetes Backup zählt nicht. (Betriebsaufgabe, kein Code.)
- **Migrations-Wächter** (tests/migrationen.test.ts): Migrationen sind der
  einzige Schreibweg am Torwächter vorbei. Destruktive Statements (drop,
  truncate, delete außerhalb von Funktionskörpern) machen die Suite rot,
  außer die Migration begründet sie ausdrücklich mit `-- DESTRUKTIV: …`.
  Regel dazu: **Expand-Contract** — neue Struktur zuerst anlegen und
  befüllen, Altes erst Releases später wegräumen, nie beides im selben
  Deploy.
- **Daten-TÜV** (`daten_tuev`-Job, nächtlich über den housekeeping-Cron):
  prüft die Kern-Invarianten — Bestand = Move-Ledger, Reservierungs-Cache =
  offene Moves, Wertschichten = bewerteter Bestand, fertige Moves
  vollständig. Befunde lassen den Job absichtlich FEHLSCHLAGEN (roter Badge,
  Integrationen-Monitor); Betriebszustände wie negativer Bestand oder nicht
  mehr gedeckte Reservierungen laufen als Warnungen im Ergebnistext mit.
  Neue Invarianten kommen als weitere Prüfung in
  src/modules/lager/daten-tuev.ts dazu.

## Pilotbetrieb: Provisionierung, Ringe, Nutzungsbericht

Phase 1 der Monetarisierung: **2–3 zahlende Pilotkunden**, Instanz pro
Kunde. Kein Lizenzmodul — stattdessen **Nutzungs-Reporting light** als
Grundlage der Preisgespräche.

**Provisionierungs-Checkliste je Kunde** (Betriebsaufgaben, kein Code):

1. Supabase-Projekt (EU) anlegen, PITR + Retention aktivieren.
2. Vercel-Projekt auf den Ring-Branch des Kunden zeigen lassen.
3. Env-Satz setzen — eigene KI-Schlüssel je Kunde (Kostentrennung),
   eigene Shopify-/DHL-Zugänge, `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`.
4. Deploy: migriert und seedet nur den Administrator.
5. Erstlogin **mit dem Kunden**: die Onboarding-Weiche (oben) durchgehen —
   geführt, Paket wählen, Team, Passwort.
6. Prozess-Aufnahme in der Werkstatt als Onboarding-Ritual: die
   Ist-Prozesse des Kunden im Gespräch aufnehmen, Diagramm gemeinsam
   prüfen, aktivieren.
7. Restore-Probe VOR Go-Live (PITR in Wegwerf-Projekt zurückspielen).
8. Support-Kanal = bug_ticket-Prozess der Instanz.

**Ringe**: Ring 0 = eigene ANVIL-Instanz, Ring 1 = Pilot A, Ring 2 =
Piloten B/C. Updates rollen ringweise mit Soak-Zeit; Details in der
Schutzschicht (oben).

**Nutzungsbericht** (`/einstellungen/nutzung`, nur Admin): die
SQL-Funktion `nutzungsbericht(monate)` (Migration 0063) liefert je Monat
aktive Nutzer (Audit-Log-Akteure mit Konto + Sprachsitzungs-Nutzer),
neue Kernbelege (Verkauf, Einkauf, Fertigung, Reparatur,
Lieferantenrechnung), KI-Fragen (audit_log model='ki': jede Chat-Runde —
Zählpunkt in /api/ki — und jede ausgeführte KI-Aktion) und
Sprachsitzungen. Die Zahlen **bleiben in der Instanz** (kein Phone-Home);
für Pilotverträge werden sie monatlich von Hand gezogen. Pilotstruktur
(Platzhalter, mit den Piloten zu füllen): Pilotvertrag + AV, Preis /
Laufzeit / Ausstieg, Metriken = die drei Berichtsgrößen,
Wochen-Feedback über bug_ticket. Wächter: tests/nutzung.test.ts.

## Noch offen (Kurzfassung)

- **Kundenrechnungen (AR)** — das einzige fehlende Glied der Verkaufskette:
  Ausgangsrechnung, Zahlungseingang, Mahnwesen. Erst damit bekommt der
  Verkauf seinen Abrechnungs-Teilprozess (siehe oben).
- **Signal-Kopplung deklarativ machen**, sobald ~5 Stellen von Hand
  verdrahtet sind: Signale als Schritt-Metadaten deklarieren (welcher
  Schritt trägt welches Beleg-Signal), Oberflächen fragen generisch, ein
  Vollständigkeitstest findet vergessene Kopplungen. Heute sind es drei
  Stellen (Einkaufs-Abrechnung, Beschaffungs-Navigation, Verkaufs-
  Abrechnung entfernt) — Handverdrahtung ist noch billiger.
- Fähigkeits-Umbenennung der Job-Kinds — bewusst zurückgestellt: die
  Fähigkeits-Schicht liegt bereits im JOB_KATALOG (anbieterneutral,
  getestet), ein Umbenennen der persistierten Kinds (integration_jobs,
  Dedupe-Schlüssel) brächte Datenmigration ohne Verhaltensgewinn.
