# 962-prozess-bug_ticket — Prozessdefinition „Fehlerticket“

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse/bug_ticket`
- **Note:** 4 / 5
- **Zweck:** Prozessdefinition „Fehlerticket“: Diagramm, Schritte mit Aktion/Belegzustand/Rollen, Laufzeit-Schalter, eigene Felder
- **Messwerte:** HTTP 200 · Ladezeit 818 ms · Seitenhöhe 1658 px · horizontaler Überlauf nein · Texte < 11 px: 46

![Prozessdefinition „Fehlerticket“](../screenshots/962-prozess-bug_ticket.png)

## Was gut ist

- Einheitlicher Aufbau aller Prozessseiten
- Prozesstest-Status grün im Kopf
- Optionale Schritte einzeln abschaltbar

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **mittel** | Barrierefreiheit | Diagramm in Originalgröße unlesbar (Knotenschrift ~7 px, abgeschnittene Knotentitel), bei großen Abläufen winzig in einer 600-px-Fläche. | Diagramm auf Breite einpassen + Minimalschrift 11 px; Knotentitel umbrechen statt abschneiden. |
| **mittel** | Texte | Belegzustände als Codes in der Schritttabelle (z. B. draft, confirmed, under_repair) gemischt mit deutschen (geprueft, angeboten). | Anzeigenamen je Zustand, Code nur als Tooltip. |
| **niedrig** | Konsistenz | Kein ‚Prozess abschalten‘ (richtig, Pflichtprozess) – aber ohne Erklärung, warum er fehlt. | Hinweis ‚Systemprozess, nicht abschaltbar‘. |
| **niedrig** | Eingabe | Formular ‚Eigene Felder‘ mit Platzhaltern ‚liefertermin / Liefertermin / klein, mittel, groß‘, die wie Werte aussehen; Erklärtext erwähnt ‚Migration‘ und ‚zusatz.name‘. | Klarere Platzhalter, Erklärung ohne Technikbegriffe. |

[← zur Übersicht](../README.md)
