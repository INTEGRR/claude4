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
| Held | **Trailer** (rund 40 s, ein Auftrag einmal durch KRNL, Endkarte mit Knopf zum Erstgespräch), darunter Positionierung und Knöpfe — Abschnitt „Trailer" unten | ja |
| Prozess First | Gegenüberstellung „Sonst" / „In KRNL" + **Prozessversion zum Anfassen**: derselbe Ablauf einmal geschaltet (v1.4) und einmal als Entwurf mit einem zusätzlichen Qualitätscheck (v1.5). Ein Knopf schaltet um. | ja |
| Sprechen | Dialogpanel mit **Bestätigungstor**: die Stimme bekommt keine Sonderrechte | ja |
| Einstieg | drei Schritte (Aufnehmen, Zeichnen, Läuft) | — |
| Betrieb | eigene Instanz, Rückholbarkeit, Daten-TÜV | — |
| Kosten | Modellrechnung klassisches ERP-Projekt vs. KRNL, mit Reglern | ja |
| Registrierung | das Anmeldeformular | ja |

Die interaktiven Stücke sind Client-Komponenten im selben Verzeichnis
(`trailer.tsx`, `prozess-vorschau.tsx`, `sprech-vorschau.tsx`,
`kosten-rechner.tsx`, `registrierung.tsx`). Alles andere ist eine Server Component ohne
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
umgebrochen. Der Trailer wechselt unter 820 px Rahmenbreite auf eine
hochkante Bühne; die Steuerleiste zeigt unter 560 px nur noch die
Beschriftung des laufenden Kapitels. Unter 980 px verschwindet die
Kopfnavigation — ein Mobilmenü ist offen (siehe unten).

### Trailer

Der Held ist ein Film — aber **kein Video**: Er ist eine CSS-Zeitleiste in
[`trailer.tsx`](../src/app/start/trailer.tsx) mit den Stilen in
`start.css` (Abschnitt „Trailer", Präfix `tr-`, weil die Seite `.mono`,
`.anzeige`, `.knoten` usw. schon belegt). Text bleibt in jeder Größe scharf,
ist echter Text und kostet keine Video-Bytes.

**Ablauf** (Sekunden, Demodaten):

| Zeit | Szene | Was passiert |
|---|---|---|
| 0–4 | Auftakt | „Ein Auftrag. Ein System." |
| 4–9,5 | Shop | Bestellung #5012 aus Shopify, bezahlt → reserviert → Fertigung angestoßen |
| 9,5–15 | Fertigung | FA/0418, Material reserviert, baubare Menge 24 → 23 an Shopify |
| 15–20,5 | Versand | Scan, DHL-Label, Tracking an Shopify (die Versandmail schickt der Shop) |
| 20,5–28 | Einkauf im Ausland | Postfach mit Angeboten aus CN, PL, VN, US — Chinesisch wird übersetzt; Vergleich in Euro je Stück mit Fracht und Zoll, EZB-Kurs |
| 28–33,5 | Prozess | neuer Schritt „Qualitätscheck" kommt dazu, Version 1.5 wird geschaltet |
| 33,5–38,6 | KI | „Was ist heute fällig?" mit drei Antworten |
| 38,6–41 | Endkarte | Claim, **„Erstgespräch anfragen →"** (Link auf `#anmelden`), „Nochmal ansehen" |

**Bedienung:** Er startet von selbst, sobald die Schriften geladen sind und
der Held im Bild ist. Die Steuerleiste darunter hat Pause/Abspielen, sechs
Kapitel (zugleich der Fortschrittsfaden, anklickbar), die Zeit und
„Überspringen" bzw. „Nochmal". Ein Klick auf die Bühne pausiert. Außer Sicht
(unter 30 % sichtbar) oder im Hintergrund-Tab hält er an und läuft beim
Zurückkommen weiter. Bei `prefers-reduced-motion` steht sofort die Endkarte
da; der Film läuft nur auf Knopfdruck.

