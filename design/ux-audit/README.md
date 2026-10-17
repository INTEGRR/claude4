# KRNL – UX-Audit (Stand 17.10.2026)

Vollständige Begehung von KRNL „als jemand, der das System nicht kennt“: **jede Route, jede Detailseite in jedem relevanten Belegzustand, Mobil, Dunkelmodus und Rollen**. Jede Seite hat einen Screenshot, eine Note und konkrete Befunde mit Vorschlag. Grundlage für die UI-Überarbeitung (Claude Design).

**Umfang:** 201 bewertete Ansichten · 200 Screenshots · 124 von 124 Seitenrouten abgedeckt · 538 Befunde (7 kritisch · 77 hoch · 227 mittel · 227 niedrig) · Code wurde nicht verändert.

## So ist diese Ablage aufgebaut (für Claude Design)

| Datei | Inhalt |
|---|---|
| `README.md` | Diese Übersicht: Fazit, Methodik, übergreifende Muster, Ablauf- und Statuslogik, Top-Befunde, Seitenliste, Abdeckung, Design-Tokens |
| `seiten/<id>.md` | Je Ansicht: Zweck, Route, Note, Messwerte, eingebetteter Screenshot, „was gut ist“, Befundtabelle (Schwere · Kategorie · Befund · Vorschlag) |
| `befunde.json` | Dasselbe maschinenlesbar (`seiten[]` mit `id, titel, gruppe, route, screenshot, note, zweck, gut[], befunde[], messwerte`) |
| `befunde.jsonl` | Rohdaten der Bewertung, eine Zeile je Ansicht |
| `meta.json` | Automatische Messwerte je Aufnahme (HTTP-Status, Ladezeit, Seitenhöhe, Konsolenfehler, horizontaler Überlauf, Anzahl Texte < 11 px, Knöpfe, h1) |
| `screenshots/<id>.png` | Ganzseitenaufnahmen; ID-Schema siehe unten |

**ID-Schema:** `0xx` Anmeldung/Kopf · `1xx` Verkauf · `2xx` Versand & Retouren · `3xx` Fertigung · `4xx` Einkauf · `5xx` Lager · `6xx` Service · `7xx` Personal · `8xx` Auswertungen & Finanzen · `9xx` Stammdaten & System (`962-prozess-*` = alle 19 Prozessdefinitionen, `980-*` = alle 17 Einstellungsseiten) · `mNN` Mobil · `dNN` Dunkel · `rNN` Rollen · `A0x` Querschnitt (globaler Rahmen, 404-Seite).

## Kurzfazit

KRNL ist funktional sehr breit und in sich konsistent gebaut. Es hat ein eigenständiges, ruhiges Designsystem („Light Industrial“: Papier, Aluminium, Mono-Typenschild, Orange = Betrieb, Violett = Entscheidung), und die Prozesse sind überall sichtbar und erklärt. Die Hauptprobleme liegen weniger im Stil als in der **Informationsarchitektur der Seiten** und in der **Statuslogik**:

1. **Status ist nicht eindeutig.** Belegart steht dort, wo der Zustand stehen müsste („VERKAUFSAUFTRAG“, „BESTELLUNG“). Schrittnamen erscheinen als Zustand („ABLEHNEN“, „AUFTRAG ANLEGEN“). Für denselben Zustand gibt es mehrere Wörter („Abgebrochen“/„Storniert“). Und es fehlt fast überall eine Stufenanzeige, die sagt: wo stehe ich, was ist der nächste Schritt?
2. **Seiten sind Formular-zuerst.** Fast jede Liste beginnt mit einem großen „Neu anlegen“-Formular. Detailseiten stapeln 6–10 gleich gewichtete Karten. Das 600-px-Prozessdiagramm steht vor dem eigentlichen Inhalt, bei kleiner, unlesbarer Schrift. Primäraktionen sind nicht hervorgehoben, dafür stehen rote „Stornieren“/„Entfernen“ in jeder Zeile.
3. **Fehlzustände werden nicht als Fehler gezeigt.** Dazu gehören negativer Bestand, ein Jahr überfällige Termine, abgelaufene Steuerfristen, Abverkaufsquoten über 100 % und Cashflow voller nicht bestätigter Bestellungen. Das System rechnet damit weiter, ohne zu warnen.
4. **Nach Abschluss bleibt zu viel bearbeitbar.** Positionen erledigter oder gelieferter Shop-Aufträge, Verantwortliche auf erledigten Belegen, Gutschriften auf über Shopify bezahlten Rechnungen.
5. **Querschnitt:** Datumsfelder im US-Format (mm/dd/yyyy) auf jeder Seite, Zahlen mit Dezimalpunkt in Formularen, Klammer-Plurale („Position(en)“), Entwicklerbegriffe und Codes in der Oberfläche (draft, under_repair, Migration, ENV-Variablen), keine Seitenaufteilung oder Suche in langen Listen. Mobil verdeckt das schwebende Befehlsfeld Inhalt und Navigation.

**Notenverteilung (1 = unbrauchbar … 5 = vorbildlich):** 4 → 46 Ansichten · 3 → 123 · 2 → 31 · 1 → 1 (die englische 404-Seite). Keine Ansicht ist „vorbildlich“, keine ist unbenutzbar. Das Niveau ist solide, mit klaren Hebeln.

## Backlog und Code-Verifikation (Stand 17.10.2026)

`befunde.json` ist der **gepflegte Backlog**. Jeder Befund hat eine ID (`<seite>#<n>`) und
einen Status:
- `offen`
- `erledigt` mit Commit
- `verworfen` mit Grund

Der Wächter `tests/ux-audit.test.ts` hält das Format ein.

Die rund 55 Logik-, Daten- und Status-Befunde der Stufen kritisch/hoch wurden im Code geprüft:

- **16 echte Code-Bugs und 2 Lücken.** Sie werden in den Paketen A1/A2 behoben. Dazu gehören:
  - Positionen gelieferter Aufträge löschbar
  - 19 % Vorsteuer bei Drittland-Lieferanten
  - Wechselkurs still 1:1
  - Cashflow mit Anfragen
  - Listen ohne Hinweis abgeschnitten
  - 0-€-Rechnung bleibt offen
  - Steuertermine ohne Überfällig
  - widersprüchlicher KI-Status
  - keine deutsche 404
  - Mobil-Navigation verdeckt
- **Gewollt** (verworfen mit Grund): Überbuchen beim Ausbuchen, „geliefert und Fertigung offen“,
  Mengenabweichungen-Kachel, Kündigungsfrist-Kachel, Prüf-Flag der Lieferantenrechnung.
- **Audit-Befund falsch:**
  - 104: Bei Teillieferung wird nur Geliefertes fakturiert.
  - 451: Platzhalter werden vor der Mail-Freigabe geprüft.

### Stand nach den Paketen A1, A2 und F (17.10.2026, abends)

**538 Befunde: 40 erledigt · 17 verworfen · 481 offen.** Die offenen sind
überwiegend Darstellung und Seitenaufbau (Muster M1–M18) — Arbeitsauftrag
für die UI-Überarbeitung. Erledigt mit Commit in `befunde.json`:

- **A1 Daten & Geld:** Positionen-Schutz (0120), Vorsteuer nach
  Lieferantenland (0121), Wechselkurs strikt (0122), Cashflow nur
  bestätigte Bestellungen (0123), 0-€-Rechnung (0124), Retoure-Restmenge
  (0125).
- **A2 Anzeige & Ablauf:** Steuern überfällig, Zahlungs-Kachel geteilt,
  KI-Karte, Cockpit „Meine“, Label-Fehler, Umsatzplan-Trend (0126),
  Outbox „übersprungen“, deutsche 404, Mobil-Navigation, Dunkelmodus-
  Violett, Fertigungs-Nachfrage bei Handbuchung.
- **F Logik-Fundament** (je mit Wächter): Zustandstabelle, deutsche
  Zahlen (0127), Seitenaufteilung, Überfällig-Signal, Plural (0128),
  Schreibschutz.
- **Verworfen als Browser-Artefakt:** native Datums-, Zahlen- und
  Dateifelder im US-Format. Mit Browsersprache Deutsch zeigt Chromium
  TT.MM.JJJJ und Dezimalkomma.

Vorher/Nachher der betroffenen Seiten: `screenshots-nachher/` (gleiche
IDs wie `screenshots/`; `A02-404-im-rahmen` ist neu).

## Methodik

- **Umgebung:** Produktions-Build (`next build` + `next start`) des Branch-Stands vom 17.10.2026 gegen eine lokale Kopie der Demodaten (`erp_audit`). Darin sind alle 55 Prozess-Fixture-Läufe durchgespielt, damit **jede Belegart in jedem Zustand** existiert (z. B. Verkauf: Angebot/bestätigt/teilgeliefert/Shop geliefert/Shop offen/storniert; Retoure: alle 7 Zustände; Reparatur: alle 7 Zustände). Externe Dienste liefen als Attrappe (Shopify, DHL, KI). Für vier Ansichten (2FA-Einrichtung, 2FA-Code, Lieferantenvertrag, Los) wurden die nötigen Zustände in der Audit-Kopie gezielt hergestellt. Die 2FA-Einstellung wurde danach zurückgesetzt.
- **Aufnahme:** Playwright/Chromium, Desktop 1440 × 900 (Ganzseite), Mobil 390 × 844, Dunkelmodus als Stichprobe (4 Seiten), Rollen Lager und Fertigung. Der Start-Splash wurde unterdrückt. Je Seite automatische Messwerte → `meta.json`.
- **Bewertung:** Jede Aufnahme wurde vollständig angesehen (hohe Seiten in Abschnitten). Bewertet wurden Layout/Hierarchie, Typografie, Konsistenz, Texte, Eingaben, Navigation, Mobil, Barrierefreiheit (Kontrast, Lesbarkeit) und **fachliche Logik**: Stimmen Status und nächste Schritte? Lassen sich Abläufe bruchlos gehen? Passen Zahlen zwischen Seiten zusammen?
- **Schweregrade:** **kritisch** = falsche fachliche Aussage oder Datenschaden möglich · **hoch** = Nutzer trifft wahrscheinlich eine falsche Entscheidung oder findet den Weg nicht · **mittel** = merklicher Reibungsverlust · **niedrig** = Feinschliff.
- **Messwerte (automatisch):** alle Ansichten HTTP 200 (die zwei 404 waren Druckansichten ohne Parameter und wurden mit Parameter neu aufgenommen; die 404-Seite selbst ist als `A01` bewertet). Keine Konsolenfehler, kein horizontaler Seitenüberlauf (breite Tabellen scrollen in ihrem Container). Median-Ladezeit ≈ 0,8 s (lokal); am meisten Kleinsttext (< 11 px): Prozess-/Aktionsliste (628 Elemente), Verkaufsliste (473), Fertigungsliste (424).
- **Artefakte der Ganzseitenaufnahme:** Die Seitenleiste endet in langen Aufnahmen bei 900 px (sie ist fixiert). Die Laschen „Fehler?“/„KI“ erscheinen nur einmal auf Höhe des ersten Bildschirms. Das ist kein Befund.

## Hinweis zur Datenbasis (wichtig beim Lesen)

Die Audit-Datenbank enthält Demo- **und** Prozesstest-Daten. Einige auffällige Zahlen sind deshalb Folgen der Testdaten: negativer Bestand, Termine ein Jahr überfällig, 271 offene Fertigungsaufträge, Bestellungen in CNY mit 19 % USt, Einkaufsprojekt „bestellt“ mit Bestellung im Status Anfrage. **Bewertet wird, dass die Oberfläche solche Zustände zulässt und nicht als Fehler kennzeichnet.** Ob der jeweilige Zustand auch im Echtbetrieb entstehen kann, sollte vor der Umsetzung geprüft werden – betrifft vor allem `402`, `412`, `413`, `502`, `520`, `850`.

## Übergreifende Muster (Designsystem-Ebene – einmal lösen, überall wirksam)

| # | Muster | Wo (Beispiele) | Vorschlag |
|---|---|---|---|
| M1 | **Kein einheitlicher Status-Stepper.** Zustand nur als kleines Mono-Etikett, oft Belegart statt Zustand | 102–107, 401, 403, 122/123, 611/612, 911 | Komponente „Statusleiste“: Stufen des Prozesses, aktueller Schritt hervorgehoben, nächste Aktion als Primärknopf daneben. Speist sich aus der Prozessdefinition (Chamäleon). |
| M2 | **Prozessdiagramm vor dem Inhalt**, 600 px, Schrift ~7 px, Codes sichtbar | 213–218, 301, 411, 501, 601–606, 853, 962-* | Diagramm einklappbar unter den Inhalt; oben der Stepper (M1). Im Diagramm Mindestschrift 11 px, Codes nur im Designer. Endknoten je Ausgang (Abgelehnt/Storniert eigener Endknoten). |
| M3 | **„Als Nächstes möglich“ ohne Gewichtung**, alle Schritte gleich grau | 213, 501, 601, 403 | Empfohlener Schritt primär (Orange), Sonderwege sekundär, destruktive Wege im Mehr-Menü. |
| M4 | **Formular-zuerst-Listen**: Anlegeformular über der Liste | 101, 300, 310, 401, 410, 600, 900, 910, 480, 490, m05 | Knopf „+ Neu“ im Seitenkopf → Dialog/Schublade. Liste beginnt direkt unter dem Kopf. |
| M5 | **Destruktive Aktionen zu laut** (rote Knöpfe je Zeile, „Stornieren“ neben Primäraktion) | 102, 200, 311, 702, 855, 980-versandregeln | Zeilenmenü (⋯); Stornieren/Löschen mit Bestätigung; Primäraktion rechts außen. |
| M6 | **Datum/Zahlen im US-Format** in nativen Feldern; Dezimalpunkt in Zahlenfeldern | nahezu alle Formulare, 112, 851, 497 | `lang="de"` am Dokument + eigene Datums-/Zahlkomponente (TT.MM.JJJJ, Komma, Tausenderpunkt). |
| M7 | **Display-Flächen überstrapaziert**: Die schwarzen `--display`-Flächen (Instrumenten-Display) werden für Kennzahlen, Anschriften, Fehlerbilder, QR-Ausgaben und Shopify-IDs genutzt, also für den stärksten Kontrast bei oft unwichtigem Inhalt | 105, 110, 112–115, 210, 301, 510, 601, 902 | Display nur für Live-Zustände (Scanner, laufende Zeit). Kennzahlen und Kopfdaten in hellen Karten. |
| M8 | **Mono-Versalien in Grau** für Labels, Status und Kopfzeile (≤ 11 px, geringer Kontrast) | global, d01–d04 | Labels in Satzschreibung 12–13 px, Kontrast ≥ 4,5:1; Mono nur für Nummern/Codes. |
| M9 | **Codes und Entwicklersprache in der Oberfläche** (draft, under_repair, fixture, Migration, ENV-Namen, `fake:order`, Job-Namen) | 120, 497, 501, 530, 604, 950, 953, 960, 962-*, 980-ki | Anzeigenamen-Tabelle je Zustand/Job. Technische Details in „Technische Details“ einklappen. |
| M10 | **Klammer-Plurale und Rohzahlen** („Position(en)“, „1.0000 ×“, „35.70 €“) | 103, 107, 216, 302, 496, 498, 320 | Pluralfunktion und `qty()`/`eur()` überall. |
| M11 | **Lange Listen ohne Suche/Seitenaufteilung**, teils hart begrenzt | 100, 110, 300 (limit 200!), 401, 471, 850, 900, 953, 960 | Einheitliche Listenkomponente: Suche, Filter-Chips, Seitenaufteilung mit Gesamtzahl, Summen je Filter. |
| M12 | **Kein Überfällig-/Fehler-Signal** in Daten (negativer Bestand, Termine in der Vergangenheit, abgelaufene Fristen) | 300, 500, 510, 520, 600, 852, 856, 902 | Regel: Vergangene Termine offener Belege rot + Filter „überfällig“; negativer Bestand = Fehlerzustand mit Ursache. |
| M13 | **Bearbeitbar nach Abschluss** | 103–107, 302, 303, 403, 413, 422, 503 | Schreibschutz je Status (aus Prozessdefinition). „Ändern“ nur als bewusste Aktion mit Folgen-Vorschau. |
| M14 | **Platzhalter sehen wie Werte aus** („0“, „HRB 12345“, „Brother QL-1100“, „P00042, P00043“) | 420, 471, 480, 490, 980-* | Platzhalter heller und mit „z. B.“, Zahlenfelder leer statt 0. |
| M15 | **Farbsemantik verwässert:** Alle Zahlen der Übersicht in Warnfarbe. Violett (laut Designsystem = Entscheidung) für Scannen, Werkstatt-Reiter, Fremdkapitalbedarf. Orange-Punkt für Normalzustände | 010, A00, 850, 854, 960 | Zahlenfarbe nach Handlungsbedarf (0 = neutral). Violett nur für Freigaben/KI-Vorschläge. Statusfarben aus den Tokens success/warn/danger/info. |
| M16 | **Doppelte Einstiege** für dieselbe Funktion | Scanner = Packtisch; Inventur (Lager vs. Assistent); Artikel anlegen (Formular vs. Assistent); Arbeitsplätze (Fertigung vs. Einstellungen); Stammdaten (Produkte vs. Einstellungen); Lieferantenakte (Kontakte vs. Einkauf) | Je Funktion ein Ort, von den anderen verlinken. |
| M17 | **Mobil:** schwebendes Befehlsfeld verdeckt Inhalt und offene Navigation. Laschen überlappen. Tabellen nur seitlich wischbar | m01, m05, m07, m08, m10 | Am Handy Befehlsfeld unten mit Inhaltsabstand bzw. als Knopf. Laschen ins Menü. Tabellen als Karten. |
| M18 | **Seitliche Laschen „Fehler?“/„KI“** überdecken rechts Inhalt (Tabellenspalten, Knöpfe) | global | Laschen in die Kopfleiste oder als kleines schwebendes Icon unten rechts. |

