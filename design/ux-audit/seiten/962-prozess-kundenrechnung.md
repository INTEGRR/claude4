# 962-prozess-kundenrechnung — Prozessdefinition „Kundenrechnung“

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse/kundenrechnung`
- **Note:** 3 / 5
- **Zweck:** Prozessdefinition „Kundenrechnung“: Diagramm, Schritte mit Aktion/Belegzustand/Rollen, Laufzeit-Schalter, eigene Felder
- **Messwerte:** HTTP 200 · Ladezeit 777 ms · Seitenhöhe 1591 px · horizontaler Überlauf nein · Texte < 11 px: 41

![Prozessdefinition „Kundenrechnung“](../screenshots/962-prozess-kundenrechnung.png)

## Was gut ist

- Einheitlicher Aufbau aller Prozessseiten
- Prozesstest-Status grün im Kopf
- Optionale Schritte einzeln abschaltbar

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **mittel** | Status | Der Rechnungs-Probelauf (Modus test/scharf) ist im Prozess nicht sichtbar, obwohl er das Verhalten grundlegend ändert. | Modus als Schalter/Hinweis im Prozesskopf. |
| **mittel** | Barrierefreiheit | Diagramm in Originalgröße unlesbar (Knotenschrift ~7 px, abgeschnittene Knotentitel), bei großen Abläufen winzig in einer 600-px-Fläche. | Diagramm auf Breite einpassen + Minimalschrift 11 px; Knotentitel umbrechen statt abschneiden. |
| **mittel** | Texte | Belegzustände als Codes in der Schritttabelle (z. B. draft, confirmed, under_repair) gemischt mit deutschen (geprueft, angeboten). | Anzeigenamen je Zustand, Code nur als Tooltip. |
| **niedrig** | Eingabe | Formular ‚Eigene Felder‘ mit Platzhaltern ‚liefertermin / Liefertermin / klein, mittel, groß‘, die wie Werte aussehen; Erklärtext erwähnt ‚Migration‘ und ‚zusatz.name‘. | Klarere Platzhalter, Erklärung ohne Technikbegriffe. |

[← zur Übersicht](../README.md)
