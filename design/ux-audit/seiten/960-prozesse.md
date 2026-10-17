# 960-prozesse — Prozesse

- **Bereich:** Stammdaten & System
- **Route:** `/prozesse`
- **Note:** 2 / 5
- **Zweck:** Repository aller registrierten Aktionen (308) und Einstieg in Werkstatt/Abläufe/Dienste
- **Messwerte:** HTTP 200 · Ladezeit 932 ms · Seitenhöhe 20254 px · horizontaler Überlauf nein · Texte < 11 px: 628

![Prozesse](../screenshots/960-prozesse.png)

## Was gut ist

- Vollständige Transparenz: Name, Knopftext, Bereich, Beleg, Statusübergang
- Reiter Werkstatt · Abläufe · Aktionen · Dienste & Ereignisse

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **hoch** | Leistung | Alle 308 Aktionen untereinander auf einer Seite (20.254 px), ohne Suche, Filter nach Bereich oder Gruppierung; viele Zeilen ungleichmäßig hoch (leere Riesenzeilen). | Gruppierung nach Bereich (einklappbar), Suchfeld, feste Zeilenhöhe. |
| **mittel** | Navigation | Standardansicht ist die Entwickler-Liste (Aktionen), nicht die Abläufe – für Betreiber ist ‚Abläufe‘ der sinnvolle Einstieg. | Standardreiter ‚Abläufe‘; Aktionen als Referenz. |
| **mittel** | Konsistenz | Reiter ‚Werkstatt‘ violett hervorgehoben. Laut Designsystem (globals.css) ist Violett der seltene Entscheidungsakzent (Freigaben, Befugnis-Schritte, KI-Vorschläge). Für einen Navigationsreiter ist das Bedeutungsmissbrauch; Reiter sollten einheitlich aussehen. | Reiter-Komponente einheitlich. |
| **niedrig** | Texte | Statusübergänge mit Codes (draft/sent/purchase → cancel). | Deutsche Zustandsnamen. |

[← zur Übersicht](../README.md)
