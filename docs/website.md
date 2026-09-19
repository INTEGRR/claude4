# Öffentliche Startseite, Registrierung und Reparaturanfrage

Die Seite **vor** dem Login: was KRNL ist, für wen, wie ein Einstieg abläuft —
und das Formular, über das sich Interessenten melden. Sie liegt unter
[`/start`](../src/app/start/page.tsx) und ist bewusst eigenständig gebaut,
weil sie später ein **eigenes Vercel-Deployment** bekommen soll.

Die Gegenseite — was passiert, wenn aus einem Interessenten ein Kunde wird —
steht in [prozesse.md](prozesse.md), Abschnitt „Onboarding einer frischen
Instanz". Die beiden Oberflächen erzählen absichtlich dieselbe Geschichte in
derselben Bildsprache: Aufnehmen → Zeichnen → Läuft.

---

## Aufbau

| Abschnitt | Inhalt | interaktiv |
|---|---|---|
| Held | Positionierung + **Prozessversion zum Anfassen**: derselbe Ablauf einmal geschaltet (v1.4) und einmal als Entwurf mit einem zusätzlichen Prüfschritt (v1.5). Ein Knopf schaltet um. | ja |
| Prozess First | Gegenüberstellung „Sonst" / „In KRNL" | — |
| Sprechen | Dialogpanel mit **Bestätigungstor**: die Stimme bekommt keine Sonderrechte | ja |
| Einstieg | drei Schritte (Aufnehmen, Zeichnen, Läuft) | — |
| Betrieb | eigene Instanz, Rückholbarkeit, Daten-TÜV | — |
| Kosten | Modellrechnung klassisches ERP-Projekt vs. KRNL, mit Reglern | ja |
| Registrierung | das Anmeldeformular | ja |

Die drei interaktiven Stücke sind Client-Komponenten im selben Verzeichnis
(`prozess-vorschau.tsx`, `sprech-vorschau.tsx`, `kosten-rechner.tsx`,
`registrierung.tsx`). Alles andere ist eine Server Component ohne
Datenbankzugriff — die Seite lässt sich statisch ausliefern.

### Gestaltung

Eigener Namensraum `.krnl-start` mit **eigenem Farbsystem** in
[`start.css`](../src/app/start/start.css): heller „Chassis"-Grund
(Papier/Aluminium), dunkle eingelassene Anzeigen für alles Technische,
Haarlinien statt Schatten. Anders als das ERP folgt die Seite **nicht** dem
Hell/Dunkel-Umschalter — eine Verkaufsseite hat genau ein Gesicht (dieselbe
Begründung wie beim Boot-Splash). Akzentdisziplin wie überall: Orange führt,
Violett antwortet.

Siebensegment-Zahlen (`Seg` in `anzeige.tsx`) sind **nur für echte Zahlen**
da, mit Geister-Achten dahinter — dieselbe Technik wie im Splash. Die
Schriftart wird in `globals.css` deklariert (`@font-face 'DSEG7'`) und muss
beim Herausziehen der Seite mitkommen.

**Responsiv**: Das Prozessdiagramm arbeitet mit Prozentkoordinaten und
142 px breiten Knoten und braucht rund 452 px Panelbreite, sonst laufen die
Knoten ineinander. Unterhalb von 1080 px wird deshalb die **Darstellung
getauscht** (senkrechte Liste, gleiche Knoten und Farben) statt der Graph
umgebrochen. Unter 980 px verschwindet die Kopfnavigation — ein
Mobilmenü ist offen (siehe unten).

---

## Registrierung

Das Formular schreibt über `POST /api/registrierung` in die Tabelle
`registrierungen` (Migration 0066). Das ist einer von zwei Schreibwegen ohne
Sitzung im ganzen System (der zweite ist die Reparaturanfrage, unten) und
läuft deshalb bewusst nicht über den Torwächter — der setzt einen
angemeldeten Nutzer mit Rolle voraus, und den gibt es hier per Definition
nicht.

Stattdessen ist der Weg so eng wie möglich:

- genau eine Tabelle, keine Verknüpfung zu Belegen, keine Nebenwirkung;
- Pflichtfeld- und Längenprüfung nach **denselben Regeln** wie im Formular
  ([`modules/shared/registrierung.ts`](../src/modules/shared/registrierung.ts)
  ist die eine Quelle — dem Client wird nichts geglaubt);
- Honigtopf-Feld gegen einfache Bots (für Menschen unsichtbar);
- Drosselung je Absender: höchstens 5 Eingänge in 10 Minuten. Gespeichert
  wird **kein Klartext-IP**, sondern ein mit `SESSION_SECRET` gesalzener
  Hash — Zweck ist ausschließlich die Drosselung;
- Eintrag im Audit-Log (`model = 'registrierung'`), damit die Instanz nichts
  still entgegennimmt.

Alles danach läuft wieder über die Registry:
`einstellungen.registrierung_status` (nurAdmin, beleggebunden) setzt den
Stand — offen, kontaktiert, erledigt, abgelehnt — und hält eine Notiz fest.
Die Arbeitsliste steht unter
[`/einstellungen/registrierungen`](../src/app/(erp)/einstellungen/registrierungen/page.tsx);
offene Eingänge stehen oben.