## Ablauf- und Statuslogik (prozessübergreifend geprüft)

Die Abläufe wurden über ihre Belege hinweg verfolgt, nicht nur Seite für Seite.

**Shop-Bestellung → Fertigung → Versand → Rechnung → Retoure**
- Shop-Aufträge bleiben nach Lieferung und Bezahlung in KRNL editierbar (Positionen, Gutschrift), obwohl Shopify die Quelle ist und Erstattungen laut Betreiber in Shopify bleiben (105, 106, 113).
- Teillieferung ohne sichtbare Restlieferung; Rechnung über den vollen Betrag bei 1/8 geliefert (104).
- Durch einen Rückläufer entfallene Fertigung erscheint rot als „Abgebrochen“ wie ein Fehler (106, 303). Die Retoure ist am Auftrag nicht verlinkt, und „Retoure anlegen“ wird trotz bestehender Retoure angeboten (107).
- Retoure: genehmigt ohne Label ohne sichtbaren Grund (214); nur ein Prüfergebnis je Position bei Menge > 1 (215); abgelehnte Retoure läuft im Diagramm über „Abschließen“ (218).
- Lieferung „wartet auf Verfügbarkeit“ hat „Erledigt“ mit voller Menge vorbelegt und ist buchbar → negativer Bestand (502, 520).

**Einkauf: Projekt → Anfrage → Muster → Bestellung → Sendung → Wareneingang → Rechnung → Zahlung**
- Projektstatus folgt nicht den Teilprozessen: „Bedarf“ trotz freigegebenem Golden Sample (411); „bestellt“ bzw. „abgeschlossen“ bei Bestellung im Status Anfrage (412, 413).
- Nach Golden Sample laufen weitere Musterrunden; Eingangsdatum vor Anforderung (411). Die Bewertungsmaske ist mit „Freigeben + Golden Sample“ vorbelegt (431).
- Mail an Lieferanten mit leeren Vorlagenfeldern freigegeben und versendet (451). Kein Prüfschritt im Prozess (962-mail_versand).
- Drittland-Bestellung mit 19 % USt (402) → fließt in Cashflow und Fremdkapitalbedarf (850).
- Lieferantenrechnung: bezahlt vor geprüft (496). Der Prozess hat keinen Pflicht-Prüfschritt vor der Zahlung (962-lieferantenrechnung).
- Sendung „abgerechnet“ ohne Kosten und Zoll (421).
- Cockpit „Nichts offen“, während Menüzähler, Wiedervorlagen und Übersicht offene Punkte melden: drei Quellen für „was ist zu tun“ (400, 460, 010).

**Reparatur: Anfrage → RMA → Eingang → Reparatur → Angebot → Rückgabe**
- Kostenpflichtige Reparatur: Angebot entsteht erst **nach** der Reparatur. Es gibt keine Freigabe des Kostenvoranschlags vor Reparaturbeginn (604, 962-reparatur).
- Liegezeiten (10 Monate „In Reparatur“, 9 Aufträge „repariert“ nicht zurück) werden nicht angezeigt (600, 603).
- Status „Versendet“ bei Abholung am Tresen (605).

**Finanzen**
- Cashflow-Prognose rechnet nicht bestätigte und seit Monaten überfällige Bestellungen in den laufenden Monat → Fremdkapitalbedarf 175 T€ (850). Dieselbe Zahl steht prominent auf der Übersicht (010, m01).
- Umsatzplan schlägt das 2,7-fache des Vorjahres vor, ohne Begründung (851).
- USt-Voranmeldung 7 Tage überfällig als „offen“ (856). Kündigungsfristen in 14 Tagen als „nichts offen“ (852).

**Statusvokabular (Inventar der Widersprüche)**
- „Abgebrochen“ (Auftrag, FA, RMA) vs. „Storniert“ (Rechnung, Verlauf) für denselben Zustand.
- Belegart als Status: „VERKAUFSAUFTRAG“, „BESTELLUNG“, „ANGEBOTSANFRAGE“.
- Schritt als Status: „ABLEHNEN“, „AUFTRAG ANLEGEN“, „ANNEHMEN → REPARATURAUFTRAG“.
- Englische Codes: confirmed, assigned, done, draft, under_repair, awaiting_device, shipped.
- Fehlende Umlaute: geprueft, rueckfrage, STOEREND, UEBERSPRUNGEN.
- Mehrdeutig: „Bezahlt“ bei Gutschrift (gemeint: erstattet), „Nichts abzurechnen“ (gemeint: noch kein Eingang), „Nichts — der Prozess ist am Ende oder wartet“ (welches von beiden?).
- **Vorschlag:** Eine zentrale Zustandstabelle je Belegart (Code → Anzeigename → Farbe → Endzustand ja/nein) und ein Wächtertest, der verbietet, dass Codes ungemappt in die Oberfläche gelangen. Das passt zum Projektprinzip „Konventionen erzwingen“.

## Top-Befunde (alle kritischen und hohen)