**Technik:** Alle Animationen hängen mit absoluter Verzögerung an
`.tr-laeuft`. Pause, Kapitel und Überspringen setzen über die Web Animations
API nur `currentTime` aller `tr-`-Animationen unter der Wurzel; die Uhr ist
die Animation `tr-zeit` (Fortschrittslinie), ihr `animationend` markiert das
Ende. Die Bühne hat eine feste logische Größe — 16:9 (1920×1080) ab 820 px
Rahmenbreite oder bei querem Fenster, sonst hochkant (1080×1400) — und wird
per transform skaliert, höchstens auf 85 bzw. 80 % der Fensterhöhe
(`masse` in [`trailer-logik.ts`](../src/app/start/trailer-logik.ts)).

**Szene ändern:** Der Zeitplan steht an drei Stellen — `--t`/`--e` der Szene
in `trailer.tsx`, die absoluten Zeiten in `start.css`, `KAPITEL`/`DAUER` in
`trailer-logik.ts`. Der Wächter `tests/trailer.test.ts` gleicht Szenen,
Kapitel, Uhr und Fortschrittsfaden ab.

**Ehrlichkeit:** Alle Namen und Zahlen sind Demodaten (die Bühne sagt es
oben rechts), jede Behauptung muss das System aber wirklich können. Darum
z. B. nur die Sprachen, die KRNL im Einkauf kennt (Deutsch, Englisch,
Chinesisch — automatisch übersetzt wird Chinesisch), der Einstand mit
EZB-Kurs, Fracht und Zoll so, wie `einstand_schaetzen` ihn rechnet, und die
Versandmail beim Shop statt bei KRNL. Wer eine Szene ergänzt, prüft das
zuerst im Code.

Der 15-Sekunden-Werbeschnitt (eigenständige HTML-Datei und MP4 für Anzeigen)
ist nicht Teil des Repos.

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
Kontakt, Adresse, Fehlerbeschreibung, Bestellnummer optional. Ein iframe
im Shop geht nicht, die Sicherheits-Header verbieten das Einbetten
(`X-Frame-Options: DENY`). Für Kunden läuft das Formular deshalb **im Shop
selbst** (App Proxy, nächster Abschnitt); ist `REPARATUR_SHOP_URL` gesetzt,
leitet `/service/reparatur` mit 308 dorthin um.

Der Eingang ist der **zweite Schreibweg ohne Sitzung**, nach dem Muster der
Registrierung (Entscheidungslog 2026-09-19) — an genau einer Stelle,
[`modules/reparatur/anfrage-eingang.ts`](../src/modules/reparatur/anfrage-eingang.ts)
(`reparaturanfrageAufnehmen`), mit zwei Kanälen: `POST /api/reparaturanfrage`
(JSON vom Website-Formular, Quelle `kundenformular`) und
`/api/shopify/proxy` (Formular im Shop, Quelle `shop`). Keine der beiden
Routen schreibt selbst; ein Wächter in `tests/reparatur-anfrage.test.ts`
hält beide Listen geschlossen. Die Regeln:

- genau eine Tabelle (`vorgaenge`), ein Insert — die Anfrage ist ein Vorgang
  des Prozesses `reparatur_anfrage` (Quelle `kundenformular`); der
  Reparaturauftrag entsteht erst, wenn ein Mitarbeiter die Anfrage im ERP
  über `reparatur.anfrage_annehmen` annimmt;
- Prüfregeln aus **einer** Quelle
  ([`modules/shared/reparaturanfrage.ts`](../src/modules/shared/reparaturanfrage.ts))
  für Formular, Route und Annahme; Längen werden beschnitten, nicht abgewiesen;
- Honigtopf, Drosselung je Absender-Hash (5 in 10 Minuten, gezählt in
  `vorgaenge.absender_hash` — kein Klartext-IP); Website: Hash der IP,
  Shop: Hash aus angemeldetem Kunden bzw. E-Mail (Begründung unten);
