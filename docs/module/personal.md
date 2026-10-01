# Modul Personal

Odoo-Vorbilder: `hr.employee`, `hr.attendance`, `planning.slot`, `hr.leave`.

## Zweck

Wer arbeitet wann, wie lange — und was kostet das. Die Zeiterfassung ist dabei kein Selbstzweck: gebuchte Auftragszeit fließt über den Personalkostensatz direkt in die Herstellkosten eines Fertigungsauftrags (siehe [fertigung.md](fertigung.md)).

## Mitarbeiter (`employees`)

- Personalnummer aus dem Nummernkreis `employee` (MA0001), Name, optionales Benutzerkonto (`user_id`).
- **Ausweis-Barcode** — der einzige Weg, an der Stempeluhr ohne Tastatur auszukommen.
- Vertragsart (`full_time`, `part_time`, `mini_job`, `temp`, `apprentice`), Wochenstunden, Urlaubstage.
- **`hourly_cost`** ist der Vollkostensatz je Arbeitsstunde. Er wird bei jeder Zeitbuchung eingefroren; eine spätere Tariferhöhung verändert alte Buchungen nicht.
- Ein-/Austrittsdatum mit Prüfung (Austritt nie vor Eintritt).

## Zeiterfassung (`time_entries`)

Zwei Arten in einer Tabelle:

| `kind` | Bedeutung | Bezug |
|---|---|---|
| `attendance` | Kommen/Gehen an der Stempeluhr | — |
| `production` | Zeit auf einen Arbeitsgang | `mo_operation_id` |

- Je Mitarbeiter und Art höchstens **ein offener Eintrag** (partieller Unique-Index). Zweimal anmelden ist nicht möglich — sonst wären die Zeiten wertlos.
- `time_clock_toggle(employee)` ist die Stempeluhr: erster Aufruf meldet an, zweiter ab. Der Ausweis-Scan ruft genau das auf.
- `time_entry_stop(entry, pause)` schreibt die **Nettodauer** fest (Bruttozeit minus Pause) und bucht Auftragszeit zusätzlich auf `mo_operations.duration_real`.
- Nachträge (vergessener Ausweis) legt das Büro am Mitarbeiter an — sie sind an der fehlenden Uhrzeit nicht erkennbar, deshalb steht der Grund im Feld `note`.
- Sichten: `employees_present` (wer ist gerade da), `time_sheet` (Minuten und Kosten je Mitarbeiter, Tag und Art).

## Schichtplan (`shift_templates`, `shift_assignments`)

- Vorlagen mit Kürzel, Beginn, Ende und Pause. Seed: Frühschicht (06–14), Spätschicht (14–22), Tagschicht (08–17).
- Eine Zuweisung erzeugt `starts_at`/`ends_at` aus Vorlage + Tag in `Europe/Berlin`; endet die Schicht vor ihrem Beginn, läuft sie über Mitternacht.
- **Überschneidungen sind unmöglich**: ein Ausschluss-Constraint über `employee_id` und `tstzrange(starts_at, ends_at)` (Erweiterung `btree_gist`). Kein Anwendungscode kann das umgehen.
- Ein Trigger blockiert zusätzlich Schichten während einer **genehmigten Abwesenheit** — mit Namen und Zeitraum in der Meldung.
- UI: Wochenansicht (eine Zeile je Mitarbeiter, eine Spalte je Tag), Blättern über `?woche=JJJJ-MM-TT`.

## Abwesenheiten (`absences`)

- Arten: Urlaub, Krank, Schulung, Unbezahlt, Sonstiges. Zustände: `requested → approved | rejected`, dazu `cancel` für zurückgezogene Genehmigungen.
- Auch hier verhindert ein Ausschluss-Constraint überschneidende Anträge je Mitarbeiter — allerdings nur für `requested` und `approved`, damit ein abgelehnter Antrag den Zeitraum wieder freigibt.
- `absence_days(id)` zählt Arbeitstage (Mo–Fr); ein halber Tag zählt 0,5.
- `absence_approve` meldet im Verlauf, wenn im Zeitraum bereits Schichten geplant sind — es blockiert aber nicht: die Genehmigung ist die Entscheidung, der Plan wird danach angepasst.

## Querverweise (seit 2026-10-01)

Mitarbeiter (Name und Nummer) führen zur Akte `/personal/[id]` — auch an der
Stempeluhr, dort nur für Rollen mit Personalbereich. Auftragszeiten führen
zum Fertigungsauftrag (`/fertigung/[id]`), „abwesend"-Schilder zu den
Abwesenheiten, eine Kollision „n Schicht(en) geplant" und Schichten in der
Akte zur passenden Woche im Schichtplan (`?woche=`).

## Herstellkosten: die Klammer zur Fertigung

```
mo_operation_cost(Arbeitsgang) =
      Summe(gebuchte Minuten × Personalkostensatz)      -- aus time_entries
    + restliche Minuten × Stundensatz des Arbeitsplatzes
```

