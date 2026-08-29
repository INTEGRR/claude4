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
Signaltöne (WebAudio) und Farbblitze. Ohne Scanner gibt es im
Ruhezustand ein sichtbares Feld zum Eintippen der Belegnummer — nach dem
Öffnen springt der Fokus zurück ans Scanfeld. Das Scanfeld holt sich den
Fokus nur zurück, wenn er ins Leere ging: sichtbare Eingabefelder
(Nummer, Fertigmenge) und Knöpfe bleiben normal bedienbar (gleiches
Muster am Packtisch, docs/module/versand.md).

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
  Kappung bei 500 Zeilen (`src/modules/ki/sql-tool.ts`). Zusätzlich kappt
  `ergebnisFuerModell()` nach **Größe** (30.000 Zeichen ≈ 8.000 Tokens):
  breite Ergebnisse werden zeilenweise gekürzt, mit Hinweis ans Modell,
  zu aggregieren — sonst hängt ein Riesenergebnis in jeder Folgerunde
  erneut im Kontext.

### Kosten

Der Agent nutzt **Prompt-Caching** (`cache_control: ephemeral`, zwei
Anker in `agent.ts`): einen festen auf dem Systemprompt (deckt als Präfix
auch die Werkzeug-Definitionen ab) und einen wandernden auf der jeweils
letzten Nachricht. Jede Folgerunde liest Schema-Doku, Verlauf und alle
bisherigen SQL-Ergebnisse zum Cache-Lesepreis (10 % des Eingabepreises)
statt voll neu — bei bis zu 15 Runden je Frage der größte Kostenhebel.
Interview und Prozess-Aufnahme cachen ihren Systemprompt genauso.

**Modellwahl je Ebene ist Betreiber-Einstellung** (Einstellungen →
„KI-Modelle", Registry-Aktion `einstellungen.ki_modelle_setzen`,
settings-Schlüssel `ki_modelle`): Auswertungen/SQL, Prozess-Aufnahme &
-Entwurf, Onboarding-Interview und die schnelle Datenfrage lassen sich
getrennt auf Opus 5, Sonnet 5 oder Haiku 4.5 stellen — nur Katalog-
Modelle aus `src/modules/ki/modelle.ts` sind wählbar (Tippfehler-Schutz).
Auflösungsreihenfolge: Einstellung → Env-Notausgang (`ANTHROPIC_MODEL`,
`AUFNAHME_MODELL`, `DATENFRAGE_MODELL`) → Standard der Ebene.
Entscheidungslog 2026-08-25.

**2. `diagramm` — zeigen.** Der Agent liefert eine schmale Beschreibung
  (`src/modules/ki/diagramm.ts`): Art (`saeulen`, `balken`, `anteile`), Titel,
  Einheit und die Werte. Gezeichnet wird mit denselben Komponenten wie die
  festen Auswertungen — der Agent bestimmt *was* gezeigt wird, nicht *wie*.
  Die Beschreibung wird serverseitig geprüft: passen die Werte nicht zu den
  Kategorien, bekommt das Modell die Meldung zurück und kann korrigieren.

**3. `aktion_vorschlagen` — anlegen, aber nur mit Bestätigung.** Der Agent
  schreibt **kein** SQL. Er wählt eine Registry-Aktion mit `ki: true`
  (Werkzeugkatalog aus `kiKatalog()`, gebaut in `agent.ts` — inklusive
  Feldliste je Aktion) und füllt deren Felder; der Vorschlag
  erscheint im Chat als Karte mit Zusammenfassung, Begründung — und den
  Feldern direkt als **editierbares Formular** (kein rohes JSON; Objektlisten
  wie Attributwerte als Tabelle mit editierbaren Zellen). Zusätzlich lässt
  die Zuruf-Zeile („Kürzel für Grün auf GN") die KI den Feldsatz über
  `/api/ki/aktion/aendern` neu schreiben — eine kurze, isolierte Runde ohne
  Datenbankzugriff, deren Ergebnis wieder gegen das Aktionsschema geprüft
  wird.

  Viele gleichartige Datensätze (etwa ein Meldebestand je Produkt) schlägt
  der Agent in **einer** Antwort vor — je Datensatz ein Werkzeugaufruf. Der
  Chat gruppiert aufeinanderfolgende Vorschläge derselben Aktion mit flachem
  Feldsatz zu einer **Sammelkarte** (`src/modules/ki/vorschlag-gruppen.ts`):
  eine Tabelle, je Vorschlag eine Zeile, Zellen editierbar, einzelne Zeilen
  verwerfbar, „Alle anlegen" bestätigt den Rest gemeinsam. Ausgeführt wird
  trotzdem je Zeile einzeln über `/api/ki/aktion`, damit jede Zeile ihr
  eigenes Ergebnis bekommt — ein Fehler in Zeile 3 hält Zeile 4 nicht auf.
  Beleg-IDs (`record_id`) zeigt die Tabelle nur an, editierbar sind sie
  nicht — die hat der Agent nachgeschlagen. Erst der Klick auf „Anlegen"
  (bzw. „Alle anlegen") schickt den Vorschlag an `/api/ki/aktion`, die den
  **kompletten Torwächter-Weg** läuft (`bestaetigteAktionAusfuehren` →
  `aktionAusfuehrenGeprueft`): Schema, Rechte inkl. `nurAdmin`,
  Beleg-Existenz, Ausführung, `log_event` und Nutzungszähler — exakt
  dieselbe Prüfung wie bei Maske und Prozesstest. Seit der Auflösung des
  KI-Anlage-Katalogs (Entscheidungslog 2026-08-27) gibt es **keinen
  zweiten Schreibweg** mehr; ein Wächter-Test verbietet Schreib-SQL in
  `src/modules/ki/**` (Allowlist: `produkt-anlegen.ts` als Fachlogik der
  Registry-Aktion, `sprechen-werkzeuge.ts` für die Sprachprotokolle).

  Verweisfelder der Anlage-Aktionen sind **Kennungsfelder**: sie nehmen
  neben der UUID auch SKU, Barcode, Referenz oder Namen
  (`registry/aufloesen.ts`) — exakte Treffer gewinnen, mehrdeutige Namen
  werden abgewiesen statt zufällig aufgelöst. Die Kombi-Aktionen
  `verkauf.auftrag_mit_positionen` und `einkauf.bestellung_mit_positionen`
  legen Kopf + Zeilen in einem Zug an und komponieren dabei die
  bestehenden Aktionen (Lieferadresse, Listen-/Staffelpreis, Steuersatz
  inklusive). Belege entstehen im Entwurf — das Bestätigen bleibt ein
  bewusster Schritt in der Oberfläche. Jede freie `ki`-Aktion braucht
  eine `zusammenfassung` (Wächter in `schema-felder.test.ts`), sonst
  degradiert der Bestätigungstext zum Label.

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
