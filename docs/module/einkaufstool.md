# Einkaufstool (Sourcing)

Vom Bedarf bis zur Lieferung in **einem durchgängigen Ablauf**: Anfragen an
Lieferanten (oft in China), Angebote, Muster, Entscheidung, Bestellung,
Sendung/Zoll, Wareneingang, Rechnung, DATEV. Das Tool funktioniert
vollständig ohne KI; jede Stelle ist so gebaut, dass ein Agent später
sichten, zuordnen, extrahieren und Entscheidungen, Preise und Mails
**vorbereiten** kann. Entschieden und gesendet wird immer von Menschen.

Begründung und Betreiber-Entscheidungen: Entscheidungslog
[2026-09-30 „Einkaufstool"](../entscheidungen.md). Die Bestellung selbst
(Status, Positionen, Wareneingang, Rechnung) beschreibt
[einkauf.md](einkauf.md).

## Ausbaustufen

| Stufe | Inhalt | Stand |
|---|---|---|
| 1 | Google-Anbindung, Dokumente in Drive, Lieferantenakte, Dienstleistungen ohne Wareneingang (0092) | umgesetzt |
| 2a | Einkaufspostfach lesen und zuordnen, Posteingang, Wiedervorlagen (0093) | umgesetzt |
| 2b | Aus KRNL schreiben, Vorlagen je Sprache, Übersetzung, Bestell-PDF (0094) | umgesetzt |
| 3 | Einkaufsprojekt: Anfragen, Angebote, Vergleich auf Einstand, Entscheidung | geplant |
| 4 | Bemusterung (Golden Sample), Werkzeuge/Molds, Lieferantenverträge | geplant |
| 5 | Eingangssendungen (Sammelfracht), Zoll, Pflichtdokumente, Cockpit, DATEV | geplant |
| 6 | Agent — nur Entwürfe, bei jeder eingehenden Mail | geplant |

## Stufe 1 — Ablage, Dokumente, Lieferantenakte (0092)

### Google-Anbindung (`src/modules/google/`)

- **Anmeldung:** Dienstkonto per signiertem JWT (RS256, `node:crypto`), REST
  per `fetch` — keine googleapis-Abhängigkeit (`auth.ts`).
- **Drive ohne Delegation:** Das Dienstkonto ist **Inhaltsmanager der
  geteilten Ablage „Einkauf"** und legt dort selbst an (`drive.ts`, überall
  `supportsAllDrives`).
- **Gmail** (ab Stufe 2a, `gmail.ts`) mit domänenweiter Delegation, nur
  Scope `gmail.modify`, nur für das Einkaufspostfach.
- **Env:** `GOOGLE_DIENSTKONTO_JSON` (Schlüsseldatei, JSON oder Base64),
  `GOOGLE_EINKAUF_ABLAGE_ID` (ID der geteilten Ablage), `EINKAUF_POSTFACH`.
  `GOOGLE_FAKE=1` ersetzt Google durch eine Attrappe im Speicher
  (`google-fake.ts`) — für Tests, Staging und den lokalen Browsertest.
- Einstellungen → Schnittstellen zeigt die Karte „Google Workspace" mit dem
  Knopf **Ablage einrichten** (`einkauf.ablage_einrichten`, legt die
  Hauptordner Lieferanten, Projekte, Artikel, Eingang an); der
  Dienste-Wächter prüft Anmeldung und Sichtbarkeit der Ablage.

### Dokumente

- **Die Datei liegt in Drive**, KRNL hält nur den Index:
  - `dokumente`: Art (Zeichnung, Gerber, STEP, AI, BOM, Angebot, PI, CI,
    Packing List, Rechnung, B/L-AWB, Zollbescheid, Vertrag, NDA, Foto,
    Sonstiges), Revision, Größe, md5, Quelle, Lieferant.
  - `dokument_verweise`: welche Datei an welchem Beleg hängt — n:m, eine
    Zeichnung hängt an Artikel, Projekt und Bestellung zugleich.
