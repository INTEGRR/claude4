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

## Kommende Phasen (Kurzfassung)

3. **Prozesstest-Harness + Testdatensatz**: Fixtures je Prozess
   (mitversioniert, Vollständigkeits-Check), Wegwerf-DB lokal, per
   DATABASE_URL gegen Staging; Fake-Adapter für Shopify/DHL/Mail.
4. **Maskengenerierung** aus zod-Schemas (`/p/[prozess]`), Pilot „Artikel anlegen".
5. **Externe Schritte + Bug-Loop + Staging-Automation** (Ticket ↔ Prozesstest ↔ Commit).
6. **Breitenmigration + Laufzeit-Overrides** (Schritte an/aus je Firma).
7. **Chamäleon**: Navigation/KPIs als Projektion aktiver Prozesse,
   Geschäftsmodell-Vorlagen, eigene Felder ohne Migration, generischer
   Vorgang, Fähigkeits-Adapter, KI-Prozessentwurf.
