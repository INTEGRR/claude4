<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# KRNL-Projektregeln

## Prozess First (der Architektur-Grundsatz)

KRNL orientiert sich an **Prozessen statt Masken**: Prozesse sind Daten
(designbar, je Firma anpassbar), Knöpfe sind registrierte Aktionen. Für jede
Änderung gilt:

- **Neue Fachfunktion = Aktion in der Registry**
  (src/modules/prozesse/registry/), ausgeführt NUR über den Torwächter
  (`aktionAusfuehrenGeprueft`) — nie eine freie Server Action. Der
  Abdeckungs-Wächter (tests/prozess-registry.test.ts) macht die Suite sonst
  rot; Ausnahmen sind geschlossene, begründete Listen.
- **Neuer Ablauf = Prozess(-Version) in der Datenbank** — Masken entstehen
  aus Schritten, Navigation und Dashboard sind Projektionen der aktiven
  Prozesse (Chamäleon). Keine hartkodierten Sonderwege.
- **Der Belegstatus bleibt die einzige Zustandswahrheit** — Prozessschritte
  mappen auf Belegstatus, es gibt kein zweites Token-Modell.
- Einstieg: [docs/prozesse.md](docs/prozesse.md); Begründung:
  Entscheidungslog 2026-08-16.

## Doku-Pflicht (nicht optional)

Einstieg in die gesamte Dokumentation: [docs/README.md](docs/README.md) —
die Landkarte, in der jede Doku-Datei verlinkt ist.

- **Jede Entscheidung** (Architektur, Produkt, Betrieb) bekommt **im selben
  Commit** einen datierten Eintrag in
  [docs/entscheidungen.md](docs/entscheidungen.md) (Format
  `## JJJJ-MM-TT — Titel`; nie umschreiben, Revisionen sind neue Einträge).
- **Jedes Feature** aktualisiert die betroffene Fachdoku im selben Commit —
  laufende Ausbauten in [docs/prozesse.md](docs/prozesse.md), Gründungs-
  module unter docs/module/. Doku, die dem Code hinterherläuft, gilt als
  kaputt.
- **Neue Doku-Dateien** werden in [docs/README.md](docs/README.md)
  verlinkt. Der Doku-Wächter (`tests/doku.test.ts`) erzwingt Index-
  Vollständigkeit, gültige Links und das Eintragsformat des
  Entscheidungslogs.
- Das stets aktuelle Tabelleninventar ist `src/modules/ki/schema-doku.ts`
  (ein Wächter-Test gleicht es gegen die echte Datenbank ab) —
  docs/datenmodell.md beschreibt das Gründungsmodell.

## Konventionen erzwingen, nicht erinnern

Jede Konvention, die „immer mitwachsen muss", bekommt einen Wächter-Test
(Muster: Registry-Abdeckung, KI-Schema-Doku, Migrations-Wächter,
Doku-Index). Destruktive Migrationen brauchen eine
`-- DESTRUKTIV: <Begründung>`-Zeile; Regel Expand-Contract — Altes erst
Releases später wegräumen. Details und alle bestehenden Entscheidungen:
[docs/entscheidungen.md](docs/entscheidungen.md).