| Schwere | Seite | Kategorie | Befund | Vorschlag |
|---|---|---|---|---|
| **kritisch** | [104-verkauf-teilgeliefert](seiten/104-verkauf-teilgeliefert.md) | Logik | ‚Teilweise geliefert‘ (1 von 8 Stück), aber unter Lieferungen steht keine offene Restlieferung – nur WH/OUT/00125 (erledigt) und ein Wareneingang WH/IN/00036. Wo der Rest bleibt, ist nicht zu sehen. | Restlieferung (Backorder) immer anzeigen bzw. deutlich ‚Rest: 7 Stück ohne Lieferung – anlegen‘ melden. |
| **kritisch** | [300-fertigung](seiten/300-fertigung.md) | Daten | Liste ist hart auf 200 Zeilen begrenzt (Abfrage limit 200), ohne Hinweis: 271 offene + 45 erledigte Aufträge existieren, ‚Alle‘ zeigt nur 200 bestätigte – erledigte Aufträge sind unter ‚Alle‘ nie sichtbar. | Seitenaufteilung mit Gesamtzahl (‚200 von 318‘), Standardfilter ‚offen‘, Erledigt erreichbar. |
| **kritisch** | [402-bestellung-entwurf](seiten/402-bestellung-entwurf.md) | Logik | Bestellung bei einem chinesischen Lieferanten in CNY rechnet 19 % deutsche USt auf: Netto 37.800 CNY → ‚Gesamt (brutto) 44.982 CNY‘. Bei Import fällt keine USt des Lieferanten an (EUSt erst beim Zoll). | Steuersatz aus Lieferant/Land ableiten (Drittland = 0 %), Brutto-Zeile bei 0 % weglassen. |
| **kritisch** | [412-projekt-bestellt](seiten/412-projekt-bestellt.md) | Status | Projekt ‚BESTELLT‘, die verknüpfte Bestellung P00036 steht aber noch auf ‚ANGEBOTSANFRAGE‘ (nicht bestätigt, nicht versendet). | ‚Bestellt‘ erst nach Bestätigung der Bestellung; sonst ‚Bestellung vorbereitet‘. |
| **kritisch** | [502-lieferung-wartet](seiten/502-lieferung-wartet.md) | Logik | Feld ‚Erledigt‘ ist mit der vollen Bedarfsmenge (1 bzw. 4) vorbelegt, obwohl 0 reserviert sind – ‚Validieren‘ ist aktiv und würde Ware ausbuchen, die nicht da ist (negativer Bestand, vgl. 520). | Erledigt-Menge = reservierte Menge vorbelegen; Buchen über Bestand nur mit ausdrücklicher Bestätigung. |
| **kritisch** | [520-bestand](seiten/520-bestand.md) | Daten | Physischer Bestand ist negativ (Mechanischer Switch −12.902, Tastatur Blau −42, Prozesstest Gerät −1) – ohne Alarm; nur die Prognose bekommt ‚Unterdeckung‘. | Negativen Bestand als Fehler (rot) markieren, Ursache verlinken; Buchungen ins Negative verhindern oder bestätigen lassen. |
| **kritisch** | [850-cashflow](seiten/850-cashflow.md) | Logik | Cashflow-Oktober enthält Bestellungen über 285.652,96 € (u. a. die nicht bestätigte CNY-Anfrage P00036 mit 19 % USt und alle seit Monaten überfälligen Testbestellungen) → Fremdkapitalbedarf 175.162 € und ‚Fällig in 14 Tagen 257.107,98 € (122 Posten)‘ – die Kernaussage der Seite ist dadurch falsch. | Nur bestätigte Bestellungen einrechnen; Anfragen getrennt als ‚möglich‘; überfällige Zahlungen als eigener Block statt im laufenden Monat. |
| **hoch** | [010-uebersicht](seiten/010-uebersicht.md) | Logik | Alle Zahlen stehen in derselben Warnfarbe (Orange-Rot), egal ob „Deine Aufgaben 7“, „Versandbereit 1“ oder „Unterdeckung 175.162 €“. Dringlichkeit ist nicht unterscheidbar; die Farbpunkte (lila/orange/braun) erklären sich nicht. | Zahlenfarbe nach Zustand: neutral (normal), Warnung (überfällig), Gefahr (kritisch). Farbpunkte entweder mit Legende oder weglassen. |
| **hoch** | [010-uebersicht](seiten/010-uebersicht.md) | Daten | „Fertigungsaufträge fällig (bis heute) 271“ ist bei 308 Aufträgen keine handlungsrelevante Zahl — der Nutzer sieht ein Dauerrauschen. | Nur überfällige oder heute startbare (Material da) zählen; Rest als Nebenzahl. |
| **hoch** | [013-aufgaben](seiten/013-aufgaben.md) | Layout | Drei gleich starke Knöpfe je Zeile (Öffnen, Verwerfen, Erledigt) — „Verwerfen“ in Rot-Kontur gleichrangig neben der Primäraktion; bei 7 Aufgaben 21 laute Knöpfe. | Primär „Erledigt“ (Häkchen links als Checkbox), „Öffnen“ als Zeilenklick, „Verwerfen“ ins Mehr-Menü. |
| **hoch** | [A00-rahmen](seiten/A00-rahmen.md) | Navigation | „Scannen“ ist dauerhaft violett hinterlegt/markiert und wirkt wie der aktive Menüpunkt — auch auf Sprechen, Konto oder Aufgaben. Der echte aktive Punkt (z. B. Aufgaben, orangefarbene Linie) konkurriert damit. | Kernfunktionen über Icon/Farbe kennzeichnen, aber nur den aktiven Punkt hinterlegen. |
| **hoch** | [A00-rahmen](seiten/A00-rahmen.md) | Navigation | Alle Gruppen sind zugeklappt; die Seitenleiste zeigt nur Versalien-Überschriften (VERKAUF, FERTIGUNG …). Ein neuer Nutzer sieht keinen einzigen Menüpunkt und muss raten, wo „Retouren“ oder „Stücklisten“ liegen. | Aktive Gruppe immer offen, zuletzt genutzte Gruppen offen merken; Gruppen-Icons; Suche im Menü. |
| **hoch** | [012-scanner](seiten/012-scanner.md) | Layout | Das eigentliche Eingabefeld ist klein (260 px) und der „Öffnen“-Knopf winzig, während die Fläche drumherum riesig und leer ist — am Packtisch mit Handscanner unkritisch, auf Touch/Tablet zu klein. | Großes Eingabefeld (volle Kartenbreite, 48 px hoch), großer Knopf, Autofokus sichtbar. |
| **hoch** | [100-verkauf](seiten/100-verkauf.md) | Leistung | Keine Seitenaufteilung: rund 150 Aufträge auf einer 6.800 px hohen Seite; mit echten Daten wird das unbenutzbar langsam. | Pagination oder „mehr laden“, Standardfilter „offen“, Zahl der Treffer anzeigen. |
| **hoch** | [100-verkauf](seiten/100-verkauf.md) | Logik | Viele Aufträge sind „vollständig geliefert“ und zeigen gleichzeitig „Fertigung 2 offen“ — ein Widerspruch, der den Nutzer verunsichert (gefertigt wird nach der Lieferung?). | Offene Fertigung bei vollständig geliefertem Auftrag als Klärfall markieren oder ausblenden; Zustand erklären. |
| **hoch** | [102-verkauf-entwurf](seiten/102-verkauf-entwurf.md) | Status | Der Status steht nur als kleines graues Etikett „ANGEBOT“ neben den Knöpfen; es gibt keine Statusleiste/Prozessanzeige (Angebot → Auftrag → geliefert → berechnet). Die Retoure hat ein Prozess-Panel, der Verkaufsauftrag nicht – inkonsistent zum Grundsatz ‚Prozess First‘. | Einheitliche Stufenleiste (Stepper) im Kopf aller Belege, aktueller Schritt hervorgehoben, nächste Aktion daneben. |
| **hoch** | [102-verkauf-entwurf](seiten/102-verkauf-entwurf.md) | Eingabe | Datumsfelder „Zugesagter Liefertermin“ und „Angebot gültig bis“ zeigen das US-Format mm/dd/yyyy (Browser-Locale statt de-DE). | Eigene Datumskomponente oder lang="de" am Dokument; Anzeige TT.MM.JJJJ. |
| **hoch** | [103-verkauf-bestaetigt](seiten/103-verkauf-bestaetigt.md) | Logik | Nach der Bestätigung sind Positionen weiterhin per „Entfernen“ löschbar und „Position hinzufügen“ ist aktiv, obwohl Lieferung und zwei Fertigungsaufträge existieren. Was mit Lieferung/FA passiert, ist nicht erkennbar. | Positionen nach Bestätigung sperren oder Änderung nur über eine bewusste Aktion ‚Auftrag ändern‘ mit Vorschau der Folgen (FA anpassen/stornieren). |
| **hoch** | [103-verkauf-bestaetigt](seiten/103-verkauf-bestaetigt.md) | Status | Statusetikett heißt „VERKAUFSAUFTRAG“ – das ist die Belegart, kein Zustand. Gleichzeitig ‚Lieferstatus: nicht geliefert‘, Lieferung ‚wartend auf Verfügbarkeit‘, FA ‚bestätigt‘: vier Statusbegriffe, keiner sagt ‚wartet auf Fertigung (0/5 gefertigt)‘. | Ein zusammengefasster Zustand im Kopf (z. B. ‚In Fertigung · 0 von 5 gefertigt · Liefertermin —‘) plus Stepper. |
| **hoch** | [104-verkauf-teilgeliefert](seiten/104-verkauf-teilgeliefert.md) | Logik | Rechnung RE-0106 über den vollen Betrag 3.155,88 €, obwohl erst 1 von 8 Stück geliefert ist. Zudem Datum 16.10.2026 in der Tabelle, laut Verlauf am 16.09.2026 erstellt. | Rechnung nur über Geliefertes (oder deutlich als Vorauskasse kennzeichnen); Rechnungsdatum und Verlaufsdatum angleichen. |
| **hoch** | [104-verkauf-teilgeliefert](seiten/104-verkauf-teilgeliefert.md) | Daten | Blau: 1 von 2 geliefert, der zugehörige FA MO/00290 über 2 Stück steht weiter auf ‚bestätigt‘ (nichts gefertigt). Woher das gelieferte Stück kam, ist nicht nachvollziehbar. | FA-Menge mit Lieferung abgleichen oder Herkunft (Lagerbestand) zeigen. |
| **hoch** | [105-verkauf-shop-geliefert](seiten/105-verkauf-shop-geliefert.md) | Logik | Shop-Auftrag ist vollständig geliefert und bezahlt, trotzdem sind „Entfernen“ und „Position hinzufügen“ aktiv. Änderungen kollidieren mit Shopify als Quelle und der gestellten Rechnung. | Shop-Aufträge: Positionen schreibgeschützt (‚Änderungen im Shopify-Admin‘). |
| **hoch** | [107-verkauf-storniert](seiten/107-verkauf-storniert.md) | Konsistenz | Status heißt beim Auftrag „ABGEBROCHEN“, bei der Rechnung „STORNIERT“, im Verlauf ‚Auftrag storniert‘ – drei Wörter für denselben Zustand. | Einheitlich ‚Storniert‘. |
| **hoch** | [107-verkauf-storniert](seiten/107-verkauf-storniert.md) | Logik | „Retoure anlegen“ wird weiter angeboten, obwohl schon Retoure RT/00001 existiert und der Auftrag storniert ist. Die bestehende Retoure ist nirgends verlinkt (keine Retouren-Karte). | Karte ‚Retouren‘ mit Link und Status; Knopf nur, wenn noch rücksendbare Menge übrig ist. |
| **hoch** | [110-rechnungen](seiten/110-rechnungen.md) | Layout | Die drei Kennzahlen (Offene Forderungen, Überfällig, Umsatz) stehen als drei volle, schwarze Balken untereinander – ~250 px Höhe für drei Zahlen, stärkster Kontrast der Seite. | Kennzahlen in einer Zeile (3 Spalten), helle Karten, Akzentfarbe nur bei Handlungsbedarf (Überfällig > 0). |
| **hoch** | [110-rechnungen](seiten/110-rechnungen.md) | Leistung | 132 Belege auf einer Seite (6.233 px), keine Seitenaufteilung, keine Suche (Kunde, Nummer, Betrag), kein Datumsfilter. | Suchfeld + Zeitraumfilter + Seitenaufteilung (50) oder virtuelles Scrollen; Summen je Filter. |
| **hoch** | [110-rechnungen](seiten/110-rechnungen.md) | Status | Ob Rechnungen im Probelauf oder scharf laufen (heikles Thema laut Betreiber), ist auf der Liste nicht sichtbar – nur ein Filter-Chip ‚Probelauf‘ erklärt es versteckt. | Fester Modus-Hinweis im Kopf (‚Modus: Probelauf – Belege PROBE-RE‘ / ‚Scharf seit …‘). |
| **hoch** | [112-rechnung-offen](seiten/112-rechnung-offen.md) | Layout | Anschrift, Belegdaten und Beträge als drei volle schwarze Balken untereinander (~430 px) – das wirkt wie ein Terminal, nicht wie eine Rechnung, und drückt Positionen nach unten. | Rechnungskopf als helle 3-Spalten-Karte (Anschrift / Belegdaten / Beträge) wie auf dem PDF. |
| **hoch** | [112-rechnung-offen](seiten/112-rechnung-offen.md) | Eingabe | Zahlungsbetrag als ‚0.00‘ mit Dezimalpunkt, Datum als 10/17/2026 – englische Formate in einem deutschen Finanzformular. | Zahlenfeld mit deutschem Format (Komma) und Datumsfeld TT.MM.JJJJ. |
| **hoch** | [113-rechnung-bezahlt](seiten/113-rechnung-bezahlt.md) | Logik | Für eine über Shopify bezahlte Rechnung bietet KRNL Teilgutschrift und Storno an. Laut Betreiber bleiben Erstattungen in Shopify – eine Gutschrift hier erzeugt eine zweite, abweichende Wahrheit. | Bei Zahlungsart Shopify Korrekturen sperren (‚Erstattung im Shopify-Admin; Gutschrift folgt automatisch‘). |
| **hoch** | [120-vorgaenge](seiten/120-vorgaenge.md) | Texte | Untertitel „Laufzeit-Prozesse auf generischen Belegen — neue Business-Linien ohne neue Tabellen“ ist Entwicklersprache; ein Anwender versteht nicht, wofür die Seite da ist. | Nutzersprache: ‚Anfragen und andere Abläufe, die keinen eigenen Menüpunkt haben‘. |
| **hoch** | [122-vorgang-anfrage-gewonnen](seiten/122-vorgang-anfrage-gewonnen.md) | Status | Kopfetikett zeigt den Schrittnamen ‚AUFTRAG ANLEGEN‘ (klingt wie ein Knopf), der Zustand ist laut Liste ‚gewonnen‘. ‚Als Nächstes möglich: AUFTRAG & LIEFERUNG – WARTET‘ ist unverständlich. | Kopf zeigt Zustand (‚Gewonnen‘), Stepper zeigt Schritte; ‚Als Nächstes‘ als Klartext (‚Wartet auf Lieferung von S00138‘). |
| **hoch** | [123-vorgang-anfrage-abgelehnt](seiten/123-vorgang-anfrage-abgelehnt.md) | Status | Kopfetikett ‚ABLEHNEN‘ (Verb/Schrittname) statt Zustand ‚Abgelehnt‘ – liest sich wie ein Knopf zum Ablehnen. | Zustand als Partizip, Schrittnamen nur im Stepper. |
| **hoch** | [130-shop-verfuegbarkeit](seiten/130-shop-verfuegbarkeit.md) | Layout | Jeder Artikel ist eine ~350 px hohe Karte; die eigentliche Antwort ‚wie viel geht an Shopify‘ steht klein als ‚bis 6‘ in einer grün umrandeten Ellipse. Bei vielen Artikeln endlos scrollen. | Übersichtstabelle: Artikel / Varianten / baubar / an Shopify (groß) / Engpassteil / Regel; Details aufklappbar. |
| **hoch** | [200-versand](seiten/200-versand.md) | Layout | Filterzeile der Versandbereit-Karte ist unaufgeräumt: Checkbox ‚Nur Einzelposition‘ steht mit Label darunter, Felder unterschiedlich breit, ‚Filtern‘-Knopf tiefer als die Felder; ‚Packzettel drucken (0)‘ wirkt deaktiviert und steht neben ‚Alle auswählen‘. | Filter als einheitliche Chip-/Feldleiste auf einer Grundlinie, Sofortfilter ohne Knopf; Auswahlaktionen erst bei Auswahl einblenden (Aktionsleiste). |
| **hoch** | [A01-404-seite](seiten/A01-404-seite.md) | Texte | Standard-Next.js-404 auf Englisch (‚This page could not be found.‘) – die einzige englische Seite im System. | Eigene not-found-Seite auf Deutsch mit Suche und Link zur Übersicht. |
| **hoch** | [A01-404-seite](seiten/A01-404-seite.md) | Layout | Die 404-Meldung liegt über dem halbtransparenten Start-Splash (KRNL-Logo, Zähler ‚Module 9 / Prozesse 19‘, Ladebalken); Text überlagert die Zähler – wirkt kaputt. | Splash nicht auf Fehlerseiten zeigen; Fehlerseite im normalen Seitenrahmen. |
| **hoch** | [213-retoure-angefragt](seiten/213-retoure-angefragt.md) | Schritte | Unter ‚Als Nächstes möglich‘ stehen vier gleichrangige graue Knöpfe (Genehmigen + Retourenlabel, Ablehnen, Ware eingegangen, Stornieren) – keine Primäraktion, der Normalfall (Genehmigen) ist nicht hervorgehoben. | Genehmigen als Primärknopf oben im Kopf, Ablehnen sekundär, Sonderwege (Eingang ohne Genehmigung, Stornieren) im Mehr-Menü. |
| **hoch** | [213-retoure-angefragt](seiten/213-retoure-angefragt.md) | Barrierefreiheit | Prozessdiagramm in Originalgröße unlesbar (Schrift ~7 px), Knotentitel abgeschnitten (‚Genehmigen + Retourer‘, ‚Prüfen und zurückbuche‘), technische Aktionsnamen (versand.retoure_anlegen) für Anwender sichtbar; nimmt ~600 px Höhe ein. | Kompakter horizontaler Stepper der Hauptschritte; Diagramm einklappbar; Codes nur im Designer. |
| **hoch** | [214-retoure-genehmigt](seiten/214-retoure-genehmigt.md) | Status | Genehmigt, aber ‚Noch kein Label.‘ ohne Grund – war der Schalter aus oder ist der DHL-Aufruf gescheitert? Der Kunde kann ohne Label nichts zurückschicken. | Deutlicher Hinweis (gelb) ‚Kunde hat noch kein Label – Grund: … – jetzt senden‘. |
| **hoch** | [300-fertigung](seiten/300-fertigung.md) | Status | Termine ab 16.08.2025 (über ein Jahr überfällig) erscheinen neutral wie künftige Termine; keine Hervorhebung ‚überfällig‘. Navigation zeigt 271 als Zähler ohne Bedeutung. | Überfällige Termine rot + Filter ‚überfällig‘; Zähler im Menü = überfällige oder startbare. |
| **hoch** | [300-fertigung](seiten/300-fertigung.md) | Leistung | Seite ist ~12.000 px lang; Sortierung nach Termin, aber Nummern springen (MO/00006 vor MO/00005) – schwer zu scannen. | Gruppierung nach Auftrag oder Termin-Woche, sekundär nach Nummer. |
| **hoch** | [301-mo-bestaetigt](seiten/301-mo-bestaetigt.md) | Daten | Verfügbar-Spalte zeigt große Negativwerte (Mechanischer Switch −17.639, Schraube −1.800) ohne Erklärung – negativer verfügbarer Bestand ist für Nutzer unverständlich (gemeint: überbucht durch Reservierungen). | ‚0 verfügbar · 17.639 fehlen über alle Aufträge‘ bzw. Bedarf/Bestand getrennt; rote Hervorhebung. |
| **hoch** | [301-mo-bestaetigt](seiten/301-mo-bestaetigt.md) | Schritte | Sieben gleichrangige Knöpfe im Kopf (Drucken, Etikett drucken, Ansicht, Verfügbarkeit prüfen, Fertigung starten, Stornieren) + ‚Übernehmen‘ – der nächste Schritt (Fertigung starten) ist nicht hervorgehoben, ‚Stornieren‘ rot daneben. | Primär ‚Fertigung starten‘, Drucken als Gruppe, Stornieren ins Mehr-Menü. |
| **hoch** | [400-cockpit](seiten/400-cockpit.md) | Logik | ‚Nichts offen — der Einkauf ist auf Stand‘, während das Menü Einkauf 4 zeigt, die Bestellliste ‚Zu senden (2)‘ meldet, 27 Bestellungen ‚Rechnung erwartet‘ haben und die Übersicht 3 fällige Wiedervorlagen und 9 überfällige Wareneingänge nennt. | Cockpit muss dieselben Quellen wie Menüzähler und Übersicht nutzen; bei ‚Meine‘ = leer Hinweis ‚Unter Alle stehen 14 Punkte‘. |
| **hoch** | [401-bestellungen](seiten/401-bestellungen.md) | Status | Spalte Status zeigt fast überall ‚BESTELLUNG‘ (Belegart) – ob bestätigt, versendet, teilgeliefert oder geliefert, ist nicht erkennbar; ein Lieferstatus fehlt ganz. | Status = Lieferfortschritt (bestellt → bestätigt → unterwegs → teilweise/vollständig eingegangen), Belegart nur bei Anfragen. |
| **hoch** | [402-bestellung-entwurf](seiten/402-bestellung-entwurf.md) | Layout | Neun Karten (Details, Positionen, Zahlplan, Wareneingänge, Rechnungen, Mails, Wiedervorlagen, Dokumente, Verlauf) auf ~2.000 px; zwei orange Primärknöpfe (‚Bestellung bestätigen‘ oben, ‚Speichern & bestätigen‘ in Details). | Reiter (Übersicht · Kommunikation · Dokumente · Verlauf) und genau eine Primäraktion. |
| **hoch** | [402-bestellung-entwurf](seiten/402-bestellung-entwurf.md) | Eingabe | Alle Datumsfelder (ETA, bestätigt, Rest-Termin, Verschifft am) im US-Format mm/dd/yyyy. | Deutsches Datumsformat (global). |
| **hoch** | [411-projekt-bedarf](seiten/411-projekt-bedarf.md) | Status | Projekt steht auf ‚BEDARF‘ und das Diagramm auf dem ersten Schritt, obwohl die Bemusterung läuft und bereits ein Golden Sample freigegeben ist (Teilprozess 3/4). Anfragen (0) – die Muster wurden ohne Anfrage angefordert. | Projektstatus aus Teilprozessen ableiten (‚Bemusterung‘), Bemusterung ohne Anfrage zulassen, aber sichtbar. |
| **hoch** | [411-projekt-bedarf](seiten/411-projekt-bedarf.md) | Logik | Nach freigegebenem Golden Sample (Runde 1) laufen Runde 2 (Nachbessern) und 3 (offen) weiter; Eingang Runde 1 am 01.10., angefordert am 17.10. – Eingang vor Anforderung. | Nach Golden Sample weitere Runden nur bewusst (neue Revision); Datumsplausibilität prüfen. |
| **hoch** | [413-projekt-abgeschlossen](seiten/413-projekt-abgeschlossen.md) | Logik | ‚Abgeschlossen — alles geliefert‘, die zugehörige Bestellung P00034 steht aber auf ‚ANGEBOTSANFRAGE‘, Spalte Eingegangen ‚Dienstleistung‘. | Abschluss nur bei bestätigten/gelieferten Bestellungen; Dienstleistungen als ‚erbracht‘ führen. |
| **hoch** | [421-sendung-abgerechnet](seiten/421-sendung-abgerechnet.md) | Logik | Status ‚ABGERECHNET — Kosten auf die Wareneingänge verteilt‘, aber Kosten (0) und Zoll (0 Zeilen): abgerechnet ohne Kosten; Formulare für Kosten und Zoll sind weiter offen. | Abrechnen ohne Kosten nur mit Bestätigung (‚Frei Haus?‘); danach Formulare sperren oder ‚Nachbuchung‘ kennzeichnen. |
| **hoch** | [431-muster-offen](seiten/431-muster-offen.md) | Eingabe | Bewertung ist vorbelegt mit ‚Freigeben‘ und angehaktem ‚als Golden Sample markieren‘ – ein Klick auf ‚Bewertung speichern‘ gibt ein noch nicht eingegangenes Muster als Serienreferenz frei. | Kein Standardergebnis; Golden Sample bewusst anhaken; Bewertung erst nach Eingang. |
| **hoch** | [440-posteingang](seiten/440-posteingang.md) | Status | Unsere eigenen, gerade versendeten Anfragen (→) stehen als ‚OFFEN‘ im Standardfilter, obwohl wir auf den Lieferanten warten. | Nach eigenem Versand automatisch ‚Wartet auf Lieferant‘. |
| **hoch** | [440-posteingang](seiten/440-posteingang.md) | Status | Der wichtigste Zustand – Einkaufspostfach ‚NICHT ANGEBUNDEN‘ – steht klein ganz unten. | Gelbes Banner oben, solange keine Mails eingelesen werden. |
| **hoch** | [451-entwurf-gesendet](seiten/451-entwurf-gesendet.md) | Logik | Die Mail wurde mit leeren Vorlagenfeldern versendet (‚产品：/ 数量：/ 期望交期：‘ = Artikel, Menge, Liefertermin leer). | Vor der Freigabe leere Platzhalter erkennen und blockieren. |
| **hoch** | [496-rechnung-bezahlt](seiten/496-rechnung-bezahlt.md) | Logik | Rechnung ist bezahlt und ‚Zahlung freigegeben‘, aber noch nicht geprüft (‚Als geprüft markieren‘) – Prüfung nach Zahlung. | Reihenfolge erzwingen: prüfen → freigeben → zahlen. |
| **hoch** | [497-kurse](seiten/497-kurse.md) | Daten | CHF und GBP zeigen ‚1.0000 – kein Kurs erfasst‘: ein fehlender Kurs wird als 1:1 dargestellt (und ggf. gerechnet). | Fehlenden Kurs als ‚—‘ + Warnung; Bestellungen in dieser Währung blockieren. |
| **hoch** | [500-transfers](seiten/500-transfers.md) | Status | Offene Wareneingänge mit Termin 16.10.2025 (ein Jahr alt) stehen als ‚BEREIT‘ ohne Überfällig-Kennzeichnung neben aktuellen. | Überfällige Termine rot, Sortierung ‚überfällig zuerst‘, Filter. |
| **hoch** | [530-bewertung](seiten/530-bewertung.md) | Daten | ‚Mengenabweichungen 0 — Bestand und Bewertung im Gleichlauf‘, obwohl negative Bestände existieren (Prozesstest Gerät −1 mit Wert 0,00 €, Switch −12.902 fehlt in der Liste). | Negative Bestände als Abweichung zählen und anzeigen. |
| **hoch** | [540-beschaffung](seiten/540-beschaffung.md) | Logik | Nur 1 Vorschlag (Testartikel), während der Bestand 9 Produkte in Unterdeckung zeigt (Switch −70.452 Prognose): Komponenten ohne Meldebestand-Regel erzeugen nie einen Vorschlag. | Vorschläge auch aus Unterdeckung (Bedarf aus Fertigung) – oder Hinweis ‚9 Produkte in Unterdeckung ohne Regel‘. |
| **hoch** | [600-reparaturen](seiten/600-reparaturen.md) | Status | RMA/00001 ‚In Reparatur‘ seit 16.12.2025 und neun ‚Repariert‘-Aufträge seit Monaten nicht zurückgesendet – keine Kennzeichnung von Liegezeit/Überfälligkeit. | Spalte ‚seit‘ + Warnfarbe ab X Tagen; Filter ‚hängt‘. |
| **hoch** | [601-reparatur-neu](seiten/601-reparatur-neu.md) | Layout | Das Prozessdiagramm (≈ 600 px, Schrift unlesbar) steht vor dem Fehlerbild und den Teilen – das Wichtigste beginnt erst unterhalb des Falzes. | Kompakter Stepper oben, Diagramm einklappbar unten. |
| **hoch** | [604-reparatur-repariert](seiten/604-reparatur-repariert.md) | Logik | Bei kostenpflichtiger Reparatur entsteht das Angebot erst nach der Reparatur (Verlauf: abgeschlossen → Angebot S00143); ‚Angebot erstellen‘ wird trotz vorhandenem Angebot weiter angeboten. | Kostenvoranschlag/Freigabe vor Reparaturbeginn; ‚Angebot erstellen‘ ausblenden, wenn vorhanden (Link stattdessen). |
| **hoch** | [800-mengen](seiten/800-mengen.md) | Daten | Abverkaufsquote über 100 % (122 %, 465 %, 189 %) – Folge negativer Bestände; die Kennzahl ist so unbrauchbar und wird nicht erklärt. | Quote bei negativem Bestand ‚n. v.‘ + Hinweis auf Bestandsfehler. |
| **hoch** | [850-cashflow](seiten/850-cashflow.md) | Logik | ‚Fällig (14 Tage)‘ listet über 100 Kundenrechnungen RE-0001… mit Fälligkeit 30.10.2026 als Einzelzeilen (Seite 9.600 px lang); Ein- und Auszahlungen ohne Vorzeichen/Farbe gemischt. | Getrennte Spalten ‚Eingänge erwartet‘/‚Ausgänge fällig‘, gruppiert nach Tag mit Summen, Top 10 + ‚alle anzeigen‘. |
| **hoch** | [851-umsatzplan](seiten/851-umsatzplan.md) | Logik | Vorschlag liegt durchgehend beim 2,7-fachen des Vorjahres (Okt 9.532 € → 26.173 €) ohne erkennbare Begründung – der Trend ist offensichtlich falsch berechnet oder nicht erklärt. | Wachstumsannahme sichtbar machen (‚+x % ggü. Vorjahr‘) und begrenzen; Methode erklären. |
| **hoch** | [852-vertraege](seiten/852-vertraege.md) | Status | ‚Kündigungsfrist läuft ab: 0 — nichts offen‘, obwohl drei Verträge eine Frist bis 31.10.2026 haben (in 14 Tagen). | Fristen der nächsten 30/60 Tage zählen und hervorheben. |
| **hoch** | [856-steuern](seiten/856-steuern.md) | Status | USt-Voranmeldung 09/2026, fällig 10.10.2026, steht als ‚offen‘ (orange) – sieben Tage überfällig, ohne Überfällig-Kennzeichnung. | Überfällig rot + Hinweis auf der Übersicht. |
| **hoch** | [900-produkte](seiten/900-produkte.md) | Daten | Alle Komponenten zeigen Preis 0,00 € (gemeint: Verkaufspreis, für Einkaufsteile irrelevant) – der Einkaufs-/Einstandspreis fehlt in der Liste; negativer Bestand (Switch −12.902) ohne Warnung. | Spalten je Typ: Verkaufspreis nur für verkaufbare, sonst Ø Einstand; negativer Bestand rot. |
| **hoch** | [901-produkt](seiten/901-produkt.md) | Daten | Steuer Verkauf ‚keine‘ beim Hauptprodukt (Tastatur, 329 €) – falsche Steuerbasis für Rechnungen; keine Warnung. | Pflichtfeld bei verkaufbaren Produkten bzw. Standardsteuer aus Kategorie. |
| **hoch** | [950-integrationen](seiten/950-integrationen.md) | Logik | Shopify steht auf ‚nur lesen‘, trotzdem melden die Outbox-Einträge ‚Bestand gemeldet‘ und ‚Fulfillment in Shopify angelegt, Kunde wurde benachrichtigt‘ als ERLEDIGT – widersprüchlich (im Fake-Modus ausgeführt, aber nicht gekennzeichnet). | Übersprungene/simulierte Jobs als ‚übersprungen (nur lesen)‘ bzw. ‚Test‘ markieren. |
| **hoch** | [960-prozesse](seiten/960-prozesse.md) | Leistung | Alle 308 Aktionen untereinander auf einer Seite (20.254 px), ohne Suche, Filter nach Bereich oder Gruppierung; viele Zeilen ungleichmäßig hoch (leere Riesenzeilen). | Gruppierung nach Bereich (einklappbar), Suchfeld, feste Zeilenhöhe. |
| **hoch** | [962-prozess-reparatur](seiten/962-prozess-reparatur.md) | Schritte | ‚Angebot erstellen‘ liegt nach ‚Abschließen‘ – bei kostenpflichtigen Reparaturen fehlt die Freigabe des Kostenvoranschlags vor Reparaturbeginn. | Entscheidung ‚kostenpflichtig?‘ vor ‚Reparatur beginnen‘ mit Schritt ‚Kostenvoranschlag freigeben‘. |
| **hoch** | [964-assistent-inventur-instanz](seiten/964-assistent-inventur-instanz.md) | Texte | ‚Ergebnisse‘ zeigen nur rohe UUIDs (beleg_id, buchen_record_id …) – für Anwender wertlos. | Verlinkte Belege mit Namen (‚Inventurbuchung WH/INV/…, 3 Positionen‘). |
| **hoch** | [966-aktion](seiten/966-aktion.md) | Eingabe | Positionen müssen als JSON (‚{}‘) eingegeben werden – für Anwender unbenutzbar. | Für Listenparameter eine Positionstabelle generieren. |
| **hoch** | [980-einstellungen](seiten/980-einstellungen.md) | Daten | Pflichtangaben für Rechnungen (USt-IdNr., Steuernummer, Geschäftsführung, IBAN) sind leer, während Kundenrechnungen laut Belege-Einstellung bereits ‚scharf‘ laufen – keine Warnung. | Pflichtfelder markieren; scharf schalten erst bei vollständigen Pflichtangaben. |
| **hoch** | [980-einstellungen-belege](seiten/980-einstellungen-belege.md) | Status | Der Rechnungsmodus (heikles Thema laut Betreiber) ist nur eine Auswahl in der dritten Karte mit kleinem Status ‚● SCHARF‘ – kein deutlicher Hinweis, was scharf bedeutet und dass Pflichtangaben fehlen (vgl. Firma). | Eigene Karte ‚Rechnungsmodus‘ ganz oben mit großem Status, Checkliste der Voraussetzungen, Bestätigungsdialog beim Umschalten. |
| **hoch** | [980-einstellungen-benachrichtigungen](seiten/980-einstellungen-benachrichtigungen.md) | Status | Telegram ist nicht konfiguriert; alle Login-Meldungen wurden ‚übersprungen‘ – diese Lücke (vom Betreiber bemerkt: seit 1.10. keine Meldungen) steht nur als kleine graue Zeile. | Rotes Banner ‚Telegram nicht eingerichtet – Meldungen gehen verloren‘ + Hinweis auf der Übersicht. |
| **hoch** | [980-einstellungen-ki](seiten/980-einstellungen-ki.md) | Status | Widerspruch: oben ‚KI ist aus (Schlüssel fehlt)‘, darunter ‚● KI-Zugang vorhanden‘. | Ein gemeinsamer Status je Anbieter. |
| **hoch** | [m01-uebersicht](seiten/m01-uebersicht.md) | Mobil | Das schwebende Befehlsfeld ‚Was möchtest du tun?‘ liegt mitten über den Kacheln und verdeckt beim Scrollen jeweils eine Kachel vollständig (hier ‚Wareneingänge heute erwartet‘). | Am Handy unten fixiert mit Abstand zum Inhalt (padding-bottom) oder als Knopf, der das Feld öffnet. |
| **hoch** | [m07-verkauf-detail](seiten/m07-verkauf-detail.md) | Mobil | Positionstabelle nur seitlich scrollbar (Einzelpreis angeschnitten, Netto/Entfernen erst nach Wischen sichtbar, kein Scroll-Hinweis); Produktnamen brechen Wort für Wort um. | Positionen am Handy als Karten (Name, Menge × Preis, Summe). |
| **hoch** | [m10-navigation](seiten/m10-navigation.md) | Mobil | Das schwebende Befehlsfeld liegt über der geöffneten Navigation und verdeckt Benutzername/‚Abmelden‘. | Befehlsfeld bei offener Navigation ausblenden (z-index). |
| **hoch** | [d03-prozess](seiten/d03-prozess.md) | Barrierefreiheit | Diagramm: Kanten und Knotenrahmen dunkelgrau auf Schwarz praktisch unsichtbar; Zoom-Knöpfe (+/−/Vollbild) als weiße Flächen ohne Symbole. | Diagramm-Tokens für Dunkelmodus (Kanten hell, Knoten mit Rand), Symbole in Zoom-Knöpfen einfärben. |

