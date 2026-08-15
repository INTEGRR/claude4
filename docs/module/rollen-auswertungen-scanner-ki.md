# Rollen, Kommentare, Auswertungen, Scanner, KI-Analyse

Querschnittsfunktionen, die im Ausbau nach dem ersten Praxistest dazukamen.

## Rollen & Benutzer

Vier Rollen (`user_role`-Enum, Matrix in `src/modules/auth/permissions.ts`):

| Rolle | Sichtbar & bearbeitbar | Nur lesend |
|---|---|---|
| `admin` | alles | — |
| `mitarbeiter` (Büro) | alles außer Integrationen/Einstellungen | — |
| `lager` | Lager, Versand, Reparatur, Scanner | Produkte |
| `fertigung` | Fertigung (inkl. Stücklisten), Reparatur, Scanner | Produkte |

Durchsetzung an drei Stellen:

- **Seiten**: `requireArea('<bereich>')` leitet Unbefugte zur Übersicht um
  (mit Hinweis `?verweigert=`).
- **Server Actions**: `requireWrite('<bereich>')` wirft eine Fehlermeldung.
- **Sidebar/Dashboard**: zeigen nur erlaubte Bereiche (`canAccess`).

Benutzerverwaltung unter **Einstellungen → Benutzer** (nur Admin): anlegen,
Rolle ändern, deaktivieren (beendet laufende Sitzungen), Passwort
zurücksetzen. Der letzte aktive Administrator lässt sich weder herabstufen
noch deaktivieren.

## Kommentare an jedem Datensatz

Jede Detailseite (Verkauf, Einkauf, Rechnung, Fertigung, Stückliste,
Transfer, Reparatur, Produkt, Variante, Kontakt) trägt eine Karte
„Verlauf & Kommentare": derselbe `audit_log`, der auch Statuswechsel
protokolliert, nimmt Notizen (`kind='note'`) auf. Gemeinsame Action
`src/app/(erp)/comments-action.ts` mit Modell-Whitelist und
Existenzprüfung; kommentieren darf, wer den Bereich sehen kann.

## Auswertungen (`/auswertungen`)

Zeitraumfilter (Standard: letzte 6 Monate), vier Karten — reine
SQL-Aggregationen über das Bewegungs-Ledger, keine Chart-Bibliothek:

- **Inventarwert**: Bestand × Einstandskosten je Variante. Produkte ohne
  gepflegte Kosten werden über die Summe der Stücklisten-Komponentenkosten
  ihrer Variante bewertet (`bom_components_for_variant`).
- **Produktion je Endvariante**: `stock_moves` mit `reference='Fertigmeldung'`,
  `state='done'`, gruppiert nach Variante und Monat.
- **Verbaute Komponenten**: dieselbe Quelle mit
  `reference='Komponentenverbrauch'` — beantwortet „wie oft wurde weißes
  Gehäuse verbaut" (Komponenten sind eigene Varianten).
- **Abverkauf (Sell-Through)**: je verkaufter Variante
  verkauft ÷ (verkauft + Bestand) über bestätigte Aufträge im Zeitraum,
  mit Monatsverlauf.

## Scanner-Arbeitsplatz (`/scanner`)

Für Barcodescanner im Tastatur-Modus (Keyboard-Wedge): ein unsichtbares,
dauerfokussiertes Eingabefeld nimmt Scans entgegen; Rückmeldung über
Signaltöne (WebAudio) und Farbblitze.

Ablauf:

1. **Beleg scannen** — Transfer (`WH/…`) oder Fertigungsauftrag (`MO/…`).
   Rollenfilter: Lager nur Transfers, Fertigung nur MOs.
2. **Positionen abhaken** — jeder Scan eines Produkt-Barcodes/SKU zählt die
   passende Zeile hoch; volle Zeilen werden grün, Über-Scans warnen.
   Manuelle ±-Knöpfe als Ausweichweg.
3. **Doppelscan** des Belegs öffnet die Bestätigen-Ansicht, ein dritter
   Scan (oder der Knopf) bucht über die vorhandenen Server Actions
   (`picking_validate` / `mo_produce`) — keine eigene Buchungslogik.

Buchungsregeln:

- **Transfer**: gescannte Mengen = erledigte Mengen, Rest wandert in den
  Rückstand. Ganz ohne Positionsscans werden die Sollmengen gebucht
  (schneller Komplett-Abschluss).
- **Fertigungsauftrag**: Scans sind eine Checkliste — gebucht werden
  standardmäßig die **Sollmengen**. Abweichenden Verbrauch bucht nur, wer
  in der Bestätigen-Ansicht ausdrücklich auf „nur gescannte Mengen"
  umstellt. (Sonst entstünden Fertigprodukte ohne Materialverbrauch.)