- doppelt Abgeschicktes (gleiche E-Mail, gleiche Fehlerbeschreibung,
  10 Minuten) bekommt die Nummer der ersten Anfrage statt einer zweiten;
  gleichzeitige Doppelklicks laufen je E-Mail hintereinander (Advisory-Lock),
  Insert, Audit und Outbox-Job in einer Transaktion;
- der Prozess-Schalter ist der Formular-Schalter: ist `reparatur_anfrage`
  abgeschaltet, antwortet die Route mit 503 und die Seite zeigt „derzeit
  nicht verfügbar";
- Nebenwirkungen nur über die Outbox: Eingangsbestätigung mit Vorgangsnummer
  an den Kunden (`send_repair_request_email`); die Hinweis-Mail an den
  Service (`REPARATUR_MAIL`, sonst Firmen-E-Mail) ist best effort
  (`serviceHinweisSenden`, nur beim ersten Eingang, nicht bei der Dublette);
- Audit-Eintrag mit Akteur `kundenformular`.

Wächter: `tests/reparatur-anfrage.test.ts` (Eingangsregeln, Felder =
Prozessfelder, Drosselabfrage, Registry-Statik, genau ein Schreibweg) und
der Prozesstest der Fixture `reparatur-anfrage.ts` (Annehmen, Ablehnen,
Kunde wiederverwenden); beide Kanäle durch die echten Routen:
`tests/prozesse/shop-reparatur.test.ts`.
Fachlich: [module/reparatur.md](module/reparatur.md).

---

## Im Shop (App Proxy)

Kunden füllen das Formular **auf der Shop-Domain** aus:
`https://anvil.gg/apps/reparatur`. Die Vercel-Adresse sehen sie nie, und
nichts auf der Seite verrät, dass ein ERP dahinter arbeitet
(Entscheidungslog 2026-10-01).

### Wie es läuft

```
Browser ──GET/POST https://anvil.gg/apps/reparatur──────────────────────▶ Shopify
Shopify ──GET/POST https://<erp>/api/shopify/proxy
            ?shop=…&logged_in_customer_id=…&path_prefix=/apps/reparatur
            &timestamp=…&signature=…  (serverseitig, ohne Cookies)──────▶ KRNL
KRNL    ──200, Content-Type: application/liquid──▶ Shopify rendert im Theme ──▶ Browser
```

