# 962-prozess-verkauf — Prozessdefinition „Verkauf (manuell)“

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse/verkauf`
- **Note:** 3 / 5
- **Zweck:** Prozessdefinition „Verkauf (manuell)“: Diagramm, Schritte mit Aktion/Belegzustand/Rollen, Laufzeit-Schalter, eigene Felder
- **Messwerte:** HTTP 200 · Ladezeit 817 ms · Seitenhöhe 2069 px · horizontaler Überlauf nein · Texte < 11 px: 63

![Prozessdefinition „Verkauf (manuell)“](../screenshots/962-prozess-verkauf.png)

## Was gut ist

- Einheitlicher Aufbau aller Prozessseiten
- Prozesstest-Status grün im Kopf
- Optionale Schritte einzeln abschaltbar

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **mittel** | Schritte | Endknoten heißt ‚Bestätigt‘ – der Verkauf endet aus Prozesssicht mit der Bestätigung; Lieferung/Rechnung sind Teilprozesse, die Rechnung fehlt als Schritt. | Kundenrechnung als Teilprozess anhängen, Ende ‚Abgerechnet‘. |
| **mittel** | Barrierefreiheit | Diagramm in Originalgröße unlesbar (Knotenschrift ~7 px, abgeschnittene Knotentitel), bei großen Abläufen winzig in einer 600-px-Fläche. | Diagramm auf Breite einpassen + Minimalschrift 11 px; Knotentitel umbrechen statt abschneiden. |
| **mittel** | Texte | Belegzustände als Codes in der Schritttabelle (z. B. draft, confirmed, under_repair) gemischt mit deutschen (geprueft, angeboten). | Anzeigenamen je Zustand, Code nur als Tooltip. |
| **niedrig** | Eingabe | Formular ‚Eigene Felder‘ mit Platzhaltern ‚liefertermin / Liefertermin / klein, mittel, groß‘, die wie Werte aussehen; Erklärtext erwähnt ‚Migration‘ und ‚zusatz.name‘. | Klarere Platzhalter, Erklärung ohne Technikbegriffe. |

[← zur Übersicht](../README.md)