## KI-Analyse (`/ki`)

Chat-Agent (Claude, `@anthropic-ai/sdk`) für Ad-hoc-Auswertungen, Listen
und Übersichten „auf Zuruf" — ergänzend zu den festen Auswertungen.

Drei Werkzeuge:

**1. `sql_abfrage` — lesen.** Läuft in einer **Read-only-Transaktion**
  (Schreiben auf Datenbankebene ausgeschlossen) mit 10-Sekunden-Timeout und
  Kappung bei 500 Zeilen (`src/modules/ki/sql-tool.ts`).

**2. `diagramm` — zeigen.** Der Agent liefert eine schmale Beschreibung
  (`src/modules/ki/diagramm.ts`): Art (`saeulen`, `balken`, `anteile`), Titel,
  Einheit und die Werte. Gezeichnet wird mit denselben Komponenten wie die
  festen Auswertungen — der Agent bestimmt *was* gezeigt wird, nicht *wie*.
  Die Beschreibung wird serverseitig geprüft: passen die Werte nicht zu den
  Kategorien, bekommt das Modell die Meldung zurück und kann korrigieren.

**3. `aktion_vorschlagen` — anlegen, aber nur mit Bestätigung.** Der Agent
  schreibt **kein** SQL. Er wählt eine Aktion aus einem festen Katalog
  (`src/modules/ki/aktionen.ts`) und füllt deren Felder; der Vorschlag
  erscheint im Chat als Karte mit Zusammenfassung, Begründung und allen
  Feldern im Klartext. Vor dem Anlegen lässt sich der Vorschlag korrigieren —
  auf zwei Wegen: „Vor dem Anlegen bearbeiten" macht jedes Feld editierbar
  (Objektlisten wie Attributwerte als Tabelle mit editierbaren Zellen), und
  die Zuruf-Zeile („Kürzel für Grün auf GN") lässt die KI den Feldsatz über
  `/api/ki/aktion/aendern` neu schreiben — eine kurze, isolierte Runde ohne
  Datenbankzugriff, deren Ergebnis wieder gegen das Aktionsschema geprüft
  wird. Erst der Klick auf „Anlegen" schickt den Vorschlag an
  `/api/ki/aktion`, wo **erneut** geprüft wird:

  - Ist die Aktion im Katalog? (sonst 400 mit der Liste der erlaubten)
  - Sind die Felder gültig? (Zod-Schema, Meldung im Klartext)
  - Darf die Rolle im Zielbereich schreiben? (sonst 403)

  Ausgeführt wird über dieselben Wege wie in der Oberfläche — Nummernkreise
  über `next_sequence`, Fertigungsaufträge über `create_manufacturing_order`.
  Kein Sonderweg für die KI, sonst gälten für ihre Datensätze andere Regeln.

  Der Katalog ist bewusst abschließend und legt nur an, nie ändern oder
  löschen: Kontakt, Verkaufsauftrag (Entwurf), Bestellung (Entwurf),
  Fertigungsauftrag, **Produkt** (samt Attributen und kompletter
  Variantenmatrix inkl. SKU-Vergabe aus Präfix + Wertekürzeln; vorhandene
  Attribute werden über den Namen wiederverwendet, die Matrix ist auf
  200 Varianten gedeckelt), Meldebestand, Arbeitsplatz, Mitarbeiter, Notiz.
  Belege entstehen im Entwurf — das Bestätigen bleibt ein bewusster Schritt
  in der Oberfläche.

  Katalog und Ausführung liegen in getrennten Dateien: der Agent lädt nur den
  Katalog, die Datenbankseite hängt allein an der bestätigten Route.

- Sperrliste hält Geheimnisse fern: `users`, `sessions`, `settings`,
  `integration_jobs`, `password_hash` sind tabu.
- Jede Frage, jede SQL-Abfrage, jeder Vorschlag und jede ausgeführte Aktion
  landet im `audit_log` (Modell `ki`); angelegte Belege tragen zusätzlich eine
  Notiz „Über die KI-Analyse angelegt" in ihrem eigenen Verlauf.
- Antworten streamen; Markdown-Tabellen werden gerendert und lassen sich
  als CSV herunterladen.
- Konfiguration: `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`, Standard
  `claude-opus-5`). Ohne Schlüssel zeigt die Seite einen Hinweis — alle
  anderen Module laufen unabhängig davon.
- Zugriff auf die Seite: nur `admin` und `mitarbeiter`. Für schreibende
  Aktionen zählt zusätzlich der Zielbereich — ein Fertigungsmitarbeiter kann
  sich auch über die KI keinen Kunden anlegen.