## Alle Ansichten mit Note

### Anmeldung & öffentliche Seiten (6)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [000-login](seiten/000-login.md) Login | `/login` | 4 |  |  | 1 | 3 |
| [003-login-mobil](seiten/003-login-mobil.md) Login mobil | `/login` | 4 |  |  |  | 1 |
| [001-start](seiten/001-start.md) Start (Weiche) | `/start` | 4 |  |  | 1 | 3 |
| [002-service-reparatur](seiten/002-service-reparatur.md) Öffentliche Reparaturanfrage | `/service/reparatur` | 4 |  |  |  | 3 |
| [004-login-einrichten](seiten/004-login-einrichten.md) Zweiten Faktor einrichten | `/login/einrichten` | 4 |  |  |  | 2 |
| [005-login-code](seiten/005-login-code.md) Zweiter Faktor: Code | `/login/code` | 4 |  |  |  | 2 |

### Kopf & Rahmen (8)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [010-uebersicht](seiten/010-uebersicht.md) Übersicht | `/` | 3 |  | 2 | 3 | 2 |
| [013-aufgaben](seiten/013-aufgaben.md) Aufgaben | `/aufgaben` | 3 |  | 1 | 2 | 2 |
| [015-einrichtung](seiten/015-einrichtung.md) Einrichtung (Onboarding) | `/einrichtung` | 4 |  |  | 1 | 2 |
| [016-befehlsfeld](seiten/016-befehlsfeld.md) Befehlsfeld (Strg+K) | `/` | 3 |  |  | 1 | 2 |
| [011-sprechen](seiten/011-sprechen.md) Sprechen | `/sprechen` | 2 |  |  | 1 | 1 |
| [012-scanner](seiten/012-scanner.md) Scannen | `/scanner` | 3 |  | 1 | 2 | 1 |
| [014-konto](seiten/014-konto.md) Mein Konto | `/konto` | 4 |  |  | 1 | 2 |
| [017-fehler-melden](seiten/017-fehler-melden.md) Fehler melden (Dialog) | `/` | 3 |  |  | 1 | 3 |