Damit gilt: wer seine Zeit bucht, wird mit **seinem** Satz gerechnet; wo nichts gebucht ist, greift der Satz des Arbeitsplatzes. `mo_labor_cost` summiert das über alle erledigten Arbeitsgänge, `mo_produce` schreibt es als Lohnanteil in den Wert des Fertigprodukts.

Die Fertigmeldung stempelt eine noch laufende Auftragszeit selbst ab — niemand lässt am Feierabend eine offene Uhr stehen und verfälscht damit die Kosten.

## Berechtigungen

Zwei getrennte Bereiche, weil zwei verschiedene Personenkreise gemeint sind:

| Bereich | Wer | Was |
|---|---|---|
| `zeiterfassung` | alle Rollen | Stempeluhr, Anwesenheitsliste, Tagesbuchungen |
| `personal` | admin, mitarbeiter (Büro) | Stammdaten inkl. **Kostensätze**, Schichtplan, Genehmigungen |

An der Stempeluhr darf jeder stehen; die Personalkosten sieht nur das Büro.

## Abnahmekriterien

1. Ausweis scannen meldet an, erneutes Scannen meldet ab; ein unbekannter Ausweis erzeugt eine verständliche Meldung.
2. Zweimal anmelden schlägt fehl; eine erfasste Pause wird von der Anwesenheit abgezogen.
3. Zwei überschneidende Schichten für dieselbe Person lassen sich nicht speichern; eine Schicht im genehmigten Urlaub ebenso wenig.
4. Ein abgelehnter Urlaubsantrag gibt den Zeitraum für einen neuen Antrag frei.
5. Wird ein Arbeitsgang mit Mitarbeiter gestartet, läuft die Zeiterfassung mit; die Lohnkosten des Auftrags rechnen dann mit dem Personalkostensatz, nicht mit dem des Arbeitsplatzes.
6. Ein Lagermitarbeiter sieht die Zeiterfassung, wird bei `/personal` aber auf die Übersicht zurückgeschickt.

## Aufgaben für Mitarbeiter (`aufgaben`, 0104)

Was nicht aus einem Beleg kommt, sondern aus dem Kopf: „feg mal hinten das
Lager durch", „bereite die Gehäuse für Montag vor". Bewusst klein und
**prozessfrei** wie die Wiedervorlagen — eine Aufgabe ist ein Zettel mit
Haken, kein Ablauf; `status` (`offen` | `erledigt` | `verworfen`) ist die
einzige Wahrheit (Entscheidungslog 2026-10-01, „Aufgaben für Mitarbeiter").

- **Felder:** Titel, Details, **Zuständig** = eine Person (`zustaendig_id`)
  *oder* ein Team (`rolle`: Lager, Fertigung, Büro — jeder mit dieser Haupt-
  oder Zusatzrolle), **Termin** = Tag plus optionale Uhrzeit (ohne Uhrzeit
  gilt das Tagesende; `faellig_um` rechnet in Berliner Ortszeit), geschätzte
  Dauer in Minuten, beim Abhaken eine Rückmeldung (`notiz`).
- **Wo sie erscheinen:** in der Übersicht als „Deine Aufgaben" (über den
  Systemsignalen, Überfälliges gelb), als Zähler am Menüpunkt „Aufgaben"
  (meine, heute oder früher fällig) und auf `/aufgaben` (Meine · Alle offenen ·
  Erledigt der letzten 14 Tage) mit dem Formular „Neue Aufgabe".
- **Aktionen** (Registry `aufgaben.*`, Bereich `aufgaben`, den jede Rolle hat):
  `aufgaben.anlegen` (KI/Sprechen), `aufgaben.erledigen` (KI/Sprechen, per ID
  oder Stichwort aus dem Titel der eigenen offenen Aufgaben),
  `aufgaben.verwerfen`.
- **Rechte** (`modules/aufgaben/rechte.ts`, dieselbe Regel für Knöpfe und
  Ausführung): abhaken dürfen der Zuständige, jedes Teammitglied, wer sie
  angelegt hat, und das Büro (Admin, Büro-Rolle); verwerfen nur Anleger und
  Büro. Anlegen darf jeder — auch ein Lagerist für den Kollegen.
- **Sprechen:** Zuständig und Termin kommen als gesprochener Text und werden
  in der Ausführung aufgelöst (`modules/aufgaben/termin.ts`): „Tino",
  „Tino Lagerfeld", Benutzername, Nachname; „das Lager", „Lagerteam",
  „Produktion"; „mich". Termin „heute", „morgen", „übermorgen", Wochentag
  (heute eingeschlossen), „24.12.", ISO-Datum; Uhrzeit „15", „15 Uhr",
  „15:30". Mehrdeutige Namen werden abgewiesen statt geraten; ein
  Mitarbeiter ohne Benutzerkonto bekommt einen Klartext-Hinweis (ohne
  Anmeldung keine Übersicht). Wie jeder Schreibwunsch wird die Aufgabe im
  Gespräch nur notiert und nach der Sichtprüfung auf `/sprechen` angelegt.
- **Bewusst noch nicht:** wiederkehrende Aufgaben, Verschieben/Umhängen
  (verwerfen und neu anlegen), Bezug zu einem Beleg, Benachrichtigung per
  Telegram.

