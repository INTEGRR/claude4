# 300-fertigung — Fertigungsaufträge

- **Bereich:** Fertigung
- **Route:** `/fertigung`
- **Note:** 2 / 5
- **Zweck:** Alle Fertigungsaufträge, Sammeldruck/Start, neuer Auftrag
- **Messwerte:** HTTP 200 · Ladezeit 1004 ms · Seitenhöhe 11976 px · horizontaler Überlauf nein · Texte < 11 px: 424

![Fertigungsaufträge](../screenshots/300-fertigung.png)

## Was gut ist

- Materialstatus je Auftrag (vollständig / n fehlt) farbig
- Mehrfachauswahl ‚Alle 23 startbaren‘ + Zweischritt ‚Zettel drucken → Druck ok — Produktion starten‘
- Verknüpfung Auftrag + Lieferung je Zeile

## Befunde

| Schwere | Kategorie | Befund | Vorschlag |
|---|---|---|---|
| **kritisch** | Daten | Liste ist hart auf 200 Zeilen begrenzt (Abfrage limit 200), ohne Hinweis: 271 offene + 45 erledigte Aufträge existieren, ‚Alle‘ zeigt nur 200 bestätigte – erledigte Aufträge sind unter ‚Alle‘ nie sichtbar. | Seitenaufteilung mit Gesamtzahl (‚200 von 318‘), Standardfilter ‚offen‘, Erledigt erreichbar. |
| **hoch** | Status | Termine ab 16.08.2025 (über ein Jahr überfällig) erscheinen neutral wie künftige Termine; keine Hervorhebung ‚überfällig‘. Navigation zeigt 271 als Zähler ohne Bedeutung. | Überfällige Termine rot + Filter ‚überfällig‘; Zähler im Menü = überfällige oder startbare. |
| **hoch** | Leistung | Seite ist ~12.000 px lang; Sortierung nach Termin, aber Nummern springen (MO/00006 vor MO/00005) – schwer zu scannen. | Gruppierung nach Auftrag oder Termin-Woche, sekundär nach Nummer. |
| **mittel** | Layout | Filterleiste: Chips links, ‚Alle Produkte‘-Auswahl rechts darüber, Checkbox ‚Nur startbare‘ mit Label darunter, ‚Filtern‘-Knopf – drei Ebenen, nicht ausgerichtet; ‚2. Druck ok — Produktion starten‘ blassorange (wirkt deaktiviert und aktiv zugleich). | Eine Filterzeile; Massenaktionen in Aktionsleiste, die erst bei Auswahl erscheint; klare Disabled-Optik. |
| **mittel** | Logik | ‚Neuer Fertigungsauftrag‘ (manuell) steht prominent über der Liste, obwohl Aufträge im Normalfall aus dem Verkauf (MTO) entstehen. | Als Sekundärknopf im Kopf. |
| **niedrig** | Konsistenz | Menge als ‚0 / 1‘ (gefertigt/Soll) ohne Spaltenerklärung. | Spaltentitel ‚Gefertigt / Soll‘ oder Fortschrittsbalken. |

[← zur Übersicht](../README.md)
