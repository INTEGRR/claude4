# Code-Review: Wartbarkeit und Modularität

**Stand 2026-08-21.** Anlass: KRNL geht in den Pilotbetrieb, und später sollen
andere Entwickler daran arbeiten. Geprüft wurde die gesamte Codebasis —
66.000 Zeilen in 373 Dateien (src/app 24k, src/modules 17,5k, src/db 12k,
tests 8,6k) — auf Modularität, Wartbarkeit und Spaghetti-Risiko.

Dieses Dokument hält den Befund fest und trennt sauber: was behoben wurde,
was bewusst offen bleibt, und was zur Entscheidung ansteht.

---

## Kurzfassung

**Die Codebasis ist deutlich besser als ihr Umfang vermuten lässt.** Es gibt
kein Spaghetti. Was es gibt, sind mehrere „zweite Dialekte", die sich
verfestigt hätten — und einen Produktionsfehler, den niemand bemerkt hat,
weil kein Wächter danach gesucht hat.

Das Kernproblem war nicht die Struktur, sondern dass die **Wächter-Tests, auf
denen die ganze Architektur ruht, teilweise blind waren und in keiner CI
liefen**. Genau das ist behoben.

---

## Was gut ist (und so bleiben soll)

Diese Punkte sind der Grund, warum sich ein neuer Entwickler hier schnell
zurechtfindet. Sie sollten bei jedem Umbau erhalten bleiben:

- **Keine zirkulären Importe.** 254 Dateien, 886 Kanten, null Zyklen auf
  Dateiebene. `src/modules` importiert an keiner Stelle aus `src/app`.
- **Die Registry trägt.** 149 Aktionen, deren Vollständigkeit der Compiler
  erzwingt (`satisfies Record<AktionsName, AktionsFn>`). Eine Aktion ohne
  Ausführung bricht `tsc`, nicht den Klick. ~20 Zeilen Katalog + ~15 Zeilen
  Ausführung pro Aktion, konstant über alle 15 Bereiche — das Muster wächst
  kontrolliert.
- **Ein Skelett für alle Detailseiten.** Alle 18 `[id]/page.tsx` folgen
  demselben Aufbau: `requireArea → notFound → PageHeader → Cards →
  RecordComments`. Ohne Ausnahme.
- **Saubere Server/Client-Grenze.** Nur 7 von 124 App-Dateien sind
  Client-Komponenten. In keiner davon steht `process.env`, ein DB-Zugriff
  oder ein Auth-Import. Konfiguration wird als `boolean` durchgereicht, nie
  als Schlüssel.
- **Fachlogik liegt in der Datenbank.** `bom_explode()`,
  `purchase_order_total()`, `einkauf_freigabe_noetig()`, materialisierte
  Sichten. Die Seiten sind Formularmarkup, kein Rechenzentrum — deshalb
  lesen sich auch 611 Zeilen `einkauf/[id]/page.tsx` gut.
- **`globals.css` mit 1.589 Zeilen und praktisch keinen toten Regeln.**
  Token-System mit erklärenden Kommentaren, 30 gegliederte Abschnitte.
- **Der Prozess-Testharness** (`fixtures/` + `tests/prozesse/`) ist das
  stärkste Konstrukt im Repo: Er testet den Ablauf, wie der Benutzer ihn
  erlebt, über den echten Produktionspfad, und prüft nach jedem Schritt die
  Ledger-Invariante.
- **Das Kommentarwesen.** Begründend statt beschreibend, mit BUG-Nummern und
  Design-Entscheidungen im Code. Das ist selten und spart einem Neuen Tage.
- **`strict: true`, null `@ts-ignore`** im gesamten `src/`.

---

## Behoben

### 1. Produktionsfehler: Kommentare auf fünf Seiten kaputt

Die Detailseiten übergaben **15 Modelle** an `<RecordComments>`, die Registry
in `comments-action.ts` kannte **12**. Auf `/vorgaenge/[id]`,
`/finanzen/vertraege/[id]`, `/finanzen/darlehen/[id]`, `/personal/[id]` und
`/tickets/[id]` erschien das Kommentarfeld, jeder Absendeversuch scheiterte
mit „Kommentare sind für … nicht vorgesehen".

Ursache war strukturell: `model` war ein freier `string`. Jetzt ist es
`KommentarModell = keyof typeof MODELS` — **der Compiler meldet die nächste
Lücke, nicht der Benutzer.**