### Querschnitt (2)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [A00-rahmen](seiten/A00-rahmen.md) Globaler Rahmen (Seitenleiste, Kopfleiste, Laschen) | `(auf allen Seiten)` | 3 |  | 2 | 4 | 2 |
| [A01-404-seite](seiten/A01-404-seite.md) Fehlerseite „nicht gefunden“ | `/versand/packzettel (ohne Parameter)` | 1 |  | 2 |  |  |

### Verkauf (19)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [100-verkauf](seiten/100-verkauf.md) Verkaufsaufträge | `/verkauf` | 3 |  | 2 | 3 | 1 |
| [101-verkauf-neu](seiten/101-verkauf-neu.md) Neuer Verkaufsauftrag | `/verkauf/neu` | 3 |  |  | 2 | 1 |
| [102-verkauf-entwurf](seiten/102-verkauf-entwurf.md) Auftrag Entwurf | `/verkauf/07aabd81-2887-46fd-b88f-292a1602a629` | 3 |  | 2 | 3 | 2 |
| [103-verkauf-bestaetigt](seiten/103-verkauf-bestaetigt.md) Auftrag bestätigt, offen | `/verkauf/406c7929-0feb-43e1-8ac7-236f175341de` | 3 |  | 2 | 2 | 2 |
| [104-verkauf-teilgeliefert](seiten/104-verkauf-teilgeliefert.md) Auftrag teilgeliefert | `/verkauf/51ae1eca-7d35-41ae-a265-4509e45d738c` | 2 | 1 | 2 | 2 | 1 |
| [105-verkauf-shop-geliefert](seiten/105-verkauf-shop-geliefert.md) Shop-Auftrag geliefert | `/verkauf/bc4fecaf-459c-474c-bd95-4abb395ecf09` | 3 |  | 1 | 3 | 2 |
| [106-verkauf-shop-offen](seiten/106-verkauf-shop-offen.md) Shop-Auftrag offen | `/verkauf/54a8e7f3-3a10-44f2-a8ba-1bf6859c43c9` | 3 |  |  | 2 | 1 |
| [107-verkauf-storniert](seiten/107-verkauf-storniert.md) Auftrag storniert | `/verkauf/e25f721e-e1d3-4dda-8f40-7333fdb91687` | 2 |  | 2 | 2 | 1 |
| [110-rechnungen](seiten/110-rechnungen.md) Kundenrechnungen | `/verkauf/rechnungen` | 2 |  | 3 | 3 | 1 |
| [111-rechnungen-probelauf](seiten/111-rechnungen-probelauf.md) Rechnungen Probelauf | `/verkauf/rechnungen?filter=probelauf` | 3 |  |  | 2 | 1 |
| [112-rechnung-offen](seiten/112-rechnung-offen.md) Rechnung offen | `/verkauf/rechnungen/3b91381c-6b95-4b9a-b1e2-b2e982454714` | 3 |  | 2 | 2 | 1 |
| [113-rechnung-bezahlt](seiten/113-rechnung-bezahlt.md) Rechnung bezahlt | `/verkauf/rechnungen/c4dd6c57-804e-467b-801a-ac54be55d55e` | 3 |  | 1 |  | 2 |
| [114-rechnung-storniert](seiten/114-rechnung-storniert.md) Rechnung storniert | `/verkauf/rechnungen/bd7aed67-d564-4874-8fe1-7b9f0e2d6bd7` | 4 |  |  |  | 2 |
| [115-gutschrift](seiten/115-gutschrift.md) Gutschrift | `/verkauf/rechnungen/37c43ba0-0427-4451-a1d4-1b741f36f201` | 3 |  |  | 2 | 1 |
| [120-vorgaenge](seiten/120-vorgaenge.md) Vorgänge | `/vorgaenge` | 3 |  | 1 | 2 | 1 |
| [121-vorgaenge-anfrage](seiten/121-vorgaenge-anfrage.md) Vorgänge: Anfragen | `/vorgaenge/prozess/anfrage` | 3 |  |  | 2 | 1 |
| [122-vorgang-anfrage-gewonnen](seiten/122-vorgang-anfrage-gewonnen.md) Anfrage gewonnen | `/vorgaenge/71db7ae8-004e-4502-8a96-44e4647821ff` | 2 |  | 1 | 1 | 1 |
| [123-vorgang-anfrage-abgelehnt](seiten/123-vorgang-anfrage-abgelehnt.md) Anfrage abgelehnt | `/vorgaenge/ab7c041b-1931-4c21-8d3e-6cf8b1220eb0` | 2 |  | 1 | 1 | 1 |
| [130-shop-verfuegbarkeit](seiten/130-shop-verfuegbarkeit.md) Shop-Verfügbarkeit | `/verkauf/shop-verfuegbarkeit` | 2 |  | 1 | 2 | 2 |

### Versand & Retouren (14)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [200-versand](seiten/200-versand.md) Versand | `/versand` | 3 |  | 1 | 3 | 2 |
| [201-packzettel](seiten/201-packzettel.md) Packzettel | `/versand/packzettel?ids=965d2049-9eac-4716-af8a-d0bbd9101dc1` | 4 |  |  | 1 | 1 |
| [202-kommissionieren](seiten/202-kommissionieren.md) Kommissionieren | `/kommissionieren` | 4 |  |  |  | 2 |
| [203-kommissionieren-beleg](seiten/203-kommissionieren-beleg.md) Kommissionieren: Lieferung | `/kommissionieren/965d2049-9eac-4716-af8a-d0bbd9101dc1` | 4 |  |  | 1 | 1 |
| [204-packtisch](seiten/204-packtisch.md) Packtisch | `/packtisch` | 3 |  |  | 1 | 1 |
| [210-retouren](seiten/210-retouren.md) Retouren (offen) | `/versand/retouren` | 3 |  |  | 3 | 1 |
| [211-retouren-alle](seiten/211-retouren-alle.md) Retouren (alle) | `/versand/retouren?filter=alle` | 3 |  |  |  | 2 |
| [212-retoure-neu](seiten/212-retoure-neu.md) Retoure anlegen | `/versand/retouren/neu?auftrag=bc4fecaf-459c-474c-bd95-4abb39` | 4 |  |  |  | 2 |
| [213-retoure-angefragt](seiten/213-retoure-angefragt.md) Retoure angefragt | `/versand/retouren/39f611c8-b4c9-420d-8359-4f0169ce4878` | 3 |  | 2 |  | 1 |
| [214-retoure-genehmigt](seiten/214-retoure-genehmigt.md) Retoure genehmigt | `/versand/retouren/2e78eceb-0750-400d-9e9c-697bdace3bc8` | 3 |  | 1 |  | 1 |
| [215-retoure-eingegangen](seiten/215-retoure-eingegangen.md) Retoure eingegangen (Prüfmaske) | `/versand/retouren/c00cb487-bab9-43eb-a40e-c0b48a5965ce` | 3 |  |  | 2 | 1 |
| [216-retoure-geprueft](seiten/216-retoure-geprueft.md) Retoure geprüft | `/versand/retouren/618ea911-e6a1-46bc-8066-f31626fd623a` | 3 |  |  | 2 | 1 |
| [217-retoure-abgeschlossen](seiten/217-retoure-abgeschlossen.md) Retoure abgeschlossen | `/versand/retouren/c6a68e05-c786-4cba-a9be-13ec386c3fa9` | 3 |  |  | 1 | 1 |
| [218-retoure-abgelehnt](seiten/218-retoure-abgelehnt.md) Retoure abgelehnt | `/versand/retouren/2d91a0d6-d9a1-48e1-87c0-e0067f325137` | 3 |  |  | 1 | 1 |

### Fertigung (10)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [300-fertigung](seiten/300-fertigung.md) Fertigungsaufträge | `/fertigung` | 2 | 1 | 2 | 2 | 1 |
| [301-mo-bestaetigt](seiten/301-mo-bestaetigt.md) Fertigungsauftrag bestätigt | `/fertigung/21a0df87-9110-4861-a0d6-4addb502d37f` | 3 |  | 2 | 2 | 2 |
| [302-mo-fertig](seiten/302-mo-fertig.md) Fertigungsauftrag fertig | `/fertigung/efb62574-d480-433e-a5c5-e72353938598` | 4 |  |  | 1 | 2 |
| [303-mo-storniert](seiten/303-mo-storniert.md) Fertigungsauftrag storniert | `/fertigung/8bfed4f1-b6c4-49de-80d0-1652e52c2fdd` | 3 |  |  | 1 | 2 |
| [304-mo-druck](seiten/304-mo-druck.md) Fertigungszettel (Druck) | `/fertigung/21a0df87-9110-4861-a0d6-4addb502d37f/druck` | 4 |  |  |  | 2 |
| [305-fertigung-druck](seiten/305-fertigung-druck.md) Sammeldruck Fertigung | `/fertigung/druck?ids=d935247e-e20a-4e0c-9121-ac09081e25e8,06` | 4 |  |  | 1 | 1 |
| [310-stuecklisten](seiten/310-stuecklisten.md) Stücklisten | `/fertigung/stuecklisten` | 4 |  |  |  | 2 |
| [311-stueckliste](seiten/311-stueckliste.md) Stückliste Detail | `/fertigung/stuecklisten/33734b9f-22e9-470e-b4d1-af22725a4bc6` | 3 |  |  | 3 | 1 |
| [320-arbeitsplaetze](seiten/320-arbeitsplaetze.md) Arbeitsplätze | `/fertigung/arbeitsplaetze` | 4 |  |  | 1 | 2 |
| [330-demontage](seiten/330-demontage.md) Demontage | `/fertigung/demontage` | 3 |  |  |  | 1 |

### Einkauf (31)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [400-cockpit](seiten/400-cockpit.md) Einkaufs-Cockpit | `/einkauf/cockpit` | 2 |  | 1 | 1 |  |
| [401-bestellungen](seiten/401-bestellungen.md) Bestellungen | `/einkauf` | 2 |  | 1 | 2 | 1 |
| [402-bestellung-entwurf](seiten/402-bestellung-entwurf.md) Bestellung Entwurf | `/einkauf/5bc27194-bc16-4caa-92f3-74c768c084c4` | 2 | 1 | 2 | 1 | 1 |
| [403-bestellung-bestellt](seiten/403-bestellung-bestellt.md) Bestellung bestellt | `/einkauf/6a588a64-e29f-4096-8214-dc7cc8e06e08` | 3 |  |  | 2 | 1 |
| [410-projekte](seiten/410-projekte.md) Einkaufsprojekte | `/einkauf/projekte` | 3 |  |  | 1 | 1 |
| [411-projekt-bedarf](seiten/411-projekt-bedarf.md) Projekt Bedarf | `/einkauf/projekte/239acd9e-0634-47b1-98f2-aa8fb4656070` | 2 |  | 2 | 1 | 1 |
| [412-projekt-bestellt](seiten/412-projekt-bestellt.md) Projekt bestellt | `/einkauf/projekte/40c0534e-acd7-4069-82c5-92af745c03f2` | 2 | 1 |  | 2 | 1 |
| [413-projekt-abgeschlossen](seiten/413-projekt-abgeschlossen.md) Projekt abgeschlossen | `/einkauf/projekte/7ed478f9-77c4-4a80-b1df-3f4ea57e4bb5` | 2 |  | 1 |  | 1 |
| [420-sendungen](seiten/420-sendungen.md) Sendungen & Zoll | `/einkauf/sendungen` | 3 |  |  | 1 | 2 |
| [421-sendung-abgerechnet](seiten/421-sendung-abgerechnet.md) Sendung abgerechnet | `/einkauf/sendungen/344200ba-2a6e-4a7d-9d0e-9eb2a54ac782` | 2 |  | 1 | 2 | 1 |
| [422-sendung-storniert](seiten/422-sendung-storniert.md) Sendung storniert | `/einkauf/sendungen/8f851b7f-24e9-4bda-9152-3146615549df` | 3 |  |  |  | 1 |
| [430-muster](seiten/430-muster.md) Muster | `/einkauf/muster` | 4 |  |  |  | 1 |
| [431-muster-offen](seiten/431-muster-offen.md) Muster offen | `/einkauf/muster/db9ff490-c7f2-4674-bba3-84f3e3b43573` | 3 |  | 1 | 2 |  |
| [432-muster-nachbessern](seiten/432-muster-nachbessern.md) Muster nachbessern | `/einkauf/muster/54f6f3ec-1abd-4544-bd30-4407016b124b` | 3 |  |  | 1 | 1 |
| [433-muster-freigegeben](seiten/433-muster-freigegeben.md) Muster freigegeben | `/einkauf/muster/a1c53e09-fef9-4c9a-ae80-77b22d6b765f` | 4 |  |  |  | 1 |
| [440-posteingang](seiten/440-posteingang.md) Posteingang | `/einkauf/posteingang` | 3 |  | 2 |  | 1 |
| [441-thread](seiten/441-thread.md) Mail-Thread | `/einkauf/posteingang/f94cf301-8fd2-4c6e-bf39-0fa7b5a54176` | 3 |  |  | 2 | 1 |
| [450-entwuerfe](seiten/450-entwuerfe.md) Mail-Entwürfe | `/einkauf/entwuerfe` | 4 |  |  |  | 1 |
| [451-entwurf-gesendet](seiten/451-entwurf-gesendet.md) Entwurf gesendet | `/einkauf/entwuerfe/6767e71e-4e63-43f2-afad-7a40986e6e36` | 2 |  | 1 | 1 |  |
| [460-wiedervorlagen](seiten/460-wiedervorlagen.md) Wiedervorlagen | `/einkauf/wiedervorlagen` | 3 |  |  | 1 | 1 |
| [470-lieferanten](seiten/470-lieferanten.md) Lieferanten | `/einkauf/lieferanten` | 3 |  |  | 1 | 1 |
| [471-lieferant](seiten/471-lieferant.md) Lieferantenakte | `/einkauf/lieferanten/fc150acc-f35e-47d4-ad63-55beff6db61e` | 3 |  |  | 2 | 1 |
| [480-vertraege](seiten/480-vertraege.md) Lieferantenverträge | `/einkauf/vertraege` | 3 |  |  |  | 2 |
| [481-vertrag](seiten/481-vertrag.md) Lieferantenvertrag | `/einkauf/vertraege/f036deed-78df-49a2-a861-877d988b7aa1` | 3 |  |  | 2 | 1 |
| [490-werkzeuge](seiten/490-werkzeuge.md) Werkzeuge & Formen | `/einkauf/werkzeuge` | 3 |  |  |  | 2 |
| [491-werkzeug](seiten/491-werkzeug.md) Werkzeug Detail | `/einkauf/werkzeuge/6855229d-8aa5-42b9-bbbc-cd453c9f83b6` | 3 |  |  |  | 1 |
| [495-rechnungen](seiten/495-rechnungen.md) Lieferantenrechnungen | `/einkauf/rechnungen` | 3 |  |  | 1 | 1 |
| [496-rechnung-bezahlt](seiten/496-rechnung-bezahlt.md) Lieferantenrechnung bezahlt | `/einkauf/rechnungen/2cbcc1c5-ed66-4c01-b30e-9909b98981a3` | 3 |  | 1 |  | 1 |
| [497-kurse](seiten/497-kurse.md) Wechselkurse | `/einkauf/kurse` | 2 |  | 1 | 1 | 1 |
| [498-einstand](seiten/498-einstand.md) Einstand (Fracht & Zoll) | `/einkauf/einstand` | 3 |  |  | 1 | 1 |
| [499-datev](seiten/499-datev.md) DATEV (Einkauf) | `/einkauf/datev` | 3 |  |  |  | 2 |

