# 962-prozess-anfrage — Prozessdefinition „Anfrage (Muster-Vorgang)“

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse/anfrage`
- **Note:** 4 / 5
- **Zweck:** Prozessdefinition „Anfrage (Muster-Vorgang)“: Diagramm, Schritte mit Aktion/Belegzustand/Rollen, Laufzeit-Schalter, eigene Felder
- **Messwerte:** HTTP 200 · Ladezeit 829 ms · Seitenhöhe 2004 px · horizontaler Überlauf nein · Texte < 11 px: 69

![Prozessdefinition „Anfrage (Muster-Vorgang)“](../screenshots/962-prozess-anfrage.png)

## Was gut ist

- Einheitlicher Aufbau aller Prozessseiten
- Prozesstest-Status grün im Kopf
- Optionale Schritte einzeln abschaltbar

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **mittel** | Barrierefreiheit | Diagramm in Originalgröße unlesbar (Knotenschrift ~7 px, abgeschnittene Knotentitel), bei großen Abläufen winzig in einer 600-px-Fläche. | Diagramm auf Breite einpassen + Minimalschrift 11 px; Knotentitel umbrechen statt abschneiden. |
| **mittel** | Texte | Belegzustände als Codes in der Schritttabelle (z. B. draft, confirmed, under_repair) gemischt mit deutschen (geprueft, angeboten). | Anzeigenamen je Zustand, Code nur als Tooltip. |
| **niedrig** | Logik | Ein eigenes Feld ‚Budget (€)‘ ist definiert, erscheint aber in der Liste 121 ohne Währung/Format. | Feldtyp Geld formatiert ausgeben. |
| **niedrig** | Eingabe | Formular ‚Eigene Felder‘ mit Platzhaltern ‚liefertermin / Liefertermin / klein, mittel, groß‘, die wie Werte aussehen; Erklärtext erwähnt ‚Migration‘ und ‚zusatz.name‘. | Klarere Platzhalter, Erklärung ohne Technikbegriffe. |

[← zur Übersicht](../README.md)