- **Signatur ist die Zugangskontrolle.** Shopify signiert die Query mit dem
  Client Secret der App, an der der Proxy hängt — `SHOPIFY_PROXY_SECRET`
  (eigene App „reparatur", empfohlen), sonst `SHOPIFY_CLIENT_SECRET` (HMAC-SHA256; alle Parameter außer `signature`,
  dekodiert, Mehrfachwerte mit Komma, `key=value` sortiert und ohne Trenner
  verbunden — [`shopify-proxy.ts`](../src/modules/integrationen/shopify-proxy.ts)).
  Abgewiesen mit `401` als Klartext wird: falsche oder fehlende Signatur,
  Zeitstempel mehr als 90 Sekunden neben der Serverzeit, ein fremder `shop`
  (wenn `SHOPIFY_SHOP_DOMAIN` gesetzt ist), kein Schlüssel. Der Body ist
  nicht signiert — er wird wie jede Kundeneingabe geprüft. Mit
  `SHOPIFY_FAKE=1` und ohne Secret gilt ein fester Attrappen-Schlüssel
  (lokal, Tests); übersprungen wird die Prüfung nie. Der Test rechnet die
  drei in der Shopify-Doku abgedruckten Beispielsignaturen (Secret „hush")
  exakt nach — angemeldet, Gast mit leerer und ganz ohne Kunden-ID.
- **Schrägstrich am Ende.** Shopify ruft `/api/shopify/proxy/?…` auf. Die
  eingebaute Next-Umleitung auf die Fassung ohne Schrägstrich ist
  abgeschaltet (`skipTrailingSlashRedirect`) — ihr relativer `Location`
  landete über Shopify im Browser auf der Shop-Domain (404).
- **Liquid im Theme.** `application/liquid` lässt Shopify die Antwort im
  Theme rendern (Kopf, Navigation, Fuß des Shops). Die Seite trägt das
  **Kleid des Themes** ([`shop-seiten.ts`](../src/modules/reparatur/shop-seiten.ts)):
  Markup wie das Kontaktformular eines Dawn-Themes (`color-background-1`,
  `page-width page-width--narrow`, `field`/`field__input`/`field__label`,
  `select__select`, `button`), dazu dessen Stylesheet per
  `{{ 'section-contact-form.css' | asset_url | stylesheet_tag }}`. Eigenes CSS
  nur für Layout-Rückfälle — keine eigenen Farben oder Schriften (die
  ersten Fassung mit festen Rückfallfarben war im dunklen Theme
  unlesbar). Keine Assets oder absoluten URLs unseres Hosts, kein
  Systemname, keine Marke. Den Shopnamen liefert `{{ shop.name | escape }}`.
  Kunden werden **geduzt** wie im Shop, ohne Fachbegriffe.
- **Liquid-Injection ist ausgeschlossen.** Jeder Wert aus Kundeneingabe oder
  Datenbank wird HTML-escaped **und** `{`, `}`, `%` werden als
  `&#123;` `&#125;` `&#37;` geschrieben — ein getipptes `{{ … }}` oder
  `{% … %}` wertet Shopify nie aus, der Browser zeigt es trotzdem richtig.
  Die einzigen Liquid-Ausdrücke sind fest eingebaut (`LIQUID_AUSDRUECKE`).
- **Ohne Sitzung, ohne Post-Redirect-Get.** Shopify streicht Cookies in
  beide Richtungen und folgt Redirects selbst. Fehler zeigen das Formular
  mit Eingaben und Meldungen erneut (200), Erfolg zeigt die Danke-Seite mit
  der Vorgangsnummer und ersetzt den POST im Verlauf
  (`history.replaceState`); Neuladen schickt nichts erneut, und die
  Dublettenprüfung fängt den Rest. Bedienbar ohne JavaScript (schlichtes
  `<form method="post">` an `path_prefix`); das Inline-Skript (unter
  40 Zeilen) prüft nur Pflichtfelder vorab und sperrt doppeltes Absenden.
- **Drossel ohne IP.** Shopify ruft serverseitig, Vercel überschreibt
  `X-Forwarded-For` — gezählt würden Shopifys Egress-Adressen, und nach fünf
  Anfragen wäre der ganze Shop gesperrt. Der Schlüssel ist deshalb der Hash
  aus `shop:` + angemeldetem Kunden, sonst der E-Mail (5 in 10 Minuten,
  dieselbe Grenze wie auf der Website). Danach: Formular mit Hinweis, 429.
- **Vorbelegung für angemeldete Kunden.** `logged_in_customer_id` (von
  Shopify signiert, nur Ziffern übernommen) → `partners.shopify_customer_id`
  (`gid://shopify/Customer/<id>`): Name, E-Mail, Telefon, Adresse, Land —
  nur aus der eigenen Datenbank, kein Admin-API-Aufruf; dazu die letzten
  fünf Shopify-Bestellnummern als Vorschlagsliste (`<datalist>`). Ein
  unbekannter Kunde sieht das leere Formular. Der Vorgang bekommt keinen
  Partner — den ordnet wie bisher die Annahme per E-Mail zu; die
  Shopify-Kundennummer steht im Audit-Eintrag.
- **Hinweis-Mail nach der Antwort.** `after()` verschickt die Mail an den
  Service erst, wenn der Kunde seine Seite hat; die Bestätigung an den
  Kunden geht wie immer über die Outbox.
- **Pfade und Status.** Nur die Wurzel zeigt das Formular; jeder Unterpfad
  liefert eine neutrale 404-Seite, jede Störung eine neutrale Fehlerseite
  (500) — nie die Next-Seiten. Status: 200 (Formular, Fehler, Danke),
  404, 429 (gedrosselt), 503 (Prozess aus, beim Absenden), 500. Die
  Hinweisseiten enthalten kein Liquid, damit sie auch stimmen, falls
  Shopify Antworten mit Fehlerstatus nicht durchs Theme schickt. Ein
  Schrägstrich am Ende (`…/proxy/`) beantwortet Next mit einem relativen
  308 auf den Pfad ohne — dem folgt Shopify selbst.
- **Am Vorgang**: Badge „Shop-Formular" (`vorgaenge.quelle = 'shop'`).
- **Erreichbarkeit.** `src/proxy.ts` greift nur auf `/` — der Proxy-Pfad
  liegt nicht hinter der Login-Weiche. Deployment Protection: wie Webhook
  und Cron ausnehmen ([vercel-supabase.md](vercel-supabase.md),
  Abschnitt 6).
- **Header.** Next setzt an jeder Antwort `Vary: rsc, next-router-…` und die
  Sicherheits-Header aus `next.config.ts`; aus der Route lässt sich das
  nicht abstellen. Ob Shopify sie bei gerenderten Liquid-Seiten
  durchreicht, zeigt `curl -I` beim Livegang (Schritt 8 unten) — sie
  verraten höchstens das Framework, nicht das ERP.

Code: `src/app/api/shopify/proxy/[[...pfad]]/route.ts`
(HTTP, Vorbelegung), `shopify-proxy.ts` (Signatur, pur), `shop-seiten.ts`
(Seiten, pur), `anfrage-eingang.ts` (Eingang). Wächter:
`tests/shop-proxy.test.ts` (Signatur, Escaping, keine Spuren),
`tests/prozesse/shop-reparatur.test.ts` (Route gegen die Datenbank).

**Lokal ausprobieren:** `SHOPIFY_FAKE=1 node --experimental-strip-types
scripts/shop-proxy-url.ts [--kunde 123] [--basis http://localhost:3000]`
druckt eine signierte Adresse (90 Sekunden gültig) und ein `curl` zum
Absenden. Lokal rendert niemand das Liquid — `{{ shop.name }}` bleibt
stehen.

### Einrichtung (Betreiber)

1. **Dev Dashboard → neue App „reparatur"** (empfohlen statt einer neuen
   Version der KRNL-App: deren Version müsste alle Scopes wieder führen —
   einer vergessen, und KRNL verliert den Zugriff). Felder der Version:
   - *App URL:* `https://anvil.gg` (die App hat keine Admin-Oberfläche),
     **„Embed app in Shopify admin" aus**; Redirect-URLs leer, kein Legacy
     Install Flow.
   - *Scopes:* nur `write_app_proxy`.
   - *App proxy:* Prefix `apps`, Subpath `reparatur`, URL
     `https://<erp-domain>/api/shopify/proxy` (die Produktionsdomain des
     ERP, keine Preview-Adresse).
   Alternativ an der KRNL-App: alle bisherigen Scopes übernehmen und
   `write_app_proxy` ergänzen — dann entfällt Schritt 3b.
