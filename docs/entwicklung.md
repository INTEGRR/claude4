# Entwicklung: die ersten Handgriffe

Diese Datei beantwortet die Fragen, die beim ersten Beitrag auftauchen. Das
WARUM steht in [architektur.md](architektur.md) und
[entscheidungen.md](entscheidungen.md), der fachliche Stand in
[prozesse.md](prozesse.md).

## Einrichten

```bash
npm install
npm run db:migrate          # Schema einspielen
npm run db:seed -- --demo   # Beispieldaten (optional, aber empfohlen)
npm run dev
```

Details und Fehlerbehebung: [lokal-starten.md](lokal-starten.md).

## Vor jedem Commit

```bash
npm run check   # Linter + Typprüfung + 312 Tests + 46 Prozessläufe (~1 Min)
```

Dasselbe läuft in der CI auf jedem Push und jedem Pull Request
(`.github/workflows/check.yml`). Wer das lokal ausführt, erlebt keine
Überraschung im Pull Request.

## Die drei Regeln, die wirklich zählen

1. **Jede Fachfunktion ist eine Aktion in der Registry**, ausgeführt über den
   Torwächter — nie eine freie Server Action. Ein Wächter-Test erzwingt das.
2. **Jeder Ablauf ist ein Prozess in der Datenbank**, kein Sonderweg im Code.
3. **Jede Entscheidung bekommt im selben Commit** einen Eintrag in
   [entscheidungen.md](entscheidungen.md), jedes Feature die passende
   Fachdoku.

Vollständig in [AGENTS.md](../AGENTS.md).

## Wie füge ich eine Aktion hinzu?

Drei Stellen, alle typgeprüft — vergisst man eine, bricht `tsc`:

1. **Katalog:** `src/modules/prozesse/registry/<bereich>.ts` — Name
   (`<bereich>.<verb_objekt>`), Label, zod-Schema, Rechte, `revalidate`.
   Diese Datei bleibt **DB-frei**; sie wird unter blankem Node geladen.
2. **Ausführung:** `src/modules/prozesse/registry/<bereich>-ausfuehren.ts` —
   hier läuft das SQL.
3. **Dispatch:** `src/modules/prozesse/ausfuehren.ts` — ein Eintrag.

Aufrufen aus der Oberfläche über einen Einzeiler in der `actions.ts` des
Bereichs:

```ts
export async function bestaetigen(id: string): Promise<ActionResult> {
  return serverAktion('verkauf.bestaetigen', { recordId: id })
}
```

## Wie schreibe ich eine Migration?

Neue Datei `src/db/migrations/00NN_thema.sql`, fortlaufend nummeriert.

- **Migrationen sind unveränderlich.** Der Runner prüft Prüfsummen; eine
  nachträgliche Änderung bricht jede bestehende Instanz. Korrekturen kommen
  als neue Migration.
- **Expand-Contract:** neue Struktur zuerst anlegen und befüllen, Altes erst
  Releases später wegräumen — nie beides im selben Deploy.
- Destruktive Statements (`drop`, `truncate`, `delete`, `alter column type`)
  brauchen eine Zeile `-- DESTRUKTIV: <warum gefahrlos>`, sonst wird die
  Suite rot.
- Neue Tabellen: prüfen, ob sie in die Behalten-Liste von
  `demodaten_loeschen()` gehören — was nicht daraufsteht, wird beim
  Daten-Neustart mitgelöscht.

## Wo ist die aktuelle Fassung einer SQL-Funktion?

```bash
npm run funktion confirm_sales_order   # aktuelle Fassung + DB-Definition
npm run funktion                       # alle mehrfach definierten
```

**Nicht `grep` benutzen.** Weil Migrationen unveränderlich sind, ist jede
Weiterentwicklung ein neues `create or replace` in einer neuen Datei — 31
Funktionen liegen in bis zu fünf Fassungen vor, und die alten sehen genauso
gültig aus. `grep confirm_sales_order` liefert vier Treffer, drei davon tot.

## Welche Wächter gibt es?

Sie sind der Grund, warum die Konventionen mitwachsen statt zu verrotten:

| Wächter | Erzwingt |
|---|---|
| `tests/prozess-registry.test.ts` | Jede Server Action läuft über die Registry — Ausnahmen nur als schrumpfende Liste |
| `tests/prozesse/vollstaendigkeit.test.ts` | Jede Aktion in einem Schritt, jeder Schrittverweis gültig, jeder Belegzustand abgebildet |
| `tests/migrationen.test.ts` | Destruktives SQL nur mit Begründung |
| `tests/doku.test.ts` | Jede Doku-Datei in der Landkarte, keine toten Links, Log-Format |
| `tests/navigation.test.ts` | Befehlsfeld und Navigation bleiben deckungsgleich |
| `tests/ki.test.ts` (Schema-Doku) | Jede Tabelle ist für die KI beschrieben oder begründet versteckt |
| `tests/daten-tuev.test.ts` | Die Invariantenprüfung findet echte Korruption |
| `tests/actions.test.ts` | Server Actions werfen nicht (Next schwärzt Fehler in Produktion) |
| `tests/formularfelder.test.ts` | `min` ist ein Vielfaches von `step` — sonst sperrt der Browser glatte Werte |
| `tests/prozesse/fakes.test.ts` (`after`) | Ein Test ohne Datenbank lässt keine Verbindung offen |

Neue Konvention, die immer mitwachsen muss? Dann gehört ein Wächter dazu.

### Wenn die Prozessläufe „hängen"

`npm run test:prozesse` startet je Testdatei einen eigenen Prozess und läuft
seriell (`--test-concurrency=1`). node:test gibt die Ausgabe einer Datei erst
aus, wenn sie FERTIG ist — bleibt etwas stecken, sieht man deshalb gar
nichts. Dafür gibt es `tests/prozesse/spur.ts`:

    HARNESS_SPUR=1 npm run test:prozesse   # lokal; in der CI immer an
    cat prozess-harness.log

Die Spur nennt Datei, Aufbauschritt und Prozessende. Endet eine Datei nicht,
schreibt der Wachhund alle 10 Sekunden die offenen Handles mit — ein
`TCPSocketWrap` heißt: irgendetwas hat eine Datenbankverbindung geöffnet und
nicht geschlossen. Genau das war der CI-Hänger (Entscheidungslog 2026-08-22).

## Wo liegt was?

- **Schreiben** → `modules/prozesse/registry/`
- **Buchen** → `db/migrations/*.sql`
- **Lesen** → `app/(erp)/<bereich>/**/page.tsx` (Server Components)
- **Wiederverwendbare UI** → `components/`
- **Formatierung** → `modules/shared/format.ts` (`qty`, `money`, `pct`,
  `date`, `isoDatum` — bitte nichts davon lokal nachbauen)

Der aktuelle Zustand der Codebasis samt offener Punkte:
[code-review.md](code-review.md).