### 2. Der Registry-Wächter hatte ein blindes Auge

`tests/prozess-registry.test.ts` scannte nur Dateien namens `actions.ts`.
Server Actions, die inline in `page.tsx` stehen, waren unsichtbar. Dabei
meldete er grün und „NOCH_NICHT_MIGRIERT ist LEER".

Tatsächlich gehen **24 Server Actions am Torwächter vorbei**, 21 davon mit
direktem Schreib-SQL — im Widerspruch zur Regel aus AGENTS.md („ausgeführt
NUR über den Torwächter"). Sie sind nicht ungeschützt (jede prüft
`requireAdmin()`/`requireWrite()`), fehlen aber in Protokoll, Nutzungszähler
und Prozessbild.

Der Wächter erkennt jetzt beide Deklarationsformen, und die Umgehungen stehen
als begründete, **nur schrumpfende** Liste `UI_UMGEHUNGEN` im Test. Präzisiert:
Bei datei-weitem `'use server'` zählen nur exportierte Funktionen
(Next.js-Semantik); Anmeldung/Abmeldung sind Rahmen, keine Schuld.

### 3. Der Migrations-Wächter war nie scharf

Seine Musterliste kannte fünf Statements, aber weder `drop constraint` noch
`drop trigger`, `drop function`, `drop view` oder `alter column type`.
Ergebnis: Der `-- DESTRUKTIV:`-Marker kam in **keiner einzigen der 65
Migrationen** vor. Der Wächter lief seit seiner Einführung leer durch und
wirkte dabei grün.

Muster ergänzt. Die sechs Bestandsfälle stehen als Altlasten mit Begründung —
Migrationen sind über Prüfsummen unveränderlich, der Marker lässt sich nicht
nachtragen, ohne jede bestehende Instanz zu brechen. Zusätzlich deckt ein
Marker nicht mehr die ganze Datei, sondern nur noch eine destruktive Art.

### 4. Kein Linter, keine CI — die größte Lücke

Es gab **keinen Linter und keinen Formatter**, aber 25 wirkungslose
`eslint-disable`-Kommentare, die eine Prüfung vortäuschten. Und der einzige
CI-Workflow lief nur manuell oder auf `staging`: Registry-Abdeckung,
Migrations-Wächter, Doku-Wächter und Prozessvollständigkeit hingen an der
Disziplin des Einzelnen — an genau dem, was sie ersetzen sollten.

- **Biome** als einzige neue Dev-Abhängigkeit (eine Binary für Lint und
  Format; `next lint` gibt es in Next 16 nicht mehr).
- Der **Formatter ist bewusst aus** und nur als `npm run format` verfügbar.
  Ihn zu erzwingen hätte einen Diff über 311 Dateien erzeugt und jede
  Codearchäologie zerstört.
- Die Regelauswahl zielt auf echte Fehler. Abgeschaltet sind unter anderem
  `noNonNullAssertion` (212 Treffer — `!` wird bewusst genutzt) und
  `useTemplate`. **Ein Linter, der ab Tag 1 rot ist, wird ignoriert.**
- Gefunden und behoben: 7 tote Importe, 2 ungenutzte Variablen und ein
  `target="_blank"` ohne `rel="noopener"` (Reverse Tabnabbing).
- **`.github/workflows/check.yml`** führt Linter, Typprüfung, 312 Tests, 46
  Prozessläufe und den Build auf **jedem Push und jedem Pull Request** aus.

### 5. Der fehlende Navigations-Wächter

`befehle.ts` nennt sich selbst „Spiegel der Navigation (layout.tsx)", ohne
dass das je geprüft wurde. Der neue `tests/navigation.test.ts` fand sofort
zwei echte Drift-Fälle: `/fertigung/arbeitsplaetze` und `/einkauf/kurse`
standen im Menü, aber nicht im Befehlsfeld. Beide ergänzt.

### 6. Zahlformate: deutsches Komma überall

Es fehlte ein `pct()` in `format.ts`. Folge: `12.3 %` mit englischem Punkt
stand neben `12,5 %` mit Komma; in `produkte/[id]` standen deutsche Mengen
und englische Preise in derselben Tabellenzeile.