2. Die Version **releasen** und die App im Shop **installieren**
   (Distribution: eigener Shop).
3. Im **Shop-Admin** die Berechtigung bestätigen. 3b: das **Client
   Secret** der App „reparatur" (Dev Dashboard → Settings) in Vercel als
   `SHOPIFY_PROXY_SECRET` setzen und neu deployen — sonst weist KRNL jeden
   Aufruf mit 401 ab.
4. Optional: Shop-Admin → Einstellungen → Apps → die App →
   **Customize URL**, falls ein anderer Pfad gewünscht ist — das Formular
   übernimmt `path_prefix` von selbst.
5. **Navigation:** Shop-Admin → Inhalte → Menüs → URL-Weiterleitungen
   `/reparatur` → `/apps/reparatur`; Menüpunkt „Reparatur" auf
   `/apps/reparatur`. Alte Links auf die Vercel-Adresse fängt
   `REPARATUR_SHOP_URL=https://anvil.gg/apps/reparatur` (308 — Browser
   merken sich dauerhafte Umleitungen; zum Zurückdrehen Variable leeren
   und neu deployen, gemerkte Umleitungen bleiben bis zum Cache-Ende).
6. **Absender:** `MAIL_FROM` muss eine anvil.gg-Adresse sein (Domain in
   Resend verifiziert) — sonst kommt die Eingangsbestätigung von einem
   generischen Absender, und der Kunde sieht, dass etwas anderes dahinter
   steckt.
