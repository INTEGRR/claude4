# Entscheidungslog

Jede Architektur-, Produkt- und Betriebsentscheidung bekommt hier einen
datierten Eintrag — **im selben Commit wie die Umsetzung** (Regel in
AGENTS.md, Format vom Doku-Wächter `tests/doku.test.ts` geprüft). Einträge
werden nie umgeschrieben: wird eine Entscheidung revidiert, kommt ein neuer
Eintrag mit Verweis auf den alten. Neueste zuerst.

Format: `## JJJJ-MM-TT — Titel`, dann kurz: was entschieden, warum, wo
umgesetzt/dokumentiert.

## 2026-08-23 — Die Vorgangsseite ist eine Maske, der Ablaufplan ist Kontext

Befund aus dem Pilotbetrieb: Die Detailseite eines Vorgangs bestand aus einem
280–560 px hohen Diagramm und einer read-only-Liste der eigenen Felder. Nichts
war editierbar — Titel, Kunde und zusatz-Werte waren nach dem Anlegen
eingefroren (kein `vorgang.kopf_aendern`; `status_setzen` verlangt zwingend
einen Zustand), Schrittformulare zeigten Ist-Werte nicht, und die Seite lag
mit `requireArea('verkauf')` hinter der falschen Schranke. Für einen
LAUFENDEN Beleg ist der Ablaufplan aber Kontext, nicht Inhalt.

Entschieden (Kanon der Fachbeleg-Seiten, Muster verkauf/[id]):

- **`vorgang.kopf_aendern`** (bindung beleg, prozessfrei): Titel, Kunde und
  eigene Felder ändern — ohne Zustandswechsel, auch im Endzustand. zusatz
  wird gemerged; ein geleertes Feld löscht seinen Wert; die Ausführung
  koerziert Formstrings typgerecht (nummer/schalter), sonst verglichen
  Bedingungen später Text.
- **Details-Karte** mit echtem Formular (Ist-Werte als defaultValue),
  „Als Nächstes möglich" als eigene Arbeitskarte, das Diagramm eingeklappt
  ans Seitenende (`<details>`, ProzessPanel-Prop `nurDiagramm`).
- **Ist-Vorbelegung überall**: `naechsteAngebote` setzt die zusatz-Ist-Werte
  als `vorgabe` an die Schrittfelder — niemand erfasst mehr blind gegen einen
  unsichtbaren Bestand. Wirkt auf allen Panel-Seiten.
- **Ein Feld-Renderer**: `components/feld-eingabe.tsx` (ohne 'use client',
  unkontrollierte Eingaben) bedient Schrittformulare und Details-Karte —
  eine Darstellung je Feldtyp statt zwei Dialekte.