Dazu lag `new Date(x).toISOString().slice(0, 10)` **17× kopiert** herum, in
zwei Dateien sogar als privater lokaler Helfer — mitsamt einer Zeitzonenfalle:
`toISOString()` rechnet nach UTC und liefert in Mitteleuropa nach Mitternacht
**den Vortag**. Das betraf sowohl Eingabefelder als auch Datumsvergleiche
(„ist die Regel noch schlafen gelegt?").

Neu in `format.ts`: `pct()` und `isoDatum()`, beide getestet
(`tests/format.test.ts`), alle Fundstellen umgestellt.

### 7. SQL-Funktionen auffindbar gemacht

**31 Funktionen liegen in 2 bis 5 Fassungen vor** (`demodaten_loeschen` 5×,
`confirm_sales_order` 4×), rund 1.900 tote Zeilen — 15 % aller
Migrationszeilen. `grep confirm_sales_order` liefert vier Treffer, drei davon
tot, und die tote Fassung in `0014` ist 113 Zeilen lang und ausführlich
kommentiert. Ein neuer Entwickler ändert mit hoher Wahrscheinlichkeit die
falsche.

Neu: **`npm run funktion <name>`** zeigt die aktuelle Fassung mit
Datei:Zeile, markiert die überholten ausdrücklich als „nicht ändern!" und
holt die echte Definition aus der laufenden Datenbank. Ohne Argument
listet es alle mehrfach definierten Funktionen.

Die Migrationen selbst bleiben unangetastet — sie sind über Prüfsummen
unveränderlich, und das ist richtig so.

### 8. Testisolation: eine echte Race Condition

`tests/nummernkreise.test.ts` erwartete zwei aufeinanderfolgende
`next_sequence('delivery')`, während `lots.test.ts`, `versandregeln.test.ts`
und `bewertung.test.ts` **denselben Kreis parallel zogen**. node:test fährt
Testdateien nebenläufig, und `nextval` ist nicht transaktionsgebunden —
`withRollback` isoliert es also nicht. Der Test hätte jederzeit grundlos rot
werden können. Er nutzt jetzt eigene, prozessgebundene Kreise.

Außerdem fehlten in `tests/helpers.ts` das `prepare: false` und das
`transform: { undefined: null }` aus `src/db/client.ts` — die Tests liefen mit
anderer Treiber-Semantik als die Produktion. Angeglichen.

### 9. Einstiegsdoku, die in die Irre führte

- **`docs/architektur.md`** kannte `modules/prozesse` (9.000 Zeilen, das
  Herzstück) und `modules/ki` nicht und behauptete ausdrücklich, die
  Fachmodule bräuchten „keine eigene Zwischenschicht". Genau diese Schicht
  ist inzwischen die Registry. Für ein Projekt, dessen AGENTS.md sagt „Doku,
  die dem Code hinterherläuft, gilt als kaputt", war das der teuerste
  Widerspruch — und es ist die Datei, die die Landkarte einem Neuling als
  zweite empfiehlt. Jetzt korrigiert, mit einer Tabelle „Wo liegt die Logik
  eines Fachmoduls?" (Schreiben → Registry, Buchen → SQL, Lesen → Seiten).
- **`PLAN.md`** lag im Wurzelverzeichnis und trug noch den Titel
  „ERP-Eigenentwicklung (Odoo-Nachbau)" — der Stand vor dem
  Prozess-First-Umbau. Verschoben nach `docs/historie/plan-gruendung.md` mit
  Historisch-Vermerk; der Doku-Wächter prüfte nur `docs/` und hatte ihn nie
  gesehen.

---

## Bewusst offen

**Barrierefreiheit.** Die a11y-Regeln des Linters sind vorerst abgeschaltet.
Sie melden über 40 Befunde: fehlende `type="button"`, `<label>` ohne
zugeordnetes Feld, `autofocus`, klickbare `<div>` ohne Tastaturzugang. Das
ist ein eigenes Arbeitspaket — real, aber kein Wartbarkeitsproblem. Zum
Einschalten: `a11y.recommended` in `biome.json` auf `true`.

**Die 24 Torwächter-Umgehungen** sind sichtbar gemacht, aber nicht migriert
(siehe „Zur Entscheidung").

---

## Zur Entscheidung

Vier Punkte sind zu groß für eine Sofortmaßnahme. Aufwand und Nutzen:

| Punkt | Aufwand | Nutzen |
|---|---|---|
| **`ki/chat.tsx` zerlegen** — 1.121 Zeilen mit sechs Verantwortungen (Markdown-Renderer, SVG/CSV-Export, Diagrammkarte, zwei Vorschlagskarten, NDJSON-Stream-Parser, plus ein kompletter zweiter Bildschirm für den Buddy-Modus) | ~1 Tag, rein mechanisch | Die einzige Datei, vor der ein Neuzugang kapituliert, wird zu sieben Modulen. Zwei davon (Markdown-Renderer, Stream-Parser) sind reine Logik und werden dabei erstmals testbar. |
| **KI-Zweitregistry auflösen** — `ki/aktionen.ts` ist ein zweiter Aktionskatalog mit eigenem Rechtemodell neben der Registry; unterschieden wird an **einem Punkt im String** (`name.includes('.')`), an sechs Stellen von Hand | ~1–2 Tage | Der KI-Zweig umgeht heute `nurAdmin`, die Schritt-Rechte und den Nutzungszähler. 8 der 9 Aktionen haben bereits ein Registry-Gegenstück. |
| **Die 24 Umgehungen migrieren** — jetzt, da sie sichtbar sind | ~1–2 Tage | Das Architekturversprechen wird wieder wahr. `integrationen/page.tsx` schrumpft von 746 auf ~580 Zeilen. |
| **Sammelbecken zerlegen** — `einstellungen-ausfuehren.ts` (542 Z., vier Domänen inkl. Benutzerverwaltung, die zu `auth/` gehört) und `importShopifyOrder` (230 Zeilen, 6 Rückgabepunkte) | ~1 Tag | Bessere Kohäsion an den zwei Stellen, wo sie wirklich fehlt. |

**Nicht empfohlen:** eine Umstrukturierung nach Fachdomänen
(`modules/verkauf/`, `modules/einkauf/` …). Die heutige Trennung — Schreiben
über die Registry, Buchen in SQL, Lesen in Server Components — funktioniert
und ist getestet. Sie war nur nirgends aufgeschrieben; das ist jetzt in
`architektur.md` behoben, und zwar deutlich billiger als ein Umbau.

---

## Kleinere Befunde, nicht behoben

Aufgenommen, damit sie nicht verloren gehen:

- **Zwei CSS-Dialekte:** Der `finanzen/`-Teilbaum nutzt 49× inline
  `textAlign: 'right'`, wo der Rest des Repos 287× `className="num"`
  verwendet. Für einen Neuen der verwirrendste Befund — er sieht zwei
  Konventionen und weiß nicht, welche gilt.
- **Es fehlt eine `<Led>`-Komponente.** `LED_BY_TONE` ist in `ui.tsx` privat,
  deshalb gibt es ~40 handgeschriebene LED-Ternaries über 30 Dateien —
  darunter ein toter Zweig (`personal/[id]:142`: `e.active ? 'off' : 'off'`).
- **Doppelter Cast in zwei Detailseiten:** `(order as unknown) as {…}` in
  `verkauf/[id]:61` und `einkauf/[id]:122` deaktiviert jede Typprüfung. Bei
  einer Spaltenumbenennung schweigt der Compiler und die Seite rendert leere
  Felder.
- **Der Zähler-Block im ERP-Layout** ist eine 20-zeilige SQL mit 12
  korrelierten Unterabfragen — reine Fachlogik in der Präsentationsschicht,
  ausgeführt bei **jedem** Seitenaufruf. Gehört als Sicht in die Datenbank.
- **Wiederholte Stammdaten-Abfragen:** `select id, name from users where
  active` steht in 5 Dateien, `payment_terms` in 5, die Produktauswahl in 5+
  Varianten (mal mit `limit 500`, mal ohne). Ein `shared/auswahl.ts` würde
  14 Kopien auf 4 Funktionen reduzieren.
- **269 FormData-Ausdrücke** in den Registry-Katalogen
  (`String(fd.get('x') ?? '').trim() || undefined` und Verwandte).
  `shared/form.ts` existiert, bietet aber nur zwei Helfer.
- **Kein Advisory-Lock im Migrations-Runner.** Zwei parallele Deployments
  könnten dieselbe Migration gleichzeitig einspielen.
- **`scripts/migrate.ts` und `modules/auth` haben keine Tests** — der
  Migrations-Runner ist das gefährlichste Skript im Repo.

---

## Kennzahlen

| | vorher | nachher |
|---|---|---|
| Tests | 304 + 46 | **312 + 46** |
| Wächter mit blindem Fleck | 3 | **0** |
| Automatische Prüfung auf PR/Push | keine | **Linter + Typen + Tests + Build** |
| Linter | nicht vorhanden | Biome, grün |
| Kaputte Eingabefelder in Produktion | 5 | **0** |