### Lager (13)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [500-transfers](seiten/500-transfers.md) Transfers | `/lager` | 3 |  | 1 | 1 | 1 |
| [501-lieferung-bereit](seiten/501-lieferung-bereit.md) Lieferung bereit | `/lager/965d2049-9eac-4716-af8a-d0bbd9101dc1` | 3 |  |  | 2 | 1 |
| [502-lieferung-wartet](seiten/502-lieferung-wartet.md) Lieferung wartet | `/lager/ce846d9b-c0a3-4b94-836c-2b6683e2ac89` | 2 | 1 |  | 1 |  |
| [503-lieferung-erledigt](seiten/503-lieferung-erledigt.md) Lieferung erledigt | `/lager/06fb02ad-95ae-4ec4-b0e2-b64ed72deb44` | 3 |  |  | 1 | 1 |
| [504-wareneingang-bereit](seiten/504-wareneingang-bereit.md) Wareneingang bereit | `/lager/5227afa1-17ba-4ca2-b22a-5450d998def2` | 3 |  |  | 2 |  |
| [505-transfer-druck](seiten/505-transfer-druck.md) Lieferschein (Druck) | `/lager/06fb02ad-95ae-4ec4-b0e2-b64ed72deb44/druck` | 4 |  |  |  | 1 |
| [510-zulauf](seiten/510-zulauf.md) Zulauf | `/lager/zulauf` | 3 |  |  | 2 | 1 |
| [520-bestand](seiten/520-bestand.md) Bestand | `/lager/bestand` | 2 | 1 |  | 1 | 1 |
| [530-bewertung](seiten/530-bewertung.md) Bewertung | `/lager/bewertung` | 3 |  | 1 | 1 | 2 |
| [540-beschaffung](seiten/540-beschaffung.md) Beschaffung | `/lager/beschaffung` | 2 |  | 1 | 1 |  |
| [550-lose](seiten/550-lose.md) Lose & Serien | `/lager/lose` | 4 |  |  |  | 1 |
| [551-los](seiten/551-los.md) Los / Seriennummer | `/lager/lose/c9cffe5b-d524-458c-a1c4-81f9d5dddfb1` | 3 |  |  |  | 1 |
| [560-inventur](seiten/560-inventur.md) Inventur | `/lager/inventur` | 3 |  |  | 1 | 1 |

### Service (10)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [600-reparaturen](seiten/600-reparaturen.md) Reparaturen | `/reparatur` | 3 |  | 1 | 2 |  |
| [601-reparatur-neu](seiten/601-reparatur-neu.md) Reparatur neu | `/reparatur/a76297c3-64de-4118-8661-e8a61e42ca21` | 3 |  | 1 | 1 |  |
| [602-reparatur-wartet](seiten/602-reparatur-wartet.md) Reparatur wartet auf Gerät | `/reparatur/85b8358f-79d7-474e-9b7a-50153a93c8c1` | 4 |  |  |  | 1 |
| [603-reparatur-inarbeit](seiten/603-reparatur-inarbeit.md) Reparatur in Arbeit | `/reparatur/7ba986b2-d7ac-4199-b3a7-b28d3941993f` | 3 |  |  | 1 |  |
| [604-reparatur-repariert](seiten/604-reparatur-repariert.md) Reparatur repariert | `/reparatur/b91fc0d6-57dd-4d8a-9de8-6c7c88658f0a` | 2 |  | 1 |  | 1 |
| [605-reparatur-versendet](seiten/605-reparatur-versendet.md) Reparatur versendet | `/reparatur/f5891410-ea77-49b4-af17-2e7712f7f14f` | 3 |  |  |  | 2 |
| [606-reparatur-storniert](seiten/606-reparatur-storniert.md) Reparatur storniert | `/reparatur/27216bfe-8031-4a96-ad86-f0860157f3b8` | 3 |  |  | 1 | 1 |
| [610-reparaturanfragen](seiten/610-reparaturanfragen.md) Reparaturanfragen | `/vorgaenge/prozess/reparatur_anfrage` | 3 |  |  | 1 | 1 |
| [611-reparaturanfrage-angenommen](seiten/611-reparaturanfrage-angenommen.md) Reparaturanfrage angenommen | `/vorgaenge/90e93c5e-c158-4586-ba69-32ec995c01e8` | 3 |  |  | 2 |  |
| [612-reparaturanfrage-abgelehnt](seiten/612-reparaturanfrage-abgelehnt.md) Reparaturanfrage abgelehnt | `/vorgaenge/723fb41a-0a64-4f53-b054-1553ec64cd6f` | 3 |  |  | 1 |  |

### Personal (5)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [700-zeiterfassung](seiten/700-zeiterfassung.md) Zeiterfassung | `/zeiterfassung` | 4 |  |  |  | 1 |
| [701-mitarbeiter](seiten/701-mitarbeiter.md) Mitarbeiter | `/personal` | 4 |  |  | 1 | 1 |
| [702-mitarbeiter-detail](seiten/702-mitarbeiter-detail.md) Mitarbeiter Detail | `/personal/6dba678e-deb1-4c67-aa24-8b9ff058ff49` | 3 |  |  | 2 | 1 |
| [703-schichtplan](seiten/703-schichtplan.md) Schichtplan | `/personal/schichtplan` | 3 |  |  | 1 | 1 |
| [704-abwesenheiten](seiten/704-abwesenheiten.md) Abwesenheiten | `/personal/abwesenheiten` | 4 |  |  |  | 1 |

### Auswertungen & Finanzen (10)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [800-mengen](seiten/800-mengen.md) Mengen & Abverkauf | `/auswertungen` | 3 |  | 1 | 2 | 1 |
| [801-kennzahlen](seiten/801-kennzahlen.md) Kennzahlen | `/auswertungen/kennzahlen` | 3 |  |  | 2 | 1 |
| [802-ki](seiten/802-ki.md) KI-Analyse | `/ki` | 4 |  |  |  | 1 |
| [850-cashflow](seiten/850-cashflow.md) Cashflow | `/finanzen` | 2 | 1 | 1 | 2 | 1 |
| [851-umsatzplan](seiten/851-umsatzplan.md) Umsatzplan | `/finanzen/plan` | 2 |  | 1 | 1 | 1 |
| [852-vertraege](seiten/852-vertraege.md) Verträge | `/finanzen/vertraege` | 3 |  | 1 |  | 1 |
| [853-vertrag](seiten/853-vertrag.md) Vertrag Detail | `/finanzen/vertraege/3d3c7a17-7e93-4269-aa93-daa8230db2c7` | 3 |  |  | 1 | 1 |
| [854-darlehen](seiten/854-darlehen.md) Darlehen | `/finanzen/darlehen` | 4 |  |  |  | 1 |
| [855-darlehen-detail](seiten/855-darlehen-detail.md) Darlehen Detail | `/finanzen/darlehen/b7a12ed4-5002-4c76-a9b3-967b5f1f6015` | 3 |  |  | 1 | 1 |
| [856-steuern](seiten/856-steuern.md) Steuern | `/finanzen/steuern` | 3 |  | 1 |  | 1 |

### Stammdaten & System (56)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [900-produkte](seiten/900-produkte.md) Produkte | `/produkte` | 2 |  | 1 | 2 | 1 |
| [901-produkt](seiten/901-produkt.md) Produkt Detail | `/produkte/f43c725d-1d86-4bae-821d-ad94d321acfc` | 2 |  | 1 | 1 | 1 |
| [902-variante](seiten/902-variante.md) Variante Detail | `/produkte/variante/dd0e4dc7-bb52-4461-868d-acc46b654999` | 3 |  |  | 1 | 1 |
| [903-attribute](seiten/903-attribute.md) Attribute | `/produkte/attribute` | 4 |  |  |  | 1 |
| [904-konfiguration](seiten/904-konfiguration.md) Produktkonfiguration | `/produkte/konfiguration` | 3 |  |  | 1 | 1 |
| [910-kontakte](seiten/910-kontakte.md) Kontakte | `/kontakte` | 3 |  |  | 2 | 1 |
| [911-kontakt-firma](seiten/911-kontakt-firma.md) Kontakt Firma (Kunde) | `/kontakte/e20716fd-b07d-4842-a351-ba5287364a19` | 3 |  |  | 2 | 1 |
| [912-kontakt-lieferant](seiten/912-kontakt-lieferant.md) Kontakt Lieferant | `/kontakte/fc150acc-f35e-47d4-ad63-55beff6db61e` | 3 |  |  |  | 1 |
| [950-integrationen](seiten/950-integrationen.md) Integrationen | `/integrationen` | 2 |  | 1 | 2 | 1 |
| [951-integrationen-import](seiten/951-integrationen-import.md) Import | `/integrationen/import` | 3 |  |  |  | 1 |
| [952-integrationen-historie](seiten/952-integrationen-historie.md) Historie aus Shopify | `/integrationen/historie` | 3 |  |  | 1 | 1 |
| [953-integrationen-transaktionen](seiten/953-integrationen-transaktionen.md) Transaktionen | `/integrationen/transaktionen` | 3 |  |  | 1 | 1 |
| [960-prozesse](seiten/960-prozesse.md) Prozesse | `/prozesse` | 2 |  | 1 | 2 | 1 |
| [962-prozess-anfrage](seiten/962-prozess-anfrage.md) Prozessdefinition „Anfrage (Muster-Vorgang)“ | `/prozesse/anfrage` | 4 |  |  | 2 | 2 |
| [962-prozess-artikel_anlegen](seiten/962-prozess-artikel_anlegen.md) Prozessdefinition „Artikel anlegen“ | `/prozesse/artikel_anlegen` | 4 |  |  | 2 | 2 |
| [962-prozess-bemusterung](seiten/962-prozess-bemusterung.md) Prozessdefinition „Bemusterung“ | `/prozesse/bemusterung` | 3 |  |  | 2 | 2 |
| [962-prozess-bug_ticket](seiten/962-prozess-bug_ticket.md) Prozessdefinition „Fehlerticket“ | `/prozesse/bug_ticket` | 4 |  |  | 2 | 2 |
| [962-prozess-eingangs_sendung](seiten/962-prozess-eingangs_sendung.md) Prozessdefinition „Eingangssendung“ | `/prozesse/eingangs_sendung` | 3 |  |  | 2 | 1 |
| [962-prozess-einkauf_wareneingang_rechnung](seiten/962-prozess-einkauf_wareneingang_rechnung.md) Prozessdefinition „Einkauf → Rechnung“ | `/prozesse/einkauf_wareneingang_rechnung` | 3 |  |  | 3 | 1 |
| [962-prozess-einkaufsprojekt](seiten/962-prozess-einkaufsprojekt.md) Prozessdefinition „Einkaufsprojekt“ | `/prozesse/einkaufsprojekt` | 3 |  |  | 2 | 1 |
| [962-prozess-fertigung](seiten/962-prozess-fertigung.md) Prozessdefinition „Fertigungsauftrag“ | `/prozesse/fertigung` | 3 |  |  | 2 | 1 |
| [962-prozess-inventur](seiten/962-prozess-inventur.md) Prozessdefinition „Inventur“ | `/prozesse/inventur` | 4 |  |  | 2 | 1 |
| [962-prozess-kundenrechnung](seiten/962-prozess-kundenrechnung.md) Prozessdefinition „Kundenrechnung“ | `/prozesse/kundenrechnung` | 3 |  |  | 3 | 1 |
| [962-prozess-lieferantenrechnung](seiten/962-prozess-lieferantenrechnung.md) Prozessdefinition „Lieferantenrechnung“ | `/prozesse/lieferantenrechnung` | 3 |  |  | 3 | 1 |
| [962-prozess-mail_versand](seiten/962-prozess-mail_versand.md) Prozessdefinition „Mail an Lieferanten“ | `/prozesse/mail_versand` | 4 |  |  | 2 | 2 |
| [962-prozess-reparatur](seiten/962-prozess-reparatur.md) Prozessdefinition „Reparatur“ | `/prozesse/reparatur` | 3 |  | 1 | 2 | 2 |
| [962-prozess-reparatur_anfrage](seiten/962-prozess-reparatur_anfrage.md) Prozessdefinition „Reparaturanfrage“ | `/prozesse/reparatur_anfrage` | 4 |  |  | 2 | 1 |
| [962-prozess-retoure](seiten/962-prozess-retoure.md) Prozessdefinition „Retoure“ | `/prozesse/retoure` | 4 |  |  | 2 | 2 |
| [962-prozess-shopify_bestellung_versand](seiten/962-prozess-shopify_bestellung_versand.md) Prozessdefinition „Lieferung & Versand“ | `/prozesse/shopify_bestellung_versand` | 3 |  |  | 3 | 1 |
| [962-prozess-verkauf](seiten/962-prozess-verkauf.md) Prozessdefinition „Verkauf (manuell)“ | `/prozesse/verkauf` | 3 |  |  | 3 | 1 |
| [962-prozess-vertrag_fixkosten](seiten/962-prozess-vertrag_fixkosten.md) Prozessdefinition „Fixkosten-Vertrag“ | `/prozesse/vertrag_fixkosten` | 4 |  |  | 2 | 2 |
| [962-prozess-wareneingang](seiten/962-prozess-wareneingang.md) Prozessdefinition „Wareneingang“ | `/prozesse/wareneingang` | 4 |  |  | 2 | 2 |
| [961-werkstatt](seiten/961-werkstatt.md) Prozess-Werkstatt | `/prozesse/werkstatt` | 3 |  |  | 1 | 1 |
| [963-assistent-inventur](seiten/963-assistent-inventur.md) Assistent: Inventur | `/p/inventur` | 3 |  |  | 1 | 1 |
| [964-assistent-inventur-instanz](seiten/964-assistent-inventur-instanz.md) Assistent-Instanz Inventur | `/p/inventur/570a4d48-36a4-4cdd-9247-7ca4c7d06a40` | 2 |  | 1 | 1 |  |
| [965-assistent-artikel](seiten/965-assistent-artikel.md) Assistent: Artikel anlegen | `/p/artikel_anlegen` | 3 |  |  |  | 1 |
| [966-aktion](seiten/966-aktion.md) Aktionsmaske (generiert) | `/aktion/verkauf.auftrag_mit_positionen` | 2 |  | 1 | 1 |  |
| [970-tickets](seiten/970-tickets.md) Tickets | `/tickets` | 4 |  |  |  | 1 |
| [971-ticket-behoben](seiten/971-ticket-behoben.md) Ticket behoben | `/tickets/804970e4-cc7c-4023-b23d-ef00fefe40a0` | 3 |  |  |  | 1 |
| [980-einstellungen](seiten/980-einstellungen.md) Einstellungen (Firma) | `/einstellungen` | 3 |  | 1 | 1 | 1 |
| [980-einstellungen-anbindungen](seiten/980-einstellungen-anbindungen.md) Anbindungen | `/einstellungen/anbindungen` | 3 |  |  | 2 | 1 |
| [980-einstellungen-arbeitsplaetze](seiten/980-einstellungen-arbeitsplaetze.md) Arbeitsplätze & Drucker | `/einstellungen/arbeitsplaetze` | 3 |  |  | 1 | 1 |
| [980-einstellungen-belege](seiten/980-einstellungen-belege.md) Belege & Freigaben | `/einstellungen/belege` | 3 |  | 1 | 1 | 1 |
| [980-einstellungen-benachrichtigungen](seiten/980-einstellungen-benachrichtigungen.md) Benachrichtigungen | `/einstellungen/benachrichtigungen` | 3 |  | 1 |  | 1 |
| [980-einstellungen-benutzer](seiten/980-einstellungen-benutzer.md) Benutzer | `/einstellungen/benutzer` | 3 |  |  | 1 | 1 |
| [980-einstellungen-finanzen](seiten/980-einstellungen-finanzen.md) Finanz-Parameter | `/einstellungen/finanzen` | 3 |  |  | 1 |  |
| [980-einstellungen-gefahrenzone](seiten/980-einstellungen-gefahrenzone.md) Gefahrenzone | `/einstellungen/gefahrenzone` | 4 |  |  |  | 1 |
| [980-einstellungen-kartonagen](seiten/980-einstellungen-kartonagen.md) Kartonagen | `/einstellungen/kartonagen` | 3 |  |  |  | 1 |
| [980-einstellungen-ki](seiten/980-einstellungen-ki.md) KI-Modelle | `/einstellungen/ki` | 3 |  | 1 | 1 |  |
| [980-einstellungen-nutzung](seiten/980-einstellungen-nutzung.md) Nutzung | `/einstellungen/nutzung` | 3 |  |  |  | 1 |
| [980-einstellungen-odoo](seiten/980-einstellungen-odoo.md) Odoo-Übernahme | `/einstellungen/odoo` | 3 |  |  | 1 | 1 |
| [980-einstellungen-registrierungen](seiten/980-einstellungen-registrierungen.md) Registrierungen | `/einstellungen/registrierungen` | 4 |  |  |  | 1 |
| [980-einstellungen-sicherheit](seiten/980-einstellungen-sicherheit.md) Sicherheit | `/einstellungen/sicherheit` | 4 |  |  |  | 1 |
| [980-einstellungen-stammdaten](seiten/980-einstellungen-stammdaten.md) Stammdaten-Einstellungen | `/einstellungen/stammdaten` | 3 |  |  |  | 1 |
| [980-einstellungen-versand](seiten/980-einstellungen-versand.md) Versand-Einstellungen | `/einstellungen/versand` | 3 |  |  |  | 1 |
| [980-einstellungen-versandregeln](seiten/980-einstellungen-versandregeln.md) Versandregeln | `/einstellungen/versandregeln` | 3 |  |  | 1 | 1 |