- Erfolgsmeldungen der Schrittformulare tragen jetzt den Ergebnis-Link
  („Öffnen →") statt ihn auf Belegseiten zu verwerfen.

Umgesetzt in registry/vorgang{,-ausfuehren}.ts, (erp)/vorgaenge/[id],
components/feld-eingabe.tsx, prozess-aktionen.tsx, prozess-panel.tsx,
prozesse/angebote.ts. Wächter: tests/prozesse/prozesse.test.ts
(kopf_aendern merged/koerziert/lehnt Unlesbares ab).

## 2026-08-22 — Eigene Felder gehören zum Prozess, und der Entwurf bringt sie mit

Prozesse zur Laufzeit in Formulare zu verwandeln ist der Kern von KRNL: Der
Kunde beschreibt seinen Ablauf, daraus entsteht die Oberfläche. Bei den
Schritten war das eingelöst — bei den Daten nicht, und Daten sind die halbe
Maske.

Zwei Fehler in der bisherigen Architektur:

1. **Felder hingen am MODELL.** Alle Laufzeit-Prozesse teilen sich das Modell
   `vorgang`, sahen also zwangsläufig dieselben Felder; und `unique (modell,
   name)` verbot zwei Abläufen dasselbe Feld.
2. **Der Entwurf kannte keine Felder.** Sie entstanden nur über einen eigenen
   Handgriff (`einstellungen.feld_anlegen`) — eine Stelle, die ein Kunde nie
   findet. Wer seinen Prozess aufnahm, bekam eine Maske, in der er außer
   einem Titel nichts eintragen konnte.

Entschieden, per Architektur statt per Code:

- `feld_definitionen` bekommt `prozess_code` (null = modellweit, wie bisher)
  und `schritte text[]` (leer = überall). Eindeutigkeit jetzt über
  `(modell, coalesce(prozess_code,''), name)`.
- `einstellungen.prozess_entwerfen` nimmt `felder[]` entgegen — Schritte,
  Übergänge und Felder sind EIN Entwurf. Aufnahme und Werkstatt liefern sie
  mit; die Wissensbasis führt die Leitfrage „Was tragen Sie in diesem Schritt
  ein?".
- Felder hängen am PROZESS, nicht an der Version: sie sind Datenstruktur, die
  erfassten Werte stehen im `zusatz` und überleben Versionswechsel. Eine neue
  Version, die ein Feld nicht mehr nennt, LÖSCHT es nicht — sonst verlöre die
  Liste rückwirkend ihre Spalten. Aufräumen ist ein eigener Schritt
  (Expand-Contract).
- Das Startformular eines Laufzeit-Prozesses ist ab jetzt die generierte
  Maske des Anlage-Schritts, nicht ein handgebautes Formular. Sonst fiele
  „beim Anlegen erfasse ich X" genau dort unter den Tisch.

Nicht gewählt: Felder an der Version zu führen. Das wäre sauberer im Modell
und falsch in der Sache — ein Versionswechsel ist eine Ablaufänderung, keine
Datenmigration.

Umgesetzt in Migration 0071, `registry/einstellungen{,-ausfuehren}.ts`,
`prozesse/angebote.ts` (neu: `startAngebot`), `(erp)/vorgaenge/prozess/[code]`,
`(erp)/prozesse/[code]`, `einrichtung/`, `ki/wissen.ts`,
`ki/prozess-aufnahme.ts`. Wächter: tests/prozesse/prozesse.test.ts.
Dokumentiert in [prozesse.md](prozesse.md) („Der Entwurf bringt die Felder
mit").

## 2026-08-22 — Ein Test ohne Datenbank bekommt auch keine

Der CI-Hänger der Prozessläufe ist gefunden: `tests/prozesse/fakes.test.ts`
prüft nur die Fake-Weichen von Shopify und DHL — die Client-Module
protokollieren aber JEDEN Aufruf über `logTransaction`, auch im Fake-Modus.
Das Protokoll schluckt seine Fehler (fire-and-forget, aus gutem Grund), also
fiel nie auf, dass dieser Test bei gesetzter `DATABASE_URL` eine echte
Verbindung zur BASIS-Datenbank aufbaut und dort `api_transactions`-Zeilen
hinterlässt.

Zwei Folgen:

- Der Test verschmutzt eine fremde Datenbank — in der CI die frisch
  migrierte `erp`, im Staging-Lauf die Staging-Datenbank.
- Der Verbindungspool (ohne `idle_timeout`) hält den Testprozess offen.
  node:test wartet bei `--test-concurrency=1` auf dessen Ende: Datei 1 grün,
  danach fünf Minuten Stille bis zum Zeitlimit.

Lokal war beides unsichtbar, weil diese Datei `scripts/env.ts` nicht lädt —
`DATABASE_URL` steht hier in `.env.local`, in der CI in der Umgebung. Genau
dieser Unterschied hat drei Runden Ursachensuche gekostet.

Entschieden: **Ein Test, der keine Datenbank braucht, bekommt auch keine** —
`fakes.test.ts` löscht `DATABASE_URL` vor den Importen, statt darauf zu
hoffen, dass keine gesetzt ist. Dazu ein Wächter im `after()`: bleibt ein
TCP-Handle offen, wird der Test rot statt stumm.

Nicht gewählt: `idle_timeout` im Produktions-Client. Das hätte den Hänger
beseitigt und den eigentlichen Fehler (Test schreibt in fremde Datenbank)
verdeckt.

Dazu `tests/prozesse/spur.ts`: die Fortschrittsspur ist aus dem Harness
herausgezogen, läuft ab dem ersten Import jeder Testdatei und trägt einen
unref()-Wachhund, der alle 10 Sekunden `getActiveResourcesInfo()` mitschreibt.
Er hat den Fehler benannt (`TCPSocketWrap, Timeout`) — und ist ab jetzt die
Standardantwort auf „hängt", statt der nächsten Rateschleife.

## 2026-08-22 — Ein Laufzeit-Prozess bekommt eigenen Menüpunkt und eigene Liste

Bis hierher erzeugte ein aufgenommener Prozess nur die MASKE. Die Navigation
war eine Projektion der aktiven Prozesse — aber nur der einprogrammierten;
jeder selbst gebaute Ablauf landete im Sammelbecken `/vorgaenge`. Das ist die
halbe Zusage: Wer seinen Prozess selbst aufnimmt, erwartet ihn auch im Menü.

Entschieden:

- Der Menüpunkt hängt **im Bereich des Prozesses** (Verkauf, Personal, …),
  nicht in einer Sonderschublade „Meine Abläufe". Dort sucht ein Kaufmann
  ihn. Nur Bereiche ohne eigene Gruppe sammeln sich unter „Abläufe".
- Die Liste `/vorgaenge/prozess/[code]` baut sich aus dem Prozess: Zustände
  aus der aktiven Version als Filter, Zusatzspalten aus `feld_definitionen`
  (`sichtbar_in` enthält `'liste'`, sonst die ersten vier Formularfelder).
  Kein Zähler am Menüpunkt — ein Vorgang hat keinen Erledigt-Zustand, die
  Zahl würde nur wachsen.
- `vorgang.anlegen` braucht ab jetzt einen `zustand` (den Einstiegszustand).
  Ohne ihn startete der Vorgang auf dem Notnagel `neu` — außerhalb des
  eigenen Diagramms; genau so entstand der erste Kundenprozess.

Umgesetzt in `src/app/(erp)/layout.tsx`,
`src/app/(erp)/vorgaenge/prozess/[code]/page.tsx`, `src/modules/befehle.ts`
und `einstellungen.prozess_entwerfen`. Wächter: tests/navigation.test.ts,
tests/prozesse/prozesse.test.ts. Dokumentiert in
[prozesse.md](prozesse.md) („On-demand-Oberfläche").

## 2026-08-21 — jsonb schreibt man über den Treiber, nicht über JSON.stringify

Befund aus dem Pilotbetrieb, gefunden an einem 404 auf einer Vorgangsseite:
Jeder von der KI entworfene Prozess hatte seine jsonb-Felder **doppelt
verpackt**. Gespeichert war ein JSON-STRING (`"{\"prozess_code\":\"x\"}"`)
statt eines Objekts. Ursache war die Schreibweise
`${JSON.stringify(wert)}::jsonb` in `einstellungen.prozess_entwerfen` — der
Treiber verpackt einen bereits serialisierten String noch einmal.

Der Fehler war doppelt unsichtbar: Er entsteht nur auf dem Entwurfsweg (die
Migrationen schreiben ihr JSON direkt in SQL), und er fällt erst auf, wenn
jemand das Feld BENUTZT:

- `params` als String ließ die Vorgangsmaske auf einen TypeError laufen
  („Cannot use 'in' operator") — die Detailseite eines Vorgangs war nicht
  erreichbar.
- `bedingung` als String bekam `bedingung_pruefen` nie als Bedingung zu
  fassen — die XOR-Zweige aller KI-entworfenen Prozesse griffen nicht.
  Das betraf auch den Verkaufsentwurf aus BUG/00015.

Drei Ebenen, damit das nicht wiederkommt:

1. **Code**: jsonb-Parameter gehen über `sql.json(…)` bzw. `t.json(…)`.
   `JSON.stringify(…)::jsonb` ist in diesem Repo ein Fehler, kein Stil.
2. **Datenbank**: Migration 0070 repariert den Bestand (`#>> '{}'` und
   zurück-casten) und schreibt die Felder per CHECK-Constraint als Objekt
   fest. Eine Fehlkodierung scheitert jetzt beim SCHREIBEN, nicht erst beim
   Benutzen.
3. **Test**: tests/prozesse/prozesse.test.ts prüft nach einem echten
   Entwurf, dass `jsonb_typeof(params) = 'object'` ist UND dass der Inhalt
   lesbar zurückkommt. Gegenprobe gemacht: mit der alten Schreibweise wird
   der Test rot.

## 2026-08-21 — Gefahrenzone in zwei Stufen: Betriebsdaten und Werkszustand

Bisher gab es genau einen Knopf, „alle Daten löschen (Neustart)". Er tut das
auch — aber nur für BETRIEBSdaten. Konfiguration, Konten, Firmendaten und vor
allem das ganze Prozessmodell bleiben stehen. Das ist für den ursprünglichen
Zweck richtig (Beispieldaten vor dem echten Betrieb entfernen), heißt aber
nicht, was der Knopf verspricht.

Für den Pilotbetrieb fehlte die Stufe darüber: Wer eine Woche lang Prozesse
ausprobiert hat, sitzt sonst auf vier Versionen des Verkaufsprozesses, einer
halb umgestellten Navigation und einer Ersteinrichtung, die nie wiederkommt.

Zwei Stufen, beide über die Registry (der bisherige Knopf war eine der
UI-Umgehungen aus dem Code Review — die Liste schrumpft um einen weiteren
Eintrag), beide mit Tippbestätigung, **beide bewusst ohne KI-Freigabe**:

- **Stufe 1 `einstellungen.betriebsdaten_loeschen`** — wie gehabt: Belege,
  Produkte, Partner, Bestände, Buchungen, Protokolle; Nummernkreise auf 1.
- **Stufe 2 `einstellungen.werkszustand`** — zusätzlich alles, was diese
  Instanz zu DIESER Instanz gemacht hat: selbst gebaute Prozessversionen und
  Entwürfe (der Auslieferungsstand aus den Migrationen bleibt), eigene
  Felder, Laufzeit-Abschaltungen, die Paketwahl, alle Konten außer dem
  ausführenden, die Firmendaten. Der settings-Schlüssel `einrichtung` fällt —
  die Ersteinrichtung startet danach wieder von vorn.

Bewusst NICHT angefasst: technische Konfiguration (DHL-Absender,
Freigabe-Limits, Finanz-Quoten, Kartonagen, Versandregeln), Lagerorte,
Einheiten, Steuern, Zahlungsbedingungen. Das ist Einrichtung des Betreibers,
kein Datenbestand — und Zugangsdaten stehen ohnehin in Umgebungsvariablen.

Das ausführende Konto überlebt Stufe 2 zwingend (die Funktion prüft, dass es
existiert und Administrator ist). Ohne ein bleibendes Konto wäre die Instanz
nach dem Reset für niemanden mehr erreichbar.

Nebenbefund und mitbehoben: **Registrierungen** von der öffentlichen
Startseite fielen bei Stufe 1 stillschweigend mit. Sie sind kein
Betriebsdatum der Firma, sondern der Vertriebseingang des Betreibers, und es
gibt keine zweite Quelle. Sie stehen jetzt auf der Erhalten-Liste — in beiden
Stufen.

## 2026-08-21 — Strukturregeln gelten schon beim Entwurf, nicht erst beim Schalten

Aus dem Pilotbetrieb (BUG/00015): Der Kunde ließ den Verkaufsprozess von der
KI umbauen. Sie baute einen XOR-Schritt „Fertigung nötig?" mit ZWEI
bedingungslosen Kanten. Der Entwurf entstand klaglos — und ließ sich danach
nie aktivieren, weil `prozess_version_aktivieren` genau das ablehnt
(höchstens eine Default-Kante). Der Fehler kam also an der Stelle, an der
niemand mehr etwas ändern konnte.

Bisher war das Absicht: „die harte Validierung sitzt im Aktivieren". Diese
Entscheidung wird revidiert. **Ein Entwurf, der nicht aktivierbar ist, ist
kein Entwurf — er ist eine Falle.** Die drei Strukturregeln (XOR-Default,
Erreichbarkeit, Azyklik) laufen jetzt schon in
`einstellungen.prozess_entwerfen`, mit denselben Sätzen. Das trifft vor allem
die KI: `aufnahmeStrukturieren` darf dreimal nachbessern — bekommt sie den
Fehler sofort, korrigiert sie ihn in derselben Runde.

Die Regeln liegen als PURES Modul `prozesse/entwurf-pruefen.ts` (kein
Datenbank-Import) und sind einzeln getestet. In SQL bleiben sie unverändert
stehen: **die Datenbank ist die letzte Instanz**, nicht die zweite Meinung —
Entwürfe können auch per Migration oder Handarbeit entstehen. Der
Prozesstest prüft jetzt beide Ebenen.

Zusätzlich: Die Beschreibung von `prozess_entwerfen` sagte „Verzweigungen
sind mehrere ausgehende Übergänge, **optional mit bedingung**" — das lud den
Fehler geradezu ein. Sie benennt die Regel jetzt ausdrücklich.

Und die Bedingung ließ sich für diesen Zweig gar nicht formulieren:
`prozess_beleg_daten` liefert für einen Verkaufsauftrag nur dessen Spalten,
ob eine Position gefertigt werden muss steht aber in den Positionen.
Migration 0068 ergänzt zwei abgeleitete Felder — `fertigung_noetig`
(fertigbare Position vorhanden) und `fertigung_automatisch` (entsteht bei
der Bestätigung wirklich ein Auftrag).

## 2026-08-21 — Kontakte: Vor- und Nachname sind Bestandteile, `name` bleibt die Wahrheit

BUG/00013: Kontakte hatten genau ein Namensfeld. Für Personen ist das zu
wenig — Anrede, Sortierung und der Shop (der first_name/last_name liefert)
brauchen die Teile getrennt. Migration 0068 ergänzt `vorname`/`nachname`;
`name` bleibt der Anzeigename und die eine Wahrheit für Belege, bei Personen
zusammengesetzt aus den Teilen.

Bestandsdaten werden NICHT geraten: „Müller GmbH & Co. KG" oder „Dr. Anna
von Weiz" lassen sich nicht verlässlich zerlegen. Wer die Teile braucht,
pflegt sie beim nächsten Anfassen nach.

Im selben Zug (BUG/00012): `kontakte.partner_anlegen` ist jetzt eine
Registry-Aktion — die Kontaktanlage war eine der UI-Umgehungen aus dem Code
Review, die Liste schrumpft um einen Eintrag. Und weil am Telefon der Kunde
oft neu ist, gibt es `verkauf.auftrag_fuer_neuen_kunden`: Kontakt und
Angebot in einer Aktion, eine Torwächter-Prüfung, ein Protokolleintrag.
Bewusst als alternativer Einstieg in denselben Prozessschritt „anlegen"
(prozessfrei, weil der Beleg in genau demselben Zustand landet) statt als
zweiter Startzweig im Diagramm.

## 2026-08-21 — „Keine Fertigung nötig" darf nicht behauptet werden

BUG/00014: Ein Verkaufsauftrag mit einem Produkt, das eine Stückliste hat,
erzeugte keinen Fertigungsauftrag — und das System schrieb dazu „Keine
Fertigung nötig." Das war schlicht falsch: die Automatik verlangt
`route_manufacture` UND `route_mto` UND eine auflösbare Stückliste; am
Produkt fehlten die Routen.

Neu ist `sales_order_fertigungslage(order)`: sie nennt die Positionen, die
fertigbar wären, mit dem Grund, warum kein Auftrag entsteht („Route ‚auf
Bestellung fertigen' ist am Produkt nicht gesetzt"). Der Auftrag zeigt das
statt der Behauptung.

Die eigentliche Ursache im Pilotbestand war zusätzlich ein DOPPELTES Produkt
gleichen Namens — eines mit Stückliste und Fertigungsroute, eines ohne; im
Auftrag stand das ohne. Das ist ein Datenbefund, kein Codefehler, und bleibt
Sache des Betriebs.

## 2026-08-21 — Registrierung: ein einziger Schreibweg ohne Sitzung

Die Startseite bekommt ein Anmeldeformular („Erzählt uns euren Ablauf").
Damit entsteht die erste Stelle im System, an der **ohne angemeldeten
Nutzer** geschrieben wird — ein Bruch mit der Regel „jede Schreiboperation
läuft über den Torwächter" (AGENTS.md). Der Bruch ist unvermeidbar: der
Torwächter setzt Rolle und Nutzer voraus, ein Interessent hat beides nicht.

Entschieden: **eine** solche Stelle, so eng wie möglich, und keine zweite.
Konkret `POST /api/registrierung` → Tabelle `registrierungen`
(Migration 0066), ohne Verknüpfung zu Belegen und ohne Nebenwirkung.
Geschützt durch serverseitige Prüfung nach denselben Regeln wie im Formular
(eine Quelle: `modules/shared/registrierung.ts`), Längengrenzen je Feld,
Honigtopf gegen Bots, Drosselung von 5 Eingängen je 10 Minuten und einen
Eintrag im Audit-Log. Die IP wird **nicht im Klartext** gespeichert, nur ein
mit `SESSION_SECRET` gesalzener Hash, ausschließlich zur Drosselung.

Alles, was danach mit einem Eingang passiert, läuft wieder über die Registry
(`einstellungen.registrierung_status`, nurAdmin, beleggebunden) und ist damit
protokolliert. Arbeitsliste: /einstellungen/registrierungen.

Verworfen: das Formular als Server Action zu bauen (hätte die Umgehung
unsichtbar in `UI_UMGEHUNGEN` versteckt, statt sie als bewusste Ausnahme zu
benennen) und der Fallback des Design-Prototyps, bei Serverfehlern einen
**simulierten Erfolg** anzuzeigen — wer nichts absetzen kann, muss das
sehen, sonst wartet er auf einen Rückruf, den es nie gab.

Umgesetzt: src/app/api/registrierung/route.ts, src/app/start/registrierung.tsx,
src/modules/shared/registrierung.ts, Migration 0066,
src/app/(erp)/einstellungen/registrierungen/, tests/registrierung.test.ts.
Doku: [website.md](website.md).

## 2026-08-21 — Onboarding als fünf Schritte, mit protokollierter Abnahme

Der Einrichtungs-Assistent wird nach dem Design-Handoff auf eine
Fünf-Schritt-Strecke umgebaut: Instanz → Team → Aufnehmen → Zeichnen →
Läuft. Grund ist nicht die Optik, sondern die **Deckungsgleichheit mit dem
Verkaufsversprechen**: Die Startseite verspricht Aufnehmen, Zeichnen, Läuft —
also muss das Produkt genau das liefern, in derselben Reihenfolge und
Sprache. Ein Onboarding, das stattdessen Stammdatenmasken abfragt, macht
die Startseite zur Behauptung.

Drei Festlegungen dabei:

1. **Schritt 03 nutzt dieselbe Strukturierung wie das Sprach-Interview**
   (`aufnahmeStrukturieren`), nur mit getippten Antworten. Kein zweiter
   Aufnahmeweg, keine zweite Prompt-Quelle — die Route `/api/aufnahme` reicht
   nur das Transkript durch und endet in `einstellungen.prozess_entwerfen`,
   also IM Torwächter.
2. **Schritt 04 zeigt das echte Diagramm** (`versionDiagramm` +
   `ProzessFlow`), nicht eine hübschere Nachbildung. Was der Kunde abnimmt,
   ist exakt das, was er später unter /prozesse sieht. Markierte Schritte
   führen in eine Korrekturrunde zurück nach 03 und erzeugen die nächste
   Version desselben Prozesscodes.
3. **Die Abnahme ist ein Beleg.** Migration 0067 ergänzt
   `prozess_versionen` um `abnahme_am/_durch/_notiz`;
   `einstellungen.prozess_abnahme` schreibt sie. Festgemacht an der Version,
   nicht an der Aktivierung: aktiviert wird vielleicht mehrfach (Rückfall auf
   eine ältere Version), abgenommen wird einmal.

Das Geschäftsmodell-Paket bleibt drin und wandert in Schritt 01 — es ist
weiterhin der folgenreichste Klick der Einrichtung (ohne Wahl sind ALLE
Prozesse aktiv). Die Weiche „erst Beispieldaten ansehen" bleibt als
Vorschritt bestehen; sie ist echt und hat sich bewährt.

Kein Schritt ist eine Sackgasse: Ohne `ANTHROPIC_API_KEY` sagt Schritt 03
das offen, und die Einrichtung lässt sich trotzdem abschließen — der erste
Ablauf entsteht dann in der Werkstatt.

Nicht übernommen aus dem Handoff: die simulierte Provisionierungsanzeige
(„84 %", `<name>.krnl.eu`). Wer diese Seite sieht, hat eine laufende
Instanz — angezeigt wird deshalb der **echte** Host mit der tatsächlichen
Zahl eingespielter Migrationen. Eine erfundene Fortschrittsanzeige wäre die
erste Lüge des Produkts.

Umgesetzt: src/app/einrichtung/ (page, wizard, einrichtung.css, actions),
src/app/api/aufnahme/route.ts, Migration 0067,
registry/einstellungen.ts (`prozess_abnahme`). Doku:
[prozesse.md](prozesse.md), Abschnitt Onboarding.

## 2026-08-21 — Startseite nach dem Design-Handoff, eigenes Farbsystem

Die Startseite wird auf den Handoff „KRNL Sales" gezogen: heller
Chassis-Grund, dunkle eingelassene Anzeigen, Haarlinien-Rhythmus,
Siebensegment nur für echte Zahlen. Dazu drei interaktive Stücke, die die
These belegen statt sie zu behaupten — Prozessversion umschalten,
Bestätigungstor im Sprachdialog, Kostenrechner.

Entschieden: Die Seite bekommt ein **eigenes Farbsystem** in `start.css`
statt der globalen Tokens und folgt damit **nicht** dem
Hell/Dunkel-Umschalter des ERP. Eine Verkaufsseite hat genau ein Gesicht
(dieselbe Begründung wie beim Boot-Splash). Die Tokens stehen in `start.css`
und `einrichtung.css` doppelt — Absicht: start.css soll ohne den Rest in ein
eigenes Deployment umziehen können, und zwei kurze Blöcke sind billiger als
eine Abhängigkeit, die genau beim Herausziehen bricht.

Der **Kostenrechner** bleibt mit ausdrücklich als Platzhalter markierten
Annahmen (Lizenz je Nutzer, Beratungstage je Prozess, Schulungsanteil,
Betrieb je Nutzer) im Code stehen, weil der Abschnitt die eigentliche
Positionierung trägt — der Customizing-Block entfällt. Solange die Zahlen
Hausnummern sind, ist die Disclaimer-Zeile Pflicht („Modellrechnung für
Jahr 1. Kein Angebot"). Die Liste offener Platzhalter steht in
[website.md](website.md).

Nebenbei: `src/middleware.ts` heißt jetzt `src/proxy.ts` — Next 16 hat die
Dateikonvention umbenannt und warnt beim Start. Verhalten unverändert.

## 2026-08-19 — Öffentliche Startseite vor dem Login (später eigenes Deployment)

KRNL braucht für die Piloten-Ansprache eine Seite, die erklärt, was das
Produkt ist. Sie kommt **vor den Login**: Wer die Wurzel ohne Sitzung
aufruft, landet auf `/start`; jede andere geschützte Seite leitet
weiterhin direkt zum Anmeldeformular (wer /verkauf aufruft, will
arbeiten). Die Weiche ist eine schlanke Middleware, die nur das
Sitzungs-Cookie prüft — die echte Prüfung bleibt bei `currentUser()`,
ein abgelaufenes Cookie landet also auf /login und nicht auf der
Werbeseite.

Ziel ist ein **separates Vercel-Deployment**, sobald die Seite steht.
Deshalb ist sie schon jetzt eigenständig gebaut: eigene Route außerhalb
der (erp)-Gruppe, eigenes Stylesheet mit eigenem Namensraum
(`.krnl-start`), keine ERP-Komponenten außer der Marke. Sie nutzt
lediglich die globalen Farbtokens, damit Hell/Dunkel und die Marke
identisch bleiben. Beim Umzug fällt die Middleware ersatzlos weg.

Die Inhalte folgen der **Positionierung**, nicht dem Funktionsumfang:
Prozess First (der Ablauf ist die Software), Sprechen als Einstieg,
Einstieg in drei Schritten (aufnehmen → zeichnen → läuft), eigene Instanz
je Kunde. Bewusst ohne erfundene Referenzen, Kundenzahlen oder
Testimonials — es steht nur da, was das System kann. Die Kontaktadresse
ist ein sichtbar markierter Platzhalter (`KONTAKT_MAIL`), der vor dem
Livegang gesetzt werden muss.

## 2026-08-21 — Code-Review: Wächter scharf stellen statt umbauen

Vollständiger Wartbarkeits-Review vor dem Pilotbetrieb (66.000 Zeilen, 373
Dateien). Befund: **kein Spaghetti** — keine zirkulären Importe, ein
durchgehaltenes Seitenskelett, saubere Server/Client-Grenze, Fachlogik in der
Datenbank. Das eigentliche Problem lag woanders: **die Wächter-Tests, auf
denen die Architektur ruht, waren teilweise blind und liefen in keiner CI.**

Entscheidung: **nicht umbauen, sondern die Absicherung reparieren.** Konkret
- Registry-Wächter scannte nur `actions.ts` und übersah 24 Server Actions,
  die am Torwächter vorbeigehen (21 mit Schreib-SQL) — er meldete dabei grün.
- Migrations-Wächter kannte `drop constraint/trigger/function` nicht; der
  DESTRUKTIV-Marker kam in keiner der 65 Migrationen vor.
- Kein Linter, keine CI auf Pull Requests — aber 25 wirkungslose
  `eslint-disable`-Kommentare, die eine Prüfung vortäuschten.

Statt die 24 Umgehungen sofort zu migrieren, stehen sie jetzt als begründete,
**nur schrumpfende Liste** im Test: Schuld sichtbar machen schlägt Schuld
verschweigen, und die Migration ist ein eigenes Arbeitspaket. Ebenso bewusst:
Biome kommt mit **abgeschaltetem Formatter** (ein erzwungenes Format hätte
311 Dateien angefasst und jede Codearchäologie zerstört) und einer
Regelauswahl, die ab Tag 1 grün ist — ein roter Linter wird ignoriert.
Die a11y-Regeln (40+ Befunde) sind vorerst aus und als eigenes Paket vermerkt.

Nebenbei behoben: ein Produktionsfehler (Kommentarfunktion auf fünf
Detailseiten kaputt, weil `model` ein freier String war), eine echte Race
Condition in der Testsuite, und die Zeitzonenfalle in 17 kopierten
`toISOString().slice(0,10)`-Stellen.

Nicht gemacht und nicht empfohlen: Umstrukturierung nach Fachdomänen
(`modules/verkauf/` …). Die Trennung Schreiben/Buchen/Lesen funktioniert und
ist getestet — sie war nur nicht aufgeschrieben. Das erledigt
[architektur.md](architektur.md) billiger als ein Umbau.

Bericht mit allen Befunden: [code-review.md](code-review.md).
Neue Entwickler-Anleitung: [entwicklung.md](entwicklung.md).

## 2026-08-19 — Verkauf komponiert; Herkunftsfelder für Bedingungen

Der Verkauf bekommt die Lieferung als **Teilprozess** statt als
Nebenprozess (Spiegelbild des Einkaufs-Piloten aus 0050): Der Auftrag ist
erst fertig, wenn die Ware raus ist. Der Versandprozess trägt dafür einen
neutralen Anzeigenamen („Lieferung & Versand") — sein Beleg-Filter deckt
jeden Verkaufsauftrag ab; der Code `shopify_bestellung_versand` bleibt als
technische ID, weil Instanzen und Vorgänge ihn referenzieren (ein
Code-Rename wäre eine Fremdschlüssel-Wanderung ohne fachlichen Gewinn).

Dabei kam ein Fehler heraus, den erst die geschlossene Kette sichtbar
macht: Der Versandprozess verlangte die Shop-Rückmeldung von JEDEM
Ausgangs-Transfer, auch von manuellen Aufträgen ohne Shop. Statt den
Schritt einfach abzuschalten, wurde die Ursache behoben — Bedingungen
sahen bisher nur die Spalten des eigenen Belegs, am Transfer steht die
Herkunft aber nur als origin_model/origin_id. `prozess_beleg_daten()`
reichert Belege mit Herkunft jetzt generisch um die Felder des
Herkunftsbelegs an (Präfix `herkunft_`, rein additiv, Tabellennamen
weiterhin nur über den Modell-Katalog). Damit können Kindprozesse auf den
Elternbeleg bedingen — hier: Rückmeldung nur bei
`herkunft_source = shopify`.

Bewusst offen: Die Kette endet nach der Lieferung. Der
Abrechnungs-Teilprozess kommt erst mit einem Kundenrechnungs-Modul (AR) —
dieselbe Begründung wie 0052 für die entfernte invoice_status-Kachel.
Doku: [prozesse.md](prozesse.md), Abschnitt Verkauf komponiert.

## 2026-08-19 — Nutzungsbericht light: Zählen statt Lizenzieren

Für die ersten zahlenden Piloten gibt es KEIN Lizenz-/Abrechnungsmodul —
nur einen **Nutzungsbericht** als Gesprächsgrundlage:
`nutzungsbericht(monate)` (Migration 0063, rein additiv) liefert je Monat
aktive Nutzer, neue Kernbelege, KI-Fragen und Sprachsitzungen aus
Bestandsdaten (audit_log, Belegtabellen, sprachprotokolle). Einzige neue
Zählstelle: /api/ki schreibt pro Chat-Runde einen log_event-Eintrag
model='ki' — vorher wurden nur ausgeführte KI-Aktionen protokolliert,
die reine Chat-Nutzung war unsichtbar. Die Zahlen bleiben in der
jeweiligen Instanz (kein Phone-Home, passend zur Instanz-pro-Kunde-
Entscheidung); gezogen wird monatlich von Hand auf /einstellungen/nutzung
(nur Admin). Doku: [prozesse.md](prozesse.md), Abschnitt Pilotbetrieb;
Wächter: tests/nutzung.test.ts.

## 2026-08-19 — Onboarding-Weiche: Demo-Modus oder geführte Einrichtung

Eine frische Instanz fragt beim ersten Admin-Login: **Beispieldaten
ansehen oder richtig loslegen.** Die Frisch-Erkennung ist eine Heuristik
ohne Schema-Umbau — settings-Schlüssel `einrichtung` fehlt UND der
Firmenname steht auf dem Migrations-Default UND es gibt genau einen
Nutzer; das ERP-Layout leitet dann nach `/einrichtung` (klassische Route
außerhalb der (erp)-Gruppe, Muster /login). Der Abschluss schreibt den
Schlüssel, und weil die Gefahrenzone (`demodaten_loeschen`) settings
stehen lässt, kommt die Weiche **nie wieder** — auch nicht nach einem
Daten-Neustart. Der Wizard ist bewusst klassisch (Firma → Paket → Team →
Passwort), kein Agent-Gespräch: er muss ohne KI-Schlüssel funktionieren
und VOR jeder Konfiguration liegen; der Abschluss verweist auf die
Werkstatt. Dafür wurden die Demodaten aus `scripts/seed.ts` in das Modul
`src/modules/demo/daten.ts` gezogen (Skript und Server teilen den Code)
und drei Registry-Aktionen ergänzt: `einstellungen.demodaten_einspielen`
(bewusster Admin-Opt-in, Idempotenz-Wächter bleibt),
`einstellungen.firma_speichern` (löst die freie saveCompany-Action ab)
und `einstellungen.einrichtung_abschliessen`. Doku:
[prozesse.md](prozesse.md), Abschnitt Onboarding; Tests:
tests/einrichtung.test.ts.

## 2026-08-19 — Prozess-Werkstatt: Bauen ist ein Einstellungs-Thema, kein Alltagsmodus

Die Prozess-Aufnahme wandert aus dem Alltags-Sprachassistenten (/sprechen)
in die neue **Werkstatt** unter /prozesse/werkstatt: Dort baut der Admin
MIT dem Agenten — Chat mit Tabellen, Entwürfen und Diagramm-Vorschau,
nicht nebenbei. Der Alltags-Assistent bleibt schlank (Zählen, Fragen,
Sammeln). Technisch: gemeinsamer Sitzungs-Hook jetzt in
`src/components/nutze-gespraech.tsx` (drei Verbraucher), der
Aufnahme-Abschluss liefert den Entwurf-Code strukturiert (`beiEntwurf`) —
die Werkstatt springt direkt aufs Diagramm. `werkstatt` ist als
Prozess-Code reserviert (statisches Routensegment schlägt /prozesse/[code]).
Doku: [prozesse.md](prozesse.md), Abschnitt Prozess-Werkstatt.

## 2026-08-19 — Wissensbasis im Code, Kontext-Kanal statt Prompt-Stuffing

Prozess-Best-Practices leben als EINE versionierte Quelle in
`src/modules/ki/wissen.ts` (Muster schema-doku.ts: Konstante + Wächter-Test
`tests/wissen.test.ts`), keine parallele Markdown-Doku (Sync-Drift). Sie
fließt in den Werkstatt-Kontext des Chat-Agenten und in die
Aufnahme-Strukturierung — NICHT in die Realtime-Instructions
(2.000-Zeichen-Budget). Der Agent bekommt dafür einen Kontext-Kanal als
**Enum** (`kontext: 'werkstatt'`), nie Freitext vom Client (kein
Injection-Kanal); nur Werkstatt-Runden zahlen die Wissens-Tokens.
Nebenbefund behoben: der Vorschlagskatalog des Chats bot nurAdmin-Aktionen
auch Nicht-Admins an (Ablehnung kam erst beim Klick) — der Katalog ist
jetzt rollengefiltert.

## 2026-08-19 — Prozess-Aufnahme beim Kunden: Interview per Stimme, Entwurf per Agent

Der Idealfall des Vertriebs: Beim Kunden wird der Ist-Prozess diktiert,
gezeichnet und umgesetzt. Entscheidung: eigener Aufnahme-Modus der
Sprachsitzung (Realtime führt das Interview — primäres Medium ist das
Live-Gespräch), danach strukturiert der Claude-Agent das Transkript in
einen `prozess_entwerfen`-ENTWURF (`vorgang`-Modell, frei definierte
Zustände — kein Code nötig). Sichtprüfung ist das Diagramm auf
/prozesse/&lt;code&gt;, aktiviert wird von Hand. Arbeitsteilung nach
Modellstärke, Wirkung nur über den Torwächter. Doku:
[prozesse.md](prozesse.md), Abschnitt Prozess-Aufnahme.

## 2026-08-19 — Produktname KRNL überall, Arbeitstitel „ERP" abgelöst

Der Arbeitstitel „ERP — Eigenentwicklung (Odoo-Nachbau)" weicht dem
Produktnamen: README und Anleitungen sprechen von **KRNL** (Marke seit
2026-08-17 in der App). Der Odoo-Nachbau bleibt als Herkunft im Text,
ist aber nicht mehr der Titel. Interne Bezeichner (package.json „erp",
Env-Namen wie ERP_PORT) bleiben unverändert — Umbenennen brächte
Migrationsaufwand ohne Nutzen.

## 2026-08-19 — Doku-System: Landkarte, Entscheidungslog, Doku-Wächter

Alle Entscheidungen und Konzepte müssen dauerhaft auffindbar sein und die
Doku muss zusammenhängen. Deshalb: [docs/README.md](README.md) als Landkarte
(jede Doku-Datei ist dort verlinkt), dieses Entscheidungslog, und ein
Doku-Wächter-Test, der Index-Vollständigkeit, tote Links und das
Eintragsformat erzwingt. Die Doku-Pflicht selbst steht in AGENTS.md —
Konventions-Durchsetzung gehört in Wächter-Tests, nicht in Disziplin.

## 2026-08-19 — Kundenbetrieb: Instanz pro Kunde + gestapelte Schutzschicht

KRNL wird an mehrere Kunden verkauft, Updates kommen häufig. Entscheidung:
**eigene Instanz + eigene Datenbank je Kunde** (kein Multi-Tenant in einer
DB), Updates in Ringen (eigene Instanz → Pilotkunde → Rest), PITR je
Kundenprojekt plus vierteljährliche Restore-Probe. Im Code: Migrations-
Wächter (destruktive DDL nur mit `-- DESTRUKTIV:`-Begründung, Regel
Expand-Contract) und nächtlicher Daten-TÜV (Ledger-Invarianten; Befund =
fehlgeschlagener Job im Monitor). Details: [prozesse.md](prozesse.md),
Abschnitt „Schutzschicht für den Kundenbetrieb".

## 2026-08-19 — Shopify Admin-API 2026-07: Laufzeit-Pflichten der Inventur-Mutationen

`inventorySetQuantities` verlangt seit 2026-04/2026-07 zur LAUFZEIT (im
Schema unsichtbar): `changeFromQuantity` in jedem Eintrag (explizit `null` =
kein Vergleich; das ERP ist die Quelle der Wahrheit) und die
`@idempotent(key: …)`-Direktive. Beides hatte in Prod 342 Bestandsabgleiche
scheitern lassen. Der Shopify-Fake erzwingt beide Pflichten wie der echte
Shop; Regressionstests in tests/inventar.test.ts.

## 2026-08-19 — Sprechen ist der Kern-Einstieg, nicht ein Feature

Der Sprachmodus wandert ganz oben in die Navigation (neben die Übersicht),
und der KI-Chat kann beides: tippen UND reden — der Hexcore-Knopf im
Composer öffnet den Buddy-Modus (Vollfläche im Chat, wie der Voice-Mode der
Claude-/ChatGPT-Apps). Die Sitzungslogik lebt einmal im geteilten Hook
`sprechen/nutze-gespraech.tsx`; Seite und Buddy sind zwei Oberflächen
derselben Sitzung. Doku: [prozesse.md](prozesse.md), Abschnitt Sprachmodus.

## 2026-08-19 — KI-Kosten und -Fokus: kurze Regeln statt langer Prompts

Realtime rechnet Audio-Tokens teuer ab und jede Runde trägt die ganze
Session als Input. Deshalb: Instructions unter 2.000 Zeichen (Test wacht),
`reasoning.effort: low` (mit 400-Fallback ohne das Feld), Leerlauf-Leine
nach fünf Minuten Stille, Mini-Modell per `SPRECHEN_MODELL` umschaltbar.
Gesprächsregeln: erst handeln, dann reden; das erste Nutzerziel ist der
rote Faden; ein Satz, wenn er reicht.

## 2026-08-18 — KI kennt das ganze ERP, Rechte wie am Bildschirm

Die Schema-Doku der KI (`src/modules/ki/schema-doku.ts`) deckt alle
Tabellen ab; der Finanzblock hängt nur im Systemprompt, wenn der Fragende
den Bereich sehen darf (Rolle/Befugnis), zusätzlich blockt die
FINANZ_SPERRE die Finanztabellen im Read-only-SQL. Gegen das Veralten wacht
ein Test, der alle DB-Tabellen mit der Doku abgleicht — neue Tabellen machen
die Suite rot, bis sie dokumentiert oder begründet versteckt sind.

## 2026-08-18 — Sprachmodus: OpenAI Realtime + Sammeln statt Sofort-Buchen

Echtzeit-Gespräch (WebRTC, Speech-to-Speech) für die Arbeit mit den Händen
an der Ware. Grundsatz: LESEN antwortet live, SCHREIBEN wird nur GESAMMELT
(`sprach_vorgaenge`, Status offen) und nach der Sitzung in der Prüftabelle
gesichtet und im Bulk gebucht — die Stimme bucht nie direkt. Der Server
mintet nur kurzlebige Client Secrets; alle Wirkung läuft über die
Werkzeug-Route mit Torwächter. Whisper-Stille-Halluzinationen (Amara/Sender-
floskeln) werden gefiltert. Doku: [prozesse.md](prozesse.md).

## 2026-08-17 — Finanzmodul in Ausbaustufen (Zahlungen → Verträge → Darlehen/Steuern → Prognose)

Cashflow-Wahrheit im ERP statt Bankkonto-Raterei: Zahlungsregister mit
Teilzahlungen und Zahlplan, Verträge mit Kündigungsmechanik, Darlehen und
Steuertermine, 13-Wochen-Prognose mit Unterdeckungswarnung und Umsatzplan.
Eigener Bereich `finanzen` mit Befugnis; Chamäleon-Navigation zeigt die
Gruppe nur mit aktivem Finanzprozess. Kein Hauptbuch — Belege statt
Journalbuchungen bleiben Absicht.

## 2026-08-17 — Marke KRNL (Hexcore) als System-Identität

Eigenname statt „das ERP": Wortmarke KRNL, Hexcore-Zeichen (eine Quelle in
`src/components/marke.tsx` für Splash, Sidebar, Login, Icons), Signal-
Orange führt, Kernel-Violett antwortet (violett = Entscheidungs-/
Schreibakzent). Boot-Splash einmal je Sitzung. Das Hexcore ist im
Sprachmodus die Zustandsanzeige (pulsiert beim Hören, atmet beim Antworten).

## 2026-08-17 — Befugnisse: feingranulare Rechte hart im Torwächter

Rollen bleiben grob (admin, mitarbeiter, lager, fertigung); Befugnisse
erweitern sie je Nutzer (z. B. `finanzen:zugriff`, Freigabelimits).
Geprüft wird zentral im Torwächter, nicht in der Oberfläche — die UI blendet
nur aus, verlassen darf man sich allein auf die Server-Prüfung.

## 2026-08-17 — Spracheingabe serverseitig (Whisper), nicht im Browser

Browser-Spracherkennung ist je Gerät verschieden und schwach bei
Fachvokabular. Deshalb: MediaRecorder nimmt auf, `/api/transkription`
transkribiert serverseitig (ein Modell für alle Geräte). Diktat landet im
Eingabefeld — abgeschickt wird bewusst von Hand.

## 2026-08-16 — Prozess-ERP: Registry + Torwächter als einziger Schreibweg

Der große Umbau: jede fachliche Aktion ist ein Eintrag in der Aktions-
Registry (zod-Schema, Rechte, Beleg-Bindung), ausgeführt NUR über den
Torwächter (`aktionAusfuehrenGeprueft` — validiert, prüft Rechte, schreibt
Audit). Prozesse sind Daten in der DB (Versionen, Schritte, Übergänge),
Masken werden aus Schritten generiert, die Navigation ist eine Projektion
der aktiven Prozesse (Chamäleon), Pakete schalten Geschäftsmodelle um.
Vollständigkeits-Wächter: jede Server-Action läuft über die Registry oder
steht begründet auf einer Ausnahme-Liste. Doku: [prozesse.md](prozesse.md).

## 2026-08-16 — Wächter-Tests: Konventionen erzwingen statt erinnern

Grundsatzentscheidung der Codebasis: Jede Konvention, die „immer mitwachsen
muss" (Registry-Abdeckung, KI-Schema-Doku, Job-Katalog, Migrations-Regeln,
Doku-Index), bekommt einen Test, der bei Verstoß die Suite rot macht —
handgepflegt bleibt erlaubt, vergessen nicht. Neue Features folgen dem
Muster, statt neue „bitte dran denken"-Regeln zu erzeugen.

## 2026-08-10 — Demodaten nur auf Knopfdruck, nie automatisch

Kein Seed beim Deploy: Demodaten kommen explizit (`SEED_DEMO=true` bzw.
Seed-Skript), und der Knopf „Demodaten löschen" (Einstellungen, nur Admin)
räumt sie vollständig — mit Behalten-Liste für Systemtabellen. Später
ergänzt: Reset-Skript verweigert Supabase-URLs ohne ausdrückliches
`ALLOW_REMOTE_RESET=yes`.

## 2026-08-07 — Bestandsbewertung als unveränderliche Wertschichten (AVCO)

Gleitender Durchschnitt mit append-only `stock_valuation_layers` (jede
Schicht trägt Laufsummen), Einstandskosten verteilen Fracht/Zoll auf den
Warenwert, Fremdwährung über Wechselkurse. Wie beim Bestands-Ledger gilt:
nie überschreiben, immer anfügen.

## 2026-08-05 — Odoo-Nachbau: Semantik übernehmen, Code nicht

Das ERP baut die bei ANVIL genutzten Odoo-Funktionen nach — mit den
technischen Odoo-18-Statuswerten und -Abläufen als Referenz
([odoo-referenz/](odoo-referenz/)), aber eigenem, schlankem Code. Deutsche
Domänensprache im ganzen System (Code-Bezeichner, UI, Doku, Commits).

## 2026-08-05 — SQL-first: Fachlogik in Postgres, Migrationen unveränderlich

Buchungslogik, Statusmaschinen und Belegnummern leben als Postgres-
Funktionen (atomar, kein halb gebuchter Zustand); der Migrations-Runner
spielt checksummierte SQL-Dateien in je einer Transaktion ein — einmal
eingespielte Migrationen sind unveränderlich. Kein ORM: das wäre eine
zweite Schema-Wahrheit ohne Gegenwert. Details: [architektur.md](architektur.md).

## 2026-08-05 — Versand direkt über DHL, Sendcloud raus

Statt Sendcloud als Zwischenhändler ein eigener typisierter Client gegen
die DHL Parcel DE Shipping API v2 (Labels, Tracking, Retouren, Zoll).
Referenz: [api-referenz/dhl.md](api-referenz/dhl.md); der alte Sendcloud-
Funktionsumfang bleibt als historische Referenz liegen.

## 2026-08-05 — Ein Deployment: Next.js + Postgres, Betrieb wahlweise

Modularer Monolith (Next.js App Router + Postgres/Supabase), Betrieb per
Docker, hinter VPN oder auf Vercel. Eigenständige Auth (scrypt, Cookie-
Sitzungen in Postgres) statt externem Anbieter. Outbox-Pattern für alle
Integrationen. Details: [architektur.md](architektur.md),
[betrieb.md](betrieb.md).
