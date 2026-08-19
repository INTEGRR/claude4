# Entscheidungslog

Jede Architektur-, Produkt- und Betriebsentscheidung bekommt hier einen
datierten Eintrag — **im selben Commit wie die Umsetzung** (Regel in
AGENTS.md, Format vom Doku-Wächter `tests/doku.test.ts` geprüft). Einträge
werden nie umgeschrieben: wird eine Entscheidung revidiert, kommt ein neuer
Eintrag mit Verweis auf den alten. Neueste zuerst.

Format: `## JJJJ-MM-TT — Titel`, dann kurz: was entschieden, warum, wo
umgesetzt/dokumentiert.

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