### Mobil (390 px) (10)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [m01-uebersicht](seiten/m01-uebersicht.md) Übersicht (mobil) | `/` | 3 |  | 1 | 2 |  |
| [m02-scanner](seiten/m02-scanner.md) Scanner (mobil) | `/scanner` | 3 |  |  | 1 | 1 |
| [m03-packtisch](seiten/m03-packtisch.md) Packtisch (mobil) | `/packtisch` | 3 |  |  |  | 1 |
| [m04-kommissionieren](seiten/m04-kommissionieren.md) Kommissionieren (mobil) | `/kommissionieren` | 4 |  |  |  | 1 |
| [m05-aufgaben](seiten/m05-aufgaben.md) Aufgaben (mobil) | `/aufgaben` | 3 |  |  | 2 | 1 |
| [m06-sprechen](seiten/m06-sprechen.md) Sprechen (mobil) | `/sprechen` | 3 |  |  |  | 1 |
| [m07-verkauf-detail](seiten/m07-verkauf-detail.md) Verkaufsauftrag (mobil) | `/verkauf/406c7929-0feb-43e1-8ac7-236f175341de` | 2 |  | 1 | 1 |  |
| [m08-retoure-pruefen](seiten/m08-retoure-pruefen.md) Retoure prüfen (mobil) | `/versand/retouren/c00cb487-bab9-43eb-a40e-c0b48a5965ce` | 3 |  |  | 1 | 1 |
| [m09-zeiterfassung](seiten/m09-zeiterfassung.md) Zeiterfassung (mobil) | `/zeiterfassung` | 4 |  |  |  | 1 |
| [m10-navigation](seiten/m10-navigation.md) Navigation offen (mobil) | `/` | 3 |  | 1 | 1 | 1 |

### Dunkelmodus (4)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [d01-uebersicht](seiten/d01-uebersicht.md) Übersicht (dunkel) | `/` | 4 |  |  |  | 1 |
| [d02-verkauf](seiten/d02-verkauf.md) Verkaufsauftrag (dunkel) | `/verkauf/406c7929-0feb-43e1-8ac7-236f175341de` | 3 |  |  | 1 |  |
| [d03-prozess](seiten/d03-prozess.md) Prozessdiagramm (dunkel) | `/prozesse/retoure` | 2 |  | 1 |  |  |
| [d04-finanzen](seiten/d04-finanzen.md) Cashflow (dunkel) | `/finanzen` | 3 |  |  |  | 1 |

### Rollen (3)

| Seite | Route | Note | krit. | hoch | mittel | niedrig |
|---|---|---|---|---|---|---|
| [r01-lager-uebersicht](seiten/r01-lager-uebersicht.md) Übersicht als Lager | `/` | 3 |  |  | 1 | 1 |
| [r02-lager-verkauf-verboten](seiten/r02-lager-verkauf-verboten.md) Lager öffnet /verkauf | `/verkauf` | 3 |  |  | 1 |  |
| [r03-fertigung-uebersicht](seiten/r03-fertigung-uebersicht.md) Übersicht als Fertigung | `/` | 3 |  |  | 1 | 1 |

## Design-Tokens (Ist-Stand aus `src/app/globals.css`)

Designsystem „Light Industrial“: Papier & Aluminium, Mono-Beschriftung wie auf einem Typenschild. **Orange = Betrieb** (Primärtasten, LEDs, Laufendes), **Violett = Entscheidung** (Freigaben, Befugnis-Schritte, KI-Schreibvorschläge; bewusst selten). Drei Theme-Zustände: hell, dunkel, System. Schriften: Geist Sans (`--font-sans`) und Geist Mono (`--font-mono`). Radius 6 px / 4 px.

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| `--bg` | #e6e5e0 | #0e0f11 | Werkbank (Seitenhintergrund) |
| `--surface` | #efeee9 | #16181b | Papier (Karten) |
| `--surface-2` | #e4e3dd | #1b1e22 | Aluminium (Tabellenköpfe) |
| `--border` / `--border-strong` | #c7c6c0 / #b0afa8 | #303337 / #4a4c50 | Linien |
| `--text` / `--text-2` / `--text-muted` | #1a1b1d / #46474a / #8a8a84 | #ededea / #c9cace / #85878c | Tinte |
| `--accent` / `--accent-text` / `--accent-soft` | #ff5a1f / #b8431a / #f7e6dd | #ff6b33 / #ff8a5c / #2b1a12 | Betrieb: Primärtaste, Links |
| `--wichtig` / `--wichtig-soft` | #4a3aa7 / #eae7f5 | #9085e9 / #211d33 | Entscheidung (Violett) |
| `--success` / `-soft` | #2f6b45 / #e1e8e0 | #7fa98a / #1a241d | erledigt, aktiv |
| `--warn` / `-soft` | #8a6516 / #eeead9 | #c9a051 / #262013 | Achtung |
| `--danger` / `-soft` | #b23718 / #f2e3db | #e0714d / #2a1a14 | Fehler, destruktiv |
| `--info` / `-soft` | #40566b / #e2e5e8 | #93a7bb / #1a2026 | Hinweis |
| `--display` … `--display-bright` | #0e0f11 … #ededea | #0a0b0d … #ededea | Instrumenten-Display (schwarze Flächen) |

**Beobachtungen zu den Tokens:** Die Palette ist stimmig. Probleme entstehen in der Anwendung: Warnfarbe für alle Zahlen (M15), Display-Flächen für Nicht-Live-Inhalte (M7), `--text-muted` für Labels unter Kontrastgrenze (M8), fehlende Dunkel-Tokens für das Prozessdiagramm (d03) und für Statusetiketten (d02).

## Abdeckung: Route → Screenshot (124 / 124)

Jede Seitenroute des Builds (ohne `/api/*`) mit den Ansichten, die sie zeigen. Dynamische Routen sind je relevantem Belegzustand mehrfach aufgenommen.