7. **Deployment Protection:** `/api/shopify/proxy` ausnehmen
   ([vercel-supabase.md](vercel-supabase.md), Abschnitt 6) — sonst landet
   Shopify an der Vercel-Anmeldung.
8. **Testen:** abgemeldet und angemeldet (Vorbelegung, Bestellnummern) je
   eine Anfrage absenden; Eingangsbestätigung prüfen (Absender!);
   `/apps/reparatur/gibts-nicht` zeigt die neutrale Seite im Theme;
   `curl -sI https://anvil.gg/apps/reparatur` — keine verräterischen Header
   (`x-vercel-*`, `x-nextjs-*`, `x-matched-path`, `server: Vercel`); im ERP
   den Vorgang mit Badge „Shop-Formular" öffnen.

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

Ihr Matcher ist nur `/` — die öffentlichen Eingänge (`/start`,
`/service/reparatur`, `/api/registrierung`, `/api/reparaturanfrage`,
`/api/shopify/proxy`) erreicht sie gar nicht. (Nicht zu verwechseln mit dem
Shopify **App Proxy** oben: gleicher Name, anderes Ding.)

---

## Offene Platzhalter (vor dem Livegang klären)

| Was | Wo | Warum offen |
|---|---|---|
| **Annahmen des Kostenrechners** | `ANNAHMEN` in [`kosten-rechner.tsx`](../src/app/start/kosten-rechner.tsx) | Lizenz je Nutzer, Beratungstage je Prozess, Schulungsanteil, Betrieb je Nutzer stammen aus dem Design-Handoff und sind branchenübliche Hausnummern, **keine geprüften Zahlen von ANVIL**. Solange sie stehen, ist die Disclaimer-Zeile („Modellrechnung für Jahr 1. Kein Angebot …") nicht verhandelbar. |
| **Empfänger der Hinweis-Mail** | `REGISTRIERUNG_MAIL` | bewusst nicht im Code hinterlegt |
| **Empfänger der Reparaturanfrage-Mail** | `REPARATUR_MAIL` | leer = Firmen-E-Mail aus den Einstellungen; für den Service-Posteingang setzen |
| **Reparaturformular im Shop** | `REPARATUR_SHOP_URL`, App-Proxy-Einrichtung | erst nach dem Release der App-Version mit `write_app_proxy` setzen (Abschnitt „Im Shop (App Proxy)") |
| **Mobilmenü** | Kopfnavigation unter 980 px | im Handoff als Folgeaufgabe markiert; die Sprungmarken sind über den Seitenfluss weiter erreichbar |
| **Eigenes Vercel-Projekt** | siehe [vercel-supabase.md](vercel-supabase.md) | solange die Seite im ERP-Deployment mitläuft, sperrt die Deployment Protection sie mit aus |

Nicht offen, sondern bewusst so: **keine erfundenen Referenzen, Logos oder
Kundenzahlen**. Was auf der Seite steht, kann das System.
