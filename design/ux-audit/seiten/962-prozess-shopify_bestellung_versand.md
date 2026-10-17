# 962-prozess-shopify_bestellung_versand — Prozessdefinition „Lieferung & Versand“

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse/shopify_bestellung_versand`
- **Note:** 3 / 5
- **Zweck:** Prozessdefinition „Lieferung & Versand“: Diagramm, Schritte mit Aktion/Belegzustand/Rollen, Laufzeit-Schalter, eigene Felder
- **Messwerte:** HTTP 200 · Ladezeit 836 ms · Seitenhöhe 2449 px · horizontaler Überlauf nein · Texte < 11 px: 93

![Prozessdefinition „Lieferung & Versand“](../screenshots/962-prozess-shopify_bestellung_versand.png)

## Was gut ist

- Einheitlicher Aufbau aller Prozessseiten
- Prozesstest-Status grün im Kopf
- Optionale Schritte einzeln abschaltbar

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **mittel** | Barrierefreiheit | Version 8 mit 13 Schritten, Ereignissen, Klärfall und Dienst – unlesbar klein; mehrere optionale Wege ohne Legende. | Legende (Aktion/Ereignis/Dienst/optional) und Zoom. |
| **mittel** | Barrierefreiheit | Diagramm in Originalgröße unlesbar (Knotenschrift ~7 px, abgeschnittene Knotentitel), bei großen Abläufen winzig in einer 600-px-Fläche. | Diagramm auf Breite einpassen + Minimalschrift 11 px; Knotentitel umbrechen statt abschneiden. |
| **mittel** | Texte | Belegzustände als Codes in der Schritttabelle (z. B. draft, confirmed, under_repair) gemischt mit deutschen (geprueft, angeboten). | Anzeigenamen je Zustand, Code nur als Tooltip. |
| **niedrig** | Eingabe | Formular ‚Eigene Felder‘ mit Platzhaltern ‚liefertermin / Liefertermin / klein, mittel, groß‘, die wie Werte aussehen; Erklärtext erwähnt ‚Migration‘ und ‚zusatz.name‘. | Klarere Platzhalter, Erklärung ohne Technikbegriffe. |

[← zur Übersicht](../README.md)
