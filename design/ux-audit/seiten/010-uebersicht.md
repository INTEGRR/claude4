# 010-uebersicht — Übersicht

- **Bereich:** Kopf & Rahmen
- **Route:** `/`
- **Note:** 3 / 5
- **Zweck:** Startseite nach dem Login: Begrüßung, Eingabefeld „Was möchtest du tun?“, Kacheln „Heute anstehend“.
- **Messwerte:** HTTP 200 · Ladezeit 3448 ms · Seitenhöhe 900 px · horizontaler Überlauf nein · Texte < 11 px: 14

![Übersicht](../screenshots/010-uebersicht.png)

## Was gut ist

- Ein Einstieg statt Menülabyrinth: Eingabefeld für Aktion, Beleg oder Frage.
- Kacheln mit Farbpunkt und großer Zahl sind auf einen Blick erfassbar.

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **hoch** | Logik | Alle Zahlen stehen in derselben Warnfarbe (Orange-Rot), egal ob „Deine Aufgaben 7“, „Versandbereit 1“ oder „Unterdeckung 175.162 €“. Dringlichkeit ist nicht unterscheidbar; die Farbpunkte (lila/orange/braun) erklären sich nicht. | Zahlenfarbe nach Zustand: neutral (normal), Warnung (überfällig), Gefahr (kritisch). Farbpunkte entweder mit Legende oder weglassen. |
| **hoch** | Daten | „Fertigungsaufträge fällig (bis heute) 271“ ist bei 308 Aufträgen keine handlungsrelevante Zahl — der Nutzer sieht ein Dauerrauschen. | Nur überfällige oder heute startbare (Material da) zählen; Rest als Nebenzahl. |
| **mittel** | Navigation | Kacheln sind nicht als klickbar erkennbar (kein Pfeil, kein Hover-Hinweis im Ruhezustand). | Pfeil/„öffnen“ in der Kachelecke, Hover-Hebung, Cursor. |
| **mittel** | Layout | Zwei Eingabefelder mit identischem Platzhalter („Was möchtest du tun?“) — eines auf der Seite, eines im Befehlsfeld (Strg+K) — dazu im Kopf ein drittes Feld „Barcode scannen oder suchen“. Drei Einstiege für fast dasselbe. | Ein Eingabekonzept: Kopf-Feld = Scannen/Suchen/Befehl, Seitenfeld entfällt oder wird zum Fokus des Kopf-Felds. |
| **mittel** | Typografie | Kachel-Titel in Mono-Versalien mit Sperrung, zweizeilig umbrechend („Reparaturen fertig zum Rückversand“) — lang und schwer lesbar. | Satzschreibung, 13 px, max. eine Zeile; Detail als Untertitel. |
| **niedrig** | Typografie | Fußzeile „Umsatz laufender Monat 385 , 73 € netto“ hat Leerzeichen vor dem Komma (Mono-Zahlformat). | Zahlformat ohne Leerzeichen: 385,73 €. |
| **niedrig** | Konsistenz | „Unterdeckung im Finanzplan“ ist eine Finanzkennzahl zwischen operativen Aufgaben — und für Rollen ohne Finanzzugriff irrelevant. | Kacheln nach Rolle/Bereich gruppieren (Heute tun · Warten · Finanzen). |

[← zur Übersicht](../README.md)