| Route | Screenshot(s) |
|---|---|
| `/` | [010-uebersicht](seiten/010-uebersicht.md), [016-befehlsfeld](seiten/016-befehlsfeld.md), [017-fehler-melden](seiten/017-fehler-melden.md), [m01-uebersicht](seiten/m01-uebersicht.md), [m10-navigation](seiten/m10-navigation.md), [d01-uebersicht](seiten/d01-uebersicht.md), [r01-lager-uebersicht](seiten/r01-lager-uebersicht.md), [r03-fertigung-uebersicht](seiten/r03-fertigung-uebersicht.md) |
| `/aktion/[name]` | [966-aktion](seiten/966-aktion.md) |
| `/aufgaben` | [013-aufgaben](seiten/013-aufgaben.md), [m05-aufgaben](seiten/m05-aufgaben.md) |
| `/auswertungen` | [800-mengen](seiten/800-mengen.md) |
| `/auswertungen/kennzahlen` | [801-kennzahlen](seiten/801-kennzahlen.md) |
| `/einkauf` | [401-bestellungen](seiten/401-bestellungen.md) |
| `/einkauf/[id]` | [400-cockpit](seiten/400-cockpit.md), [402-bestellung-entwurf](seiten/402-bestellung-entwurf.md), [403-bestellung-bestellt](seiten/403-bestellung-bestellt.md), [410-projekte](seiten/410-projekte.md), [420-sendungen](seiten/420-sendungen.md), [430-muster](seiten/430-muster.md), [440-posteingang](seiten/440-posteingang.md), [450-entwuerfe](seiten/450-entwuerfe.md), [460-wiedervorlagen](seiten/460-wiedervorlagen.md), [470-lieferanten](seiten/470-lieferanten.md), [480-vertraege](seiten/480-vertraege.md), [490-werkzeuge](seiten/490-werkzeuge.md), [495-rechnungen](seiten/495-rechnungen.md), [497-kurse](seiten/497-kurse.md), [498-einstand](seiten/498-einstand.md), [499-datev](seiten/499-datev.md) |
| `/einkauf/cockpit` | [400-cockpit](seiten/400-cockpit.md) |
| `/einkauf/datev` | [499-datev](seiten/499-datev.md) |
| `/einkauf/einstand` | [498-einstand](seiten/498-einstand.md) |
| `/einkauf/entwuerfe` | [450-entwuerfe](seiten/450-entwuerfe.md) |
| `/einkauf/entwuerfe/[id]` | [451-entwurf-gesendet](seiten/451-entwurf-gesendet.md) |
| `/einkauf/kurse` | [497-kurse](seiten/497-kurse.md) |
| `/einkauf/lieferanten` | [470-lieferanten](seiten/470-lieferanten.md) |
| `/einkauf/lieferanten/[id]` | [471-lieferant](seiten/471-lieferant.md) |
| `/einkauf/muster` | [430-muster](seiten/430-muster.md) |
| `/einkauf/muster/[id]` | [431-muster-offen](seiten/431-muster-offen.md), [432-muster-nachbessern](seiten/432-muster-nachbessern.md), [433-muster-freigegeben](seiten/433-muster-freigegeben.md) |
| `/einkauf/posteingang` | [440-posteingang](seiten/440-posteingang.md) |
| `/einkauf/posteingang/[id]` | [441-thread](seiten/441-thread.md) |
| `/einkauf/projekte` | [410-projekte](seiten/410-projekte.md) |
| `/einkauf/projekte/[id]` | [411-projekt-bedarf](seiten/411-projekt-bedarf.md), [412-projekt-bestellt](seiten/412-projekt-bestellt.md), [413-projekt-abgeschlossen](seiten/413-projekt-abgeschlossen.md) |
| `/einkauf/rechnungen` | [495-rechnungen](seiten/495-rechnungen.md) |
| `/einkauf/rechnungen/[id]` | [496-rechnung-bezahlt](seiten/496-rechnung-bezahlt.md) |
| `/einkauf/sendungen` | [420-sendungen](seiten/420-sendungen.md) |
| `/einkauf/sendungen/[id]` | [421-sendung-abgerechnet](seiten/421-sendung-abgerechnet.md), [422-sendung-storniert](seiten/422-sendung-storniert.md) |
| `/einkauf/vertraege` | [480-vertraege](seiten/480-vertraege.md) |
| `/einkauf/vertraege/[id]` | [481-vertrag](seiten/481-vertrag.md) |
| `/einkauf/werkzeuge` | [490-werkzeuge](seiten/490-werkzeuge.md) |
| `/einkauf/werkzeuge/[id]` | [491-werkzeug](seiten/491-werkzeug.md) |
| `/einkauf/wiedervorlagen` | [460-wiedervorlagen](seiten/460-wiedervorlagen.md) |
| `/einrichtung` | [015-einrichtung](seiten/015-einrichtung.md) |
| `/einstellungen` | [980-einstellungen](seiten/980-einstellungen.md) |
| `/einstellungen/anbindungen` | [980-einstellungen-anbindungen](seiten/980-einstellungen-anbindungen.md) |
| `/einstellungen/arbeitsplaetze` | [980-einstellungen-arbeitsplaetze](seiten/980-einstellungen-arbeitsplaetze.md) |
| `/einstellungen/belege` | [980-einstellungen-belege](seiten/980-einstellungen-belege.md) |
| `/einstellungen/benachrichtigungen` | [980-einstellungen-benachrichtigungen](seiten/980-einstellungen-benachrichtigungen.md) |
| `/einstellungen/benutzer` | [980-einstellungen-benutzer](seiten/980-einstellungen-benutzer.md) |
| `/einstellungen/finanzen` | [980-einstellungen-finanzen](seiten/980-einstellungen-finanzen.md) |
| `/einstellungen/gefahrenzone` | [980-einstellungen-gefahrenzone](seiten/980-einstellungen-gefahrenzone.md) |
| `/einstellungen/kartonagen` | [980-einstellungen-kartonagen](seiten/980-einstellungen-kartonagen.md) |
| `/einstellungen/ki` | [980-einstellungen-ki](seiten/980-einstellungen-ki.md) |
| `/einstellungen/nutzung` | [980-einstellungen-nutzung](seiten/980-einstellungen-nutzung.md) |
| `/einstellungen/odoo` | [980-einstellungen-odoo](seiten/980-einstellungen-odoo.md) |
| `/einstellungen/registrierungen` | [980-einstellungen-registrierungen](seiten/980-einstellungen-registrierungen.md) |
| `/einstellungen/sicherheit` | [980-einstellungen-sicherheit](seiten/980-einstellungen-sicherheit.md) |
| `/einstellungen/stammdaten` | [980-einstellungen-stammdaten](seiten/980-einstellungen-stammdaten.md) |
| `/einstellungen/versand` | [980-einstellungen-versand](seiten/980-einstellungen-versand.md) |
| `/einstellungen/versandregeln` | [980-einstellungen-versandregeln](seiten/980-einstellungen-versandregeln.md) |
| `/fertigung` | [300-fertigung](seiten/300-fertigung.md) |
| `/fertigung/[id]` | [301-mo-bestaetigt](seiten/301-mo-bestaetigt.md), [302-mo-fertig](seiten/302-mo-fertig.md), [303-mo-storniert](seiten/303-mo-storniert.md), [305-fertigung-druck](seiten/305-fertigung-druck.md), [310-stuecklisten](seiten/310-stuecklisten.md), [320-arbeitsplaetze](seiten/320-arbeitsplaetze.md), [330-demontage](seiten/330-demontage.md) |
| `/fertigung/[id]/druck` | [304-mo-druck](seiten/304-mo-druck.md) |
| `/fertigung/arbeitsplaetze` | [320-arbeitsplaetze](seiten/320-arbeitsplaetze.md) |
| `/fertigung/demontage` | [330-demontage](seiten/330-demontage.md) |
| `/fertigung/druck` | [305-fertigung-druck](seiten/305-fertigung-druck.md) |
| `/fertigung/stuecklisten` | [310-stuecklisten](seiten/310-stuecklisten.md) |
| `/fertigung/stuecklisten/[id]` | [311-stueckliste](seiten/311-stueckliste.md) |
| `/finanzen` | [850-cashflow](seiten/850-cashflow.md), [d04-finanzen](seiten/d04-finanzen.md) |
| `/finanzen/darlehen` | [854-darlehen](seiten/854-darlehen.md) |
| `/finanzen/darlehen/[id]` | [855-darlehen-detail](seiten/855-darlehen-detail.md) |
| `/finanzen/plan` | [851-umsatzplan](seiten/851-umsatzplan.md) |
| `/finanzen/steuern` | [856-steuern](seiten/856-steuern.md) |
| `/finanzen/vertraege` | [852-vertraege](seiten/852-vertraege.md) |
| `/finanzen/vertraege/[id]` | [853-vertrag](seiten/853-vertrag.md) |
| `/integrationen` | [950-integrationen](seiten/950-integrationen.md) |
| `/integrationen/historie` | [952-integrationen-historie](seiten/952-integrationen-historie.md) |
| `/integrationen/import` | [951-integrationen-import](seiten/951-integrationen-import.md) |
| `/integrationen/transaktionen` | [953-integrationen-transaktionen](seiten/953-integrationen-transaktionen.md) |
| `/ki` | [802-ki](seiten/802-ki.md) |
| `/kommissionieren` | [202-kommissionieren](seiten/202-kommissionieren.md), [m04-kommissionieren](seiten/m04-kommissionieren.md) |
| `/kommissionieren/[id]` | [203-kommissionieren-beleg](seiten/203-kommissionieren-beleg.md) |
| `/kontakte` | [910-kontakte](seiten/910-kontakte.md) |
| `/kontakte/[id]` | [911-kontakt-firma](seiten/911-kontakt-firma.md), [912-kontakt-lieferant](seiten/912-kontakt-lieferant.md) |
| `/konto` | [014-konto](seiten/014-konto.md) |
| `/lager` | [500-transfers](seiten/500-transfers.md) |
| `/lager/[id]` | [501-lieferung-bereit](seiten/501-lieferung-bereit.md), [502-lieferung-wartet](seiten/502-lieferung-wartet.md), [503-lieferung-erledigt](seiten/503-lieferung-erledigt.md), [504-wareneingang-bereit](seiten/504-wareneingang-bereit.md), [510-zulauf](seiten/510-zulauf.md), [520-bestand](seiten/520-bestand.md), [530-bewertung](seiten/530-bewertung.md), [540-beschaffung](seiten/540-beschaffung.md), [550-lose](seiten/550-lose.md), [560-inventur](seiten/560-inventur.md) |
| `/lager/[id]/druck` | [505-transfer-druck](seiten/505-transfer-druck.md) |
| `/lager/beschaffung` | [540-beschaffung](seiten/540-beschaffung.md) |
| `/lager/bestand` | [520-bestand](seiten/520-bestand.md) |
| `/lager/bewertung` | [530-bewertung](seiten/530-bewertung.md) |
| `/lager/inventur` | [560-inventur](seiten/560-inventur.md) |
| `/lager/lose` | [550-lose](seiten/550-lose.md) |
| `/lager/lose/[id]` | [551-los](seiten/551-los.md) |
| `/lager/zulauf` | [510-zulauf](seiten/510-zulauf.md) |
| `/login` | [000-login](seiten/000-login.md), [003-login-mobil](seiten/003-login-mobil.md) |
| `/login/code` | [005-login-code](seiten/005-login-code.md) |
| `/login/einrichten` | [004-login-einrichten](seiten/004-login-einrichten.md) |
| `/p/[prozess]` | [963-assistent-inventur](seiten/963-assistent-inventur.md), [965-assistent-artikel](seiten/965-assistent-artikel.md) |
| `/p/[prozess]/[instanz]` | [964-assistent-inventur-instanz](seiten/964-assistent-inventur-instanz.md) |
| `/packtisch` | [204-packtisch](seiten/204-packtisch.md), [m03-packtisch](seiten/m03-packtisch.md) |
| `/personal` | [701-mitarbeiter](seiten/701-mitarbeiter.md) |
| `/personal/[id]` | [702-mitarbeiter-detail](seiten/702-mitarbeiter-detail.md), [703-schichtplan](seiten/703-schichtplan.md), [704-abwesenheiten](seiten/704-abwesenheiten.md) |
| `/personal/abwesenheiten` | [704-abwesenheiten](seiten/704-abwesenheiten.md) |
| `/personal/schichtplan` | [703-schichtplan](seiten/703-schichtplan.md) |
| `/produkte` | [900-produkte](seiten/900-produkte.md) |
| `/produkte/[id]` | [901-produkt](seiten/901-produkt.md), [903-attribute](seiten/903-attribute.md), [904-konfiguration](seiten/904-konfiguration.md) |
| `/produkte/attribute` | [903-attribute](seiten/903-attribute.md) |
| `/produkte/konfiguration` | [904-konfiguration](seiten/904-konfiguration.md) |
| `/produkte/variante/[id]` | [902-variante](seiten/902-variante.md) |
| `/prozesse` | [960-prozesse](seiten/960-prozesse.md) |
| `/prozesse/[code]` | [961-werkstatt](seiten/961-werkstatt.md), [962-prozess-anfrage](seiten/962-prozess-anfrage.md), [962-prozess-artikel_anlegen](seiten/962-prozess-artikel_anlegen.md), [962-prozess-bemusterung](seiten/962-prozess-bemusterung.md), [962-prozess-bug_ticket](seiten/962-prozess-bug_ticket.md), [962-prozess-eingangs_sendung](seiten/962-prozess-eingangs_sendung.md), [962-prozess-einkauf_wareneingang_rechnung](seiten/962-prozess-einkauf_wareneingang_rechnung.md), [962-prozess-einkaufsprojekt](seiten/962-prozess-einkaufsprojekt.md), [962-prozess-fertigung](seiten/962-prozess-fertigung.md), [962-prozess-inventur](seiten/962-prozess-inventur.md), [962-prozess-kundenrechnung](seiten/962-prozess-kundenrechnung.md), [962-prozess-lieferantenrechnung](seiten/962-prozess-lieferantenrechnung.md), [962-prozess-mail_versand](seiten/962-prozess-mail_versand.md), [962-prozess-reparatur](seiten/962-prozess-reparatur.md), [962-prozess-reparatur_anfrage](seiten/962-prozess-reparatur_anfrage.md), [962-prozess-retoure](seiten/962-prozess-retoure.md), [962-prozess-shopify_bestellung_versand](seiten/962-prozess-shopify_bestellung_versand.md), [962-prozess-verkauf](seiten/962-prozess-verkauf.md), [962-prozess-vertrag_fixkosten](seiten/962-prozess-vertrag_fixkosten.md), [962-prozess-wareneingang](seiten/962-prozess-wareneingang.md), [d03-prozess](seiten/d03-prozess.md) |
| `/prozesse/werkstatt` | [961-werkstatt](seiten/961-werkstatt.md) |
| `/reparatur` | [600-reparaturen](seiten/600-reparaturen.md) |
| `/reparatur/[id]` | [601-reparatur-neu](seiten/601-reparatur-neu.md), [602-reparatur-wartet](seiten/602-reparatur-wartet.md), [603-reparatur-inarbeit](seiten/603-reparatur-inarbeit.md), [604-reparatur-repariert](seiten/604-reparatur-repariert.md), [605-reparatur-versendet](seiten/605-reparatur-versendet.md), [606-reparatur-storniert](seiten/606-reparatur-storniert.md) |
| `/scanner` | [012-scanner](seiten/012-scanner.md), [m02-scanner](seiten/m02-scanner.md) |
| `/service/reparatur` | [002-service-reparatur](seiten/002-service-reparatur.md) |
| `/sprechen` | [011-sprechen](seiten/011-sprechen.md), [m06-sprechen](seiten/m06-sprechen.md) |
| `/start` | [001-start](seiten/001-start.md) |
| `/tickets` | [970-tickets](seiten/970-tickets.md) |
| `/tickets/[id]` | [971-ticket-behoben](seiten/971-ticket-behoben.md) |
| `/verkauf` | [100-verkauf](seiten/100-verkauf.md), [r02-lager-verkauf-verboten](seiten/r02-lager-verkauf-verboten.md) |
| `/verkauf/[id]` | [101-verkauf-neu](seiten/101-verkauf-neu.md), [102-verkauf-entwurf](seiten/102-verkauf-entwurf.md), [103-verkauf-bestaetigt](seiten/103-verkauf-bestaetigt.md), [104-verkauf-teilgeliefert](seiten/104-verkauf-teilgeliefert.md), [105-verkauf-shop-geliefert](seiten/105-verkauf-shop-geliefert.md), [106-verkauf-shop-offen](seiten/106-verkauf-shop-offen.md), [107-verkauf-storniert](seiten/107-verkauf-storniert.md), [110-rechnungen](seiten/110-rechnungen.md), [111-rechnungen-probelauf](seiten/111-rechnungen-probelauf.md), [130-shop-verfuegbarkeit](seiten/130-shop-verfuegbarkeit.md), [m07-verkauf-detail](seiten/m07-verkauf-detail.md), [d02-verkauf](seiten/d02-verkauf.md) |
| `/verkauf/neu` | [101-verkauf-neu](seiten/101-verkauf-neu.md) |
| `/verkauf/rechnungen` | [110-rechnungen](seiten/110-rechnungen.md), [111-rechnungen-probelauf](seiten/111-rechnungen-probelauf.md) |
| `/verkauf/rechnungen/[id]` | [112-rechnung-offen](seiten/112-rechnung-offen.md), [113-rechnung-bezahlt](seiten/113-rechnung-bezahlt.md), [114-rechnung-storniert](seiten/114-rechnung-storniert.md), [115-gutschrift](seiten/115-gutschrift.md) |
| `/verkauf/shop-verfuegbarkeit` | [130-shop-verfuegbarkeit](seiten/130-shop-verfuegbarkeit.md) |
| `/versand` | [200-versand](seiten/200-versand.md) |
| `/versand/packzettel` | [201-packzettel](seiten/201-packzettel.md) |
| `/versand/retouren` | [210-retouren](seiten/210-retouren.md), [211-retouren-alle](seiten/211-retouren-alle.md) |
| `/versand/retouren/[id]` | [212-retoure-neu](seiten/212-retoure-neu.md), [213-retoure-angefragt](seiten/213-retoure-angefragt.md), [214-retoure-genehmigt](seiten/214-retoure-genehmigt.md), [215-retoure-eingegangen](seiten/215-retoure-eingegangen.md), [216-retoure-geprueft](seiten/216-retoure-geprueft.md), [217-retoure-abgeschlossen](seiten/217-retoure-abgeschlossen.md), [218-retoure-abgelehnt](seiten/218-retoure-abgelehnt.md), [m08-retoure-pruefen](seiten/m08-retoure-pruefen.md) |
| `/versand/retouren/neu` | [212-retoure-neu](seiten/212-retoure-neu.md) |
| `/vorgaenge` | [120-vorgaenge](seiten/120-vorgaenge.md) |
| `/vorgaenge/[id]` | [122-vorgang-anfrage-gewonnen](seiten/122-vorgang-anfrage-gewonnen.md), [123-vorgang-anfrage-abgelehnt](seiten/123-vorgang-anfrage-abgelehnt.md), [611-reparaturanfrage-angenommen](seiten/611-reparaturanfrage-angenommen.md), [612-reparaturanfrage-abgelehnt](seiten/612-reparaturanfrage-abgelehnt.md) |
| `/vorgaenge/prozess/[code]` | [121-vorgaenge-anfrage](seiten/121-vorgaenge-anfrage.md), [610-reparaturanfragen](seiten/610-reparaturanfragen.md) |
| `/zeiterfassung` | [700-zeiterfassung](seiten/700-zeiterfassung.md), [m09-zeiterfassung](seiten/m09-zeiterfassung.md) |