- **Ordnerbaum:** Lieferanten/‹Name›/‹Bestellnummer›,
  Lieferanten/‹Name›/Rechnungen, Artikel/‹Name›. `drive_ordner` merkt sich
  jeden Ordner; fehlt der Eintrag (z. B. nach „Betriebsdaten löschen"), wird
  zuerst ein gleichnamiger Ordner gesucht statt ein zweiter angelegt.
- **Hochladen in drei Takten** (Vercel lässt nur 4,5 MB je Anfrage zu):
  1. `einkauf.upload_vorbereiten` legt bei Google die Upload-Sitzung im
     Ordner des Belegs an. Die Sitzungsadresse (selbst eine Berechtigung)
     bleibt in `upload_sitzungen` — der Browser kennt nur die ID.
  2. Der Browser schickt Stücke à 4 MiB an `/api/dokumente/stueck` (reiner
     Transport, schreibt nichts).
  3. `einkauf.dokument_registrieren` prüft die fertige Datei bei Google
     (Ordner und Größe der Sitzung, nur der eigene Upload) und legt den Index
     an. Der Datei-ID aus dem Browser wird nie ungeprüft geglaubt.
- **Weitere Aktionen:** `einkauf.dokument_verknuepfen`,
  `einkauf.dokument_loesen` (die Datei bleibt in Drive),
  `einkauf.dokument_aendern` (Art, Revision, Notiz). Die Art wird aus dem
  Dateinamen vorbelegt (`.step` → STEP, „PI-…" → Proforma …).
- **Oberfläche:** Baustein „Dokumente" (Upload per Auswahl oder Ablegen, je
  Datei Fortschrittsbalken, Art/Revision inline) an Bestellung, Rechnung,
  Artikel und Lieferant. Hochladen braucht Schreibrecht im Einkauf.

### Lieferantenakte (`/einkauf/lieferanten`)

- **Liste** aller Lieferanten mit Sprache, Einkäufer, offenen Bestellungen und
  Dateien; Suche nach Name oder Maildomain.
- **Akte je Lieferant:** Einkaufsdaten, eigene Dateien, Dateien an Bestellungen
  und Rechnungen, Bestellungen, offene Rechnungen, Lieferantenpreise, Verlauf.
  Seit Stufe 2a auch Mail-Threads und Wiedervorlagen; Projekte folgen mit
  Stufe 3.
- **Einkaufsdaten** (`einkauf.lieferantendaten_setzen`): Sprache (de/en/zh),
  **Maildomains** (je Domain genau ein Lieferant — sie ordnen ab Stufe 2a
  eingehende Mails zu; bei Freemailern die volle Adresse, siehe unten),
  zuständiger Einkäufer, Standard-Incoterm und -Währung.
- Firmendaten tragen jetzt **EORI** und USt-IdNr. (für Spediteur und Zoll).

### Bestellungen: Dienstleistungen und Preise

- **Dienstleistungen** (`product_templates.type = 'service'`: Regale, Montage,
  Werkzeugkosten …) kommen nicht ins Lager. Eine reine Dienstleistungs-
  Bestellung hat keinen Wareneingang; die Weiche „Lagerware dabei?" im
  Bestellprozess führt direkt zu Rechnung und Abrechnung
  (`prozess_beleg_daten` liefert `hat_lagerware`). Dienstleistungen rechnen
  nach Bestellmenge ab (`bill_policy 'ordered'`, per Trigger erzwungen).
- **Einkaufspreise mit 6 Nachkommastellen** (`purchase_order_lines.price_unit`,
  `vendor_prices.price`, `vendor_bill_lines.price_unit`): Kleinteile kosten
  0,0034 USD.

### Nachweis

- `tests/google-auth.test.ts` — JWT-Signatur mit erzeugtem Schlüssel,
  Schlüsseldatei als JSON/Base64, Konfigurations-Regeln, Helfer.
- `tests/prozesse/einkauf-dokumente.test.ts` — Ablage ohne Doppel,
  Stück-Upload mit Prüfung, fremde Datei und fremder Nutzer abgewiesen,
  Verknüpfen/Lösen, eindeutige Maildomains, 6-stellige Preise, Dienstleistung
  ohne Wareneingang.
- Fixture-Lauf „Betriebsausstattung: nur Dienstleistung, ohne Wareneingang"
  (`src/modules/prozesse/fixtures/einkauf.ts`).

## Stufe 2a — Einkaufspostfach lesen und zuordnen (0093)

### Abgleich (`src/modules/einkauf/postfach-abgleich.ts`)

- **Cron** `/api/cron?task=mail` jede Minute (`vercel.json`); von Hand über
  „Jetzt abgleichen" im Posteingang und unter Einstellungen → Schnittstellen
  (`integrationen.postfach_abgleichen`, nur Admin).
- **Cursor:** Gmails `historyId` in `settings['einkauf_postfach']`. Der
  erste Lauf holt die letzten 30 Tage; kennt Google den Cursor nicht mehr
  (nach etwa einer Woche Stillstand), liest KRNL die letzten 7 Tage neu.
  Doppelt übernommen wird nie — die Gmail-Nachrichten-ID ist eindeutig.
- **Zeitbudget** 40 s: Reicht es nicht, bleibt der Cursor stehen und der
  nächste Lauf überspringt das schon Übernommene. Auch der Job-Runner hat
  jetzt ein Budget (`JOB_BUDGET_MS`): nicht begonnene Jobs gehen zurück in
  die Warteschlange, statt mitten im Handler abgeschossen zu werden.
- **Richtung:** Label SENT oder Absender = Postfach → Ausgang. Direkt in
  Gmail geschriebene Mails erscheinen damit ebenfalls im Thread.
- **Weitergeleitete Alt-Threads:** Schreibt ein Kollege der eigenen Domain an
  das Postfach und der Text trägt einen Weiterleitungskopf (Gmail, Outlook,
  Apple Mail; deutsch/englisch), zählen der **ursprüngliche** Absender, sein
  Datum und sein Betreff (`quelle 'weitergeleitet'`, `erfasst_von` =
  Weiterleitender). So kommen ausgewählte Threads aus Tinos Postfach herein,
  ohne dass KRNL darauf zugreift.
- Entwürfe, Spam, Papierkorb und Chats werden übersprungen.

### Zerlegen (`src/modules/einkauf/mail-zerlegen.ts`, pur)

- multipart-Baum der Gmail-API, Zeichensatz aus dem Content-Type — auch
  **GBK/GB2312** chinesischer Lieferanten; RFC-2047-Köpfe; nur HTML → Text als
  Rückfall.
- `zitatTrennen`: Lieferanten zitieren bei jeder Antwort den ganzen Verlauf.
  Die Thread-Ansicht zeigt das Neue und klappt das Zitat ein („On … wrote:",
  „Am … schrieb", Outlook-Trenner, „发件人:", „>"-Blöcke).

### Zuordnung (SQL `mail_thread_zuordnen`)

1. **Bestellnummer im Betreff** (`P00042`) → Bestellung und ihr Lieferant.
2. Sonst der **Gesprächspartner** → Lieferant über `partners.mail_domains`:
   Absender der ersten eingehenden Nachricht, bei einem von uns begonnenen
   Thread der erste Empfänger. Domains passen auch auf Subdomains.
3. **Freemailer** (qq.com, 163.com, 126.com, foxmail.com, gmail.com …) sagen
   über den Lieferanten nichts — für sie trägt die Lieferantenakte die
   **volle Adresse** ein; die Domain allein wird abgewiesen
   (`einkauf/mail-regeln.ts`). Die volle Adresse gewinnt vor der Domain.
4. Folgemails erben die Zuordnung des Threads. Der zuständige Einkäufer
   kommt aus `partners.einkaeufer_id`.
5. Die Regel überschreibt **nie** eine menschliche Zuordnung
   (`zugeordnet_durch 'mensch'`) — und ab Stufe 6 keine des Agenten.

Was die Regel nicht erkennt, bleibt im Posteingang unter „Nicht zugeordnet".
`einkauf.mail_zuordnen` ordnet von Hand zu (Lieferant, Bestellung,
Zuständig) und merkt sich auf Wunsch den Absender in der Lieferantenakte —
danach läuft es für diesen Lieferanten von selbst.

### Anhänge

- Je Anhang ein Outbox-Job `gmail_anhang_ablegen`
  (`einkauf/anhang-ablage.ts`): in den Drive-Ordner der Bestellung bzw. des
  Lieferanten, ohne Zuordnung nach **Eingang**; verknüpft mit Thread,
  Lieferant und Bestellung.
- **Keine Doppel:** Schickt ein Lieferant dieselbe Zeichnung mit jeder
  Antwort erneut, wird der gleiche Inhalt (md5) beim selben Lieferanten nur
  verknüpft, nicht noch einmal abgelegt.
- Kleine Bilder (< 20 KB) gelten als Signatur-Logo und werden nicht abgelegt.
- Beim Zuordnen von Hand ziehen die Dateien aus dem Eingang in den Ordner
  des Lieferanten bzw. der Bestellung um (best effort).
- Gmail vergibt Anhang-IDs bei jedem Abruf neu; ist die gespeicherte
  verfallen, holt der Job die Nachricht frisch.
- Drive-Uploads über 5 MB laufen als fortsetzbarer Upload (Multipart trägt
  bei Google nur 5 MB).

### Oberfläche

- **Posteingang** `/einkauf/posteingang`: Ansichten Offen, Wartet auf uns,
  Wartet auf Lieferant, Nicht zugeordnet, Meine, Erledigt, Alle; Suche über
  Betreff, Lieferant, Absender und Volltext (`suche`, tsvector 'simple').
  Menüzähler: offene Threads, deren letzte Nachricht vom Lieferanten kommt.
- **Thread** `/einkauf/posteingang/[id]`: Nachrichten in zeitlicher Folge
  (ältere eingeklappt, Zitate eingeklappt), Anhänge mit Link in die Ablage,
  **Originaldarstellung** erst auf Klick in einem iframe ohne Skripte, mit
  CSP ohne Fremdbilder (Tracking-Pixel laden nicht); Zuordnung, Status
  (erledigt/ignoriert/wieder offen), Gespräch von Hand erfassen,
  Wiedervorlagen, Dokumente, Verlauf.
- **Status:** Eine neue Nachricht des Lieferanten holt einen erledigten
  Thread zurück in den Posteingang; ignorierte bleiben still.
- **Alibaba-Chats und Telefonate** (`einkauf.nachricht_erfassen`): Text
  einfügen, Kanal und Richtung wählen — als neuer Thread am Lieferanten oder
  als Nachricht in einem bestehenden. Screenshots als Dokument am Thread.
- **Wiedervorlagen** (`einkauf.wiedervorlage_anlegen`/`_erledigen`) an
  Thread, Lieferant, Bestellung oder Rechnung; Liste
  `/einkauf/wiedervorlagen` (Meine/Alle, Überfälliges oben), Menüzähler =
  heute fällig oder überfällig. Regelbasierte Wiedervorlagen (fehlende PI,
  ETA überfällig) kommen mit dem Cockpit in Stufe 5.
- Lieferantenakte und Bestellung zeigen ihre Mail-Threads und
  Wiedervorlagen, die Rechnung ihre Wiedervorlagen.
- **Ohne echtes Gmail** (`GOOGLE_FAKE=1`, lokal/Staging): `POST
  /api/google-fake/mail` (nur Admin) liefert eine Mail ins Attrappen-Postfach
  ein — Grundlage des Browsertests und von Vorführungen.

### Nachweis

- `tests/mail-zerlegen.test.ts` — multipart, GBK, HTML-Rückfall,
  Adresslisten, RFC 2047, Betreffkern, Datumsformate, Weiterleitungsköpfe
  (Gmail en/de, Outlook, Apple Mail), Zitat-Trennung, Freemail-Regeln.
- `tests/prozesse/einkauf-postfach.test.ts` — Erstabgleich und zweiter Lauf
  ohne Doppel; Zuordnung per Subdomain, Freemail-Adresse, Bestellnummer und
  Empfänger; Anhänge in Bestell-/Lieferantenordner, gleicher Inhalt nur
  verknüpft; Gesendet = Ausgang; Wiederöffnen bei Antwort; Entwürfe
  übersprungen; weitergeleiteter Alt-Thread; menschliche Zuordnung mit
  „Absender merken" und Umzug aus dem Eingang, von der Regel nicht
  überschrieben; Alibaba-Erfassung; Wiedervorlagen; Rückfall bei
  abgelaufenem Verlauf; Zeitbudget.

## Stufe 2b — aus KRNL schreiben, Vorlagen, Übersetzung (0094)

### Entwurf als Beleg, Prozess `mail_versand`

- Jede ausgehende Mail ist ein **Entwurf** (`mail_entwuerfe`): Empfänger,
  Betreff, **deutscher Text zum Mitlesen** und der **Text in der Sprache des
  Lieferanten** (de/en/zh aus der Lieferantenakte; ohne Angabe Deutsch für
  deutsche, sonst Englisch), Anhänge aus der Ablage, „Antwort erwartet bis".
- Prozess `mail_versand`: **Entwurf schreiben** (`einkauf.mail_entwurf_anlegen`)
  → **Freigeben und senden** (`einkauf.mail_freigeben`) → Dienst
  **gmail_senden** (Zustand `gesendet`) — oder **Verwerfen**. Bearbeiten
  (`einkauf.mail_entwurf_aendern`) und Übersetzen (`einkauf.mail_uebersetzen`)
  sind Arbeit am Entwurf, keine Schritte.
- **Freigeben tut immer ein Mensch:** Die Aktion ist nicht für die KI
  freigegeben; der Agent (Stufe 6) schreibt nur Entwürfe (`quelle 'agent'`).
- Vor dem Senden prüft KRNL: Empfänger, Betreff, Text in der Versandsprache,
  **offene Platzhalter** (`[bestellnummer]` …) und die Größe der Anhänge
  (höchstens 18 MB — Gmail nimmt 25 MB inklusive Kodierung). Große Dateien
  gehen als Drive-Link oder per WeTransfer.

### Senden (`src/modules/einkauf/mail-senden.ts`, `mail-bauen.ts`)

- MIME selbst gebaut (UTF-8 überall, RFC 2047/2231 für Betreff, Namen und
  Dateinamen, reines ASCII auf der Leitung), gesendet über die Gmail-API
  (`messages.send`, über 3,5 MB als Upload bis 35 MB).
- **Im selben Gespräch:** threadId des Gmail-Threads plus `In-Reply-To`
  (letzte Nachricht) und `References` (alle, gekürzt auf 20), Betreff
  „Re: …" — so landet die Antwort auch bei QQ, 163 oder Outlook im Thread.
- Danach steht die Mail als Nachricht im Thread (Deutsch daneben), der
  Entwurf ist `gesendet`; der nächste Abgleich erkennt sie an der Gmail-ID.
  Eine neue Mail ohne Thread eröffnet einen. Mit „Antwort erwartet bis"
  entsteht eine Wiedervorlage am Thread.
- Scheitert Google, steht der Fehler am Entwurf; der Job wiederholt mit
  Backoff.

### Vorlagen (`mail_vorlagen`)

Fünf Anlässe × Deutsch/Englisch/Chinesisch: **Preis-/Angebotsanfrage**,
**PI/Rechnung anfordern**, **Liefertermin & Tracking**, **Muster-Feedback**,
**Bestellung senden**. Platzhalter `{{ansprechpartner}}` (Vorname aus der
letzten Mail des Lieferanten, sonst „zusammen"/„Sir or Madam"/„尊敬的供应商"),
`{{bestellnummer}}`, `{{liefertermin}}`, `{{einkaeufer}}`, `{{firma}}`,
`{{lieferant}}`. Aus einer Vorlage entstehen beide Texte zugleich — für
Vorlagen braucht es keine Übersetzung. Vorlagen sind Einrichtung und
überstehen „Betriebsdaten löschen".

### Übersetzung

- **Eingang:** Der Abgleich erkennt die Sprache jeder Nachricht
  (`spracheErkennen`); **chinesische** Mails vom Lieferanten übersetzt der
  Job `mail_uebersetzen` automatisch ins Deutsche, die deutsche Fassung
  steht im Thread unter dem Original. Andere auf Knopfdruck
  (`einkauf.nachricht_uebersetzen`).
- **Entwurf:** „Deutsch → Chinesisch" (und zurück) per KI — Zahlen, Maße,
  Teilenummern und Incoterms bleiben unverändert (`src/modules/ki/uebersetzen.ts`).
- KI-Ebene **Übersetzung** (Einstellungen → KI-Modelle, Standard Sonnet 5);
  jeder Aufruf mit Tokens in `ki_verbrauch`. `KI_FAKE=1` markiert nur.

### Bestellung per Mail mit PDF

- „Per E-Mail senden" an der Bestellung legt mit angebundenem Postfach
  einen **Entwurf mit Vorlage „Bestellung" in der Lieferantensprache** an und
  hängt das **Bestell-PDF** an (`src/modules/einkauf/bestellung-pdf.ts`,
  Englisch für ausländische, Deutsch für deutsche Lieferanten; abgelegt als
  Dokument „Bestellung" im Bestellordner). Ohne Postfach bleibt der alte Weg.
- Die Bestellung wird dabei **nicht** mehr auf `sent` gesetzt: Kein
  Prozessschritt bildet `sent` ab, die Bestellung verlor danach ihren Platz
  im Ablauf. Der Versand steht im Verlauf der Bestellung.

### Oberfläche

- **Thread:** Karte „Antworten" (Vorlage wählen → Entwurf) und die offenen
  Entwürfe des Threads; je Nachricht die deutsche Fassung bzw. „Ins Deutsche
  übersetzen".
- **Lieferantenakte und Bestellung:** „Neue Mail" mit Vorlage (an der
  Bestellung optional mit Bestell-PDF).
- **Entwurf** `/einkauf/entwuerfe/[id]`: Deutsch und Zielsprache
  nebeneinander, Übersetzen in beide Richtungen, Anhänge aus Thread,
  Lieferant und Bestellung, „Antwort erwartet bis", Speichern/Senden in
  einem Formular, Warnung bei offenen Platzhaltern; dazu worauf man
  antwortet, Prozessdiagramm und Verlauf.
- **Liste** `/einkauf/entwuerfe` (Offen, Gesendet, Verworfen, Alle);
  Menüzähler = offene Entwürfe.

### Zurückgestellt: Download-Links aus KRNL

Befristete Links auf Dateien (`dokument_links`, `/d/[token]`) aus dem Plan
kommen später: vercel.app ist aus China oft nicht erreichbar, Freigaben
„für jeden mit Link" sind in geteilten Ablagen häufig per Richtlinie
gesperrt, und das Durchreichen großer Dateien durch die Funktion stößt an
Vercels Grenzen. Bis dahin: Anhang bis 18 MB, sonst Drive-Link oder
WeTransfer (Entscheidungslog 2026-09-30).

### Nachweis

- `tests/mail-bauen.test.ts` — Hin- und Rückweg der MIME-Nachricht
  (Chinesisch, HTML, Anhang mit Umlaut-Dateiname), Kopf-Kodierung,
  Thread-Köpfe, Vorlagen-Platzhalter, Spracherkennung.
- `tests/prozesse/einkauf-mailversand.test.ts` — Antwort im Thread mit
  Vorlage in Lieferantensprache, offene Platzhalter halten auf, Übersetzen
  mit Verbrauch, Senden mit In-Reply-To/References und Wiedervorlage, kein
  Doppel beim Abgleich, automatische Übersetzung chinesischer Eingänge,
  Bestellung mit PDF, Grenzen (Anhanggröße, Empfänger, Änderung nach
  Freigabe).
- Fixture-Läufe „Preisanfrage auf Chinesisch …" und „Entwurf verwerfen"
  (`src/modules/prozesse/fixtures/einkauf-mail.ts`).
