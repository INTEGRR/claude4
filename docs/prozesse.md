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

## Kommende Phasen (Kurzfassung)

4. **Maskengenerierung** aus zod-Schemas (`/p/[prozess]`), Pilot „Artikel anlegen".
5. **Externe Schritte + Bug-Loop + Staging-Automation** (Ticket ↔ Prozesstest ↔ Commit).
6. **Breitenmigration + Laufzeit-Overrides** (Schritte an/aus je Firma).
7. **Chamäleon**: Navigation/KPIs als Projektion aktiver Prozesse,
   Geschäftsmodell-Vorlagen, eigene Felder ohne Migration, generischer
   Vorgang, Fähigkeits-Adapter, KI-Prozessentwurf.