Wächter: `tests/registrierung.test.ts` (Eingangsregeln, Check-Constraint der
Stände, Drosselungsabfrage, Registry-Statik).

### Hinweis-Mail (optional)

Ist `REGISTRIERUNG_MAIL` gesetzt **und** der Mailversand konfiguriert
(`RESEND_API_KEY`, `MAIL_FROM`), geht bei jedem Eingang eine kurze Mail
dorthin. Schlägt der Versand fehl, ist die Registrierung trotzdem
gespeichert — sie darf nicht an der Benachrichtigung scheitern.

---

## Reparaturanfrage (/service/reparatur)

Die Seite `/service/reparatur` (außerhalb der `(erp)`-Gruppe, Optik der
Startseite, kein ERP-Rahmen) nimmt Reparaturanfragen von Kunden entgegen:
Kontakt, Adresse, Fehlerbeschreibung, Bestellnummer optional. Der Shop
verlinkt sie — ein iframe geht nicht, die Sicherheits-Header verbieten das
Einbetten (`X-Frame-Options: DENY`).

`POST /api/reparaturanfrage` ist der **zweite Schreibweg ohne Sitzung**,
nach dem Muster der Registrierung (Entscheidungslog 2026-09-19):

- genau eine Tabelle (`vorgaenge`), ein Insert — die Anfrage ist ein Vorgang
  des Prozesses `reparatur_anfrage` (Quelle `kundenformular`); der
  Reparaturauftrag entsteht erst, wenn ein Mitarbeiter die Anfrage im ERP
  über `reparatur.anfrage_annehmen` annimmt;
- Prüfregeln aus **einer** Quelle
  ([`modules/shared/reparaturanfrage.ts`](../src/modules/shared/reparaturanfrage.ts))
  für Formular, Route und Annahme; Längen werden beschnitten, nicht abgewiesen;
- Honigtopf, Drosselung je Absender-Hash (5 in 10 Minuten, gezählt in
  `vorgaenge.absender_hash` — kein Klartext-IP);
- der Prozess-Schalter ist der Formular-Schalter: ist `reparatur_anfrage`
  abgeschaltet, antwortet die Route mit 503 und die Seite zeigt „derzeit
  nicht verfügbar";
- Nebenwirkungen nur über die Outbox: Eingangsbestätigung mit Vorgangsnummer
  an den Kunden (`send_repair_request_email`); die Hinweis-Mail an den
  Service (`REPARATUR_MAIL`, sonst Firmen-E-Mail) ist best effort;
- Audit-Eintrag mit Akteur `kundenformular`.

Wächter: `tests/reparatur-anfrage.test.ts` (Eingangsregeln, Felder =
Prozessfelder, Drosselabfrage, Registry-Statik) und der Prozesstest der
Fixture `reparatur-anfrage.ts` (Annehmen, Ablehnen, Kunde wiederverwenden).
Fachlich: [module/reparatur.md](module/reparatur.md).

---

## Weiche vor dem Login

`src/proxy.ts` leitet Aufrufe der **Wurzel ohne Sitzungs-Cookie** auf
`/start`. Jede andere geschützte Seite geht weiterhin direkt zum
Anmeldeformular: wer `/verkauf` aufruft, will arbeiten, nicht lesen. Geprüft
wird nur das Vorhandensein des Cookies — die echte Prüfung bleibt bei
`currentUser()`, ein abgelaufenes Cookie landet also auf `/login` und nicht
auf der Werbeseite.

Die Datei hieß bis Next 16 `middleware.ts`; die Konvention wurde in `proxy`
umbenannt, Funktion und Verhalten sind identisch. Zieht die Startseite in
ein eigenes Deployment um, fällt sie ersatzlos weg.

---

## Offene Platzhalter (vor dem Livegang klären)

| Was | Wo | Warum offen |
|---|---|---|
| **Annahmen des Kostenrechners** | `ANNAHMEN` in [`kosten-rechner.tsx`](../src/app/start/kosten-rechner.tsx) | Lizenz je Nutzer, Beratungstage je Prozess, Schulungsanteil, Betrieb je Nutzer stammen aus dem Design-Handoff und sind branchenübliche Hausnummern, **keine geprüften Zahlen von ANVIL**. Solange sie stehen, ist die Disclaimer-Zeile („Modellrechnung für Jahr 1. Kein Angebot …") nicht verhandelbar. |
| **Empfänger der Hinweis-Mail** | `REGISTRIERUNG_MAIL` | bewusst nicht im Code hinterlegt |
| **Empfänger der Reparaturanfrage-Mail** | `REPARATUR_MAIL` | leer = Firmen-E-Mail aus den Einstellungen; für den Service-Posteingang setzen |
| **Mobilmenü** | Kopfnavigation unter 980 px | im Handoff als Folgeaufgabe markiert; die Sprungmarken sind über den Seitenfluss weiter erreichbar |
| **Eigenes Vercel-Projekt** | siehe [vercel-supabase.md](vercel-supabase.md) | solange die Seite im ERP-Deployment mitläuft, sperrt die Deployment Protection sie mit aus |

Nicht offen, sondern bewusst so: **keine erfundenen Referenzen, Logos oder
Kundenzahlen**. Was auf der Seite steht, kann das System.
