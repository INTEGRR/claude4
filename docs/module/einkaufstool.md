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
| 3 | Einkaufsprojekt: Anfragen, Angebote, Vergleich auf Einstand, Entscheidung, Bestellung, EZB-Kurse (0097) | umgesetzt |
| 4 | Bemusterung (Golden Sample) mit Musterpflicht, Werkzeuge/Molds, Lieferantenverträge und Preislisten, regelbasierte Wiedervorlagen (0107) | umgesetzt |
| 5 | Eingangssendungen (Sammelfracht) mit Landed Costs, Zoll (EUSt getrennt), lernende Fracht- und Zollsätze, Pflichtdokumente, Einkaufs-Cockpit, tägliche Telegram-Zusammenfassung, DATEV-Vorbereitung (0108) | umgesetzt (DATEV nur vorbereitet) |
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
  heute fällig oder überfällig. Regelbasierte Wiedervorlagen kamen mit
  Stufe 4/5 (ablaufende Verträge, Werkzeuge, überfällige ETA); fehlende
  Pflichtdokumente wie die PI zeigt das Cockpit (Stufe 5).
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

## Stufe 3 — Einkaufsprojekt: Anfragen, Angebote, Vergleich (0097)

Betreiber-Antworten 2026-09-30: ein Projekt hat **mehrere Positionen**, das
Ziel ist ein **Zielpreis je Position**, Anfragen gehen als **Entwürfe je
Lieferant mit Sammelfreigabe** hinaus.

### Projekt und Prozess `einkaufsprojekt`

- **Einkaufsprojekt** (`einkaufsprojekte`, Nummer `EP/00001`): Titel, Art
  (Nachproduktion, Neuteil, Werkzeug/Form, Muster, Betriebsausstattung),
  Verantwortlicher, Zieltermin, Beschreibung.
- **Positionen** (`einkaufsprojekt_positionen`): Bezeichnung oder bestehender
  Artikel, Menge, **Zielpreis je Stück in EUR** (Einstand, geht nie an den
  Lieferanten), Gewicht (g), HS-Code, Spezifikation (geht in die Anfrage).
- Prozess: Bedarf anlegen → **Anfragen freigeben** (`angefragt`) → **Angebot
  wählen** (`entschieden`) → **Bestellen** (`bestellt`) → **abgeschlossen**;
  von jedem offenen Schritt **Abbrechen**. Liegt schon ein Angebot vor
  (bekannter Lieferant), geht es vom Bedarf direkt zur Entscheidung.
- **Abgeschlossen von selbst** (SQL `einkaufsprojekt_pruefen`, Trigger auf
  `purchase_order_lines.qty_received` und `purchase_orders.state`): sobald
  das Projekt `bestellt` ist, mindestens eine nicht stornierte Bestellung hat
  und jede davon bestätigt und ihre Lagerware vollständig eingegangen ist.
  Reine Dienstleistung zählt ab Bestätigung. Von Hand geht es auch.
- Alles andere ist Arbeit im Projekt und prozessfrei: Positionen pflegen,
  Anfrage-Entwürfe anlegen, Angebote erfassen/ändern/verwerfen, Bestellung
  zuordnen, Frachtsätze, Zolltarife, EZB-Kurse.

### Anfragen (`lieferantenanfragen`)

- **„Anfragen vorbereiten"** (`einkauf.anfragen_senden`): je gewähltem
  Lieferanten ein Mail-Entwurf in dessen Sprache aus der Vorlage „Anfrage".
  - Betreff mit EP-Nummer („询价 EP/00001 – …"); daran finden Antworten ihr
    Projekt, auch in neuen Threads (`mail_thread_zuordnen` erkennt
    `EP/nnnnn`).
  - Der Positionsblock (Referenz, Positionen mit Menge und Einheit,
    Spezifikation, Liefertermin) ersetzt die leeren Stichpunkte der Vorlage.
    Wurde die Vorlage umgeschrieben, steht er nach der Anrede. Der
    **Zielpreis steht nie darin**.
  - Die gewählten Projektdateien hängen an. Die Frist wird „Antwort erwartet
    bis" (Wiedervorlage beim Senden).
  - Ein zweiter Lauf legt nichts doppelt an.
- **„Anfragen freigeben"** (`einkauf.anfragen_freigeben`, Prozessschritt,
  nicht `ki`): Sammelfreigabe, **alles oder nichts**. Jeder Entwurf wird wie
  bei der Einzelfreigabe geprüft (Empfänger, Text in der Versandsprache,
  offene Platzhalter, Anhanggröße); scheitert einer, geht keiner hinaus und
  die Meldung nennt jeden Lieferanten mit Grund.
- Beim Senden (`gmail_senden`) wird die Anfrage `angefragt`, Thread und
  Anfrage hängen am Projekt. Mit dem ersten erfassten Angebot wird sie
  `angebot`.

### Angebote und Vergleich

- **Angebot erfassen** (`einkauf.angebot_erfassen`, `ki`):
  - Kopf: Lieferant, Währung, Incoterm (+ Ort), Anzahlung % bzw.
    Zahlungstext, Lieferzeit, MOQ, gültig bis, Quelle (Datei oder
    Nachricht).
  - Einmalkosten: Werkzeug- und Musterkosten (Angebotswährung).
  - Fracht: Modus oder ein fester Betrag je Stück.
  - Preise je Position als **Staffeln**, eine je Zeile „Menge: Preis"
    (`staffelnLesen`: „ab 1.000 = 0,72", „2000 pcs → 0.65 USD"; unlesbare
    Zeilen werden abgewiesen, nicht verschluckt).
  - Ein weiteres Angebot desselben Lieferanten wird Version 2.
- **Einstand je Stück in EUR** (`einstand_schaetzen(angebot)`, SQL):
  - **Ware** = Staffelpreis (größte Staffel ≤ Projektmenge, sonst die
    kleinste) × Kurs.
  - **Werkzeug + Muster** × Kurs, nach Warenwert auf die Positionen
    umgelegt.
  - **Fracht**: bei D-Klauseln (DAP, DPU, DDP) 0; sonst der feste Betrag
    oder max(Gesamtgewicht × Satz, Mindestbetrag), nach Gewicht verteilt.
  - **Zoll** = (Ware + Fracht) × Satz des längsten passenden HS-Präfixes;
    bei DDP 0.
  - Die **EUSt ist nie enthalten**.
  - **Hinweise** statt stiller Annahmen: kein Kurs (der Wert bleibt leer
    statt 1), kein Preis, unter Staffel/MOQ, kein Gewicht, kein Zollsatz,
    abgelaufen.
- Der **Vergleich** zeigt je Position und Angebot den Einstand (Aufschlüsselung
  im Tooltip), die Summe mit Abweichung zum Ziel, die Konditionen und markiert
  den **günstigsten vollständigen** Einstand. „Wählen" entscheidet (braucht
  einen Preis für jede Position), „Verwerfen" nimmt ein Angebot heraus.
- **Einstand** (`/einkauf/einstand`): Frachtsätze je Modus (Startwerte sind
  Schätzungen) und Zollsätze je HS-Präfix. Seit Stufe 5 schlägt KRNL aus
  abgerechneten Sendungen (K+N-Rechnungen, Zollbescheide) bessere Sätze vor.

### Bestellen (`einkauf.projekt_bestellen`, nicht `ki`)

Aus dem gewählten Angebot entsteht die Bestellung als **Entwurf**; bestätigt
wird sie im eigenen Ablauf (Freigabe-Limit):

- Neue Teile bekommen einen Artikel (Gewicht, HS-Code; Betriebsausstattung
  als Dienstleistung ohne Lager).
- Positionen zum Staffelpreis in Angebotswährung, Incoterm, Projekt-Verweis.
- Werkzeug- und Musterkosten als Dienstleistungszeilen.
- Zahlplan aus der Anzahlung: Anzahlung bei Bestellung, Rest bei Verschiffung;
  100 % = Vorkasse.
- **Lieferantenpreise** aus allen Staffeln (mit Gültigkeit und Lieferzeit) —
  beim nächsten Mal schlägt KRNL sie selbst vor.

Bestehende Bestellungen lassen sich einem Projekt zuordnen
(`einkauf.bestellung_projekt_zuordnen`). Die Projektseite zeigt den
Eingangsstand und die Preishistorie der Artikel aus früheren Bestellungen.

### EZB-Kurse

Job `ezb_kurse_abrufen` (täglich im Cron `finanzen`, Knopf „EZB-Kurse holen"
auf der Kurse-Seite): Referenzkurse der EZB → gespeichert als EUR je
Fremdeinheit (1/Kurs), Quelle `ezb`. Von Hand erfasste Kurse desselben Tages
bleiben stehen. `EZB_FAKE=1` für Tests. „Kurs erfassen" ohne Datum gilt ab
heute (vorher schlug es fehl).

### Oberfläche

- `/einkauf/projekte`: Liste mit Ansichten (laufend, abgeschlossen,
  abgebrochen) und „Neues Projekt" mit erster Position.
- `/einkauf/projekte/[id]`: Positionen, Anfragen (Lieferantenauswahl, Frist,
  Dateien, Sammelfreigabe), Angebotsvergleich und Erfassung, Entscheidung,
  Bestellungen, Preishistorie; dazu Mails (Neue Mail an einen angefragten
  Lieferanten), Dateien (Drive-Ordner `Projekte/EP-… Titel`),
  Wiedervorlagen, Prozess und Verlauf.
- Threads lassen sich einem Projekt zuordnen (`einkauf.mail_zuordnen` mit
  `einkaufsprojekt_id`).

### Nachweis

- `tests/einkaufsprojekt.test.ts`:
  - Zahlen und Staffeln aus Text, Staffelwahl;
  - Positionsblock je Sprache und in umgeschriebenen Vorlagen;
  - Summe und bestes Angebot;
  - EZB-XML und Kursumkehr.
- `tests/prozesse/einkaufsprojekt.test.ts`:
  - Einstand auf den Cent (CNY FOB mit Werkzeug und Mindestfracht gegen
    USD DDP);
  - fehlender Kurs;
  - Anfrage-Texte in Chinesisch und Englisch;
  - Sammelfreigabe alles oder nichts, Senden hängt Threads an;
  - Antwort mit EP-Nummer in neuem Thread;
  - Bestellung mit neuen Artikeln und Werkzeugzeile;
  - Abbruch nur ohne offene Bestellung;
  - Abschluss beim Wareneingang;
  - EZB ohne Handkurse zu überschreiben.
- Fixture-Läufe (`fixtures/einkaufsprojekt.ts`):
  - Neuteil bis zum Abschluss beim Wareneingang;
  - Betriebsausstattung direkt bestellt;
  - Abbruch.
  - Musterpflicht: ohne Golden Sample keine Bestellung, nachbessern,
    freigeben, bestellen mit Werkzeug (Stufe 4).

## Stufe 4 — Bemusterung, Werkzeuge, Lieferantenverträge (0107)

Der Betreiber wollte Muster mit Freigabe (Golden Sample), Werkzeuge/Molds,
Rahmenverträge/Preislisten und NDA/Qualitätsvereinbarung „von Anfang an"
abgebildet haben. Begründung der Modellierung: Entscheidungslog
2026-10-01 „Einkauf Stufe 4".

### Bemusterung (`bemusterungen`, Prozess `bemusterung`)

- **Je Muster-Runde ein Beleg**: Projekt, Lieferant (und sein Angebot),
  Runde 1, 2 … je Lieferant, Revision, Bezeichnung, Menge, Kosten und
  Währung (ohne Angabe die Musterkosten aus dem Angebot), angefordert am,
  Eingang, Tracking (ein Link wird klickbar), Bewertung (Note 1–5, Befund,
  wer/wann), Fotos und Prüfberichte als Dokumente (Drive-Ordner
  `Projekte/EP-… Titel/Muster`).
- **Prozess:** Muster anfordern (`einkauf.muster_anfordern`, `offen`) →
  Weiche „Muster da?" → **Eingang erfassen** (`einkauf.muster_erhalten`)
  → **Freigeben** (Golden Sample) | **Nachbessern lassen** | **Ablehnen**
  (alle drei `einkauf.muster_bewerten`, Zustände `freigegeben`,
  `nachbessern`, `abgelehnt`). Absagen geht auch vor dem Eingang.
  - **Nachbessern** braucht einen Befund und legt sofort die nächste Runde
    an (Revision A → B, 1 → 2, oder wie angegeben).
  - **Golden Sample**: höchstens eines je Projekt und Lieferant — ein neues
    ersetzt das alte (im Verlauf beider Runden).
  - Bewerten ist nicht `ki`; Daten nachtragen (`einkauf.muster_aendern`)
    ist prozessfrei.
- **Rückmeldung an den Lieferanten**: „Mail-Entwurf Muster-Feedback" auf
  der Runde (Vorlage aus Stufe 2b, in seiner Sprache, Deutsch zum
  Mitlesen).
- **Musterpflicht** (`einkaufsprojekte.muster_pflicht`, beim Anlegen oder
  Bearbeiten bis zur Bestellung): ein Trigger verweigert den Wechsel nach
  `bestellt` ohne freigegebenes Golden Sample **des gewählten
  Lieferanten** — „EP/00003 hat Musterpflicht: ohne freigegebenes Golden
  Sample von … wird nicht bestellt." Die neue Version des Projektprozesses
  führt nach „Angebot wählen" über die Weiche „Musterpflicht?" durch den
  Teilprozess Bemusterung (siehe [prozesse.md](../prozesse.md)).
- **Oberfläche:** Karte „Bemusterung" im Projekt (Runden, Status, Golden
  Sample, „Muster anfordern"; ohne Golden Sample ersetzt ein Hinweis den
  Knopf „Bestellung anlegen"), `/einkauf/muster` (offen, freigegebene
  Golden Samples, alle; Menüzähler = eingegangen und unbewertet),
  `/einkauf/muster/[id]` (Eingang, Bewertung, alle Runden mit dem
  Lieferanten, Dateien, Wiedervorlagen, Prozess, Verlauf), Karte in der
  Lieferantenakte.

### Werkzeuge und Formen (`werkzeuge`, WZ/…)

- Bezeichnung, Art (Form, Stanz-/Schneidwerkzeug, Vorrichtung), **Standort
  beim Lieferanten**, Eigentümer (wir/Lieferant), Kosten und Währung,
  **Werkzeugkosten-Zeile der Bestellung**, Einkaufsprojekt, Artikel,
  **Schuss-Lebensdauer und -Zähler**, Status (in Auftrag, aktiv, gesperrt,
  ausgemustert) mit Grund. Prozessfrei — ein Betriebsmittel, kein Ablauf.
- **Von selbst:** bestellt ein Einkaufsprojekt Werkzeugkosten, legt
  `einkauf.projekt_bestellen` das Werkzeug an (in Auftrag, Eigentum bei uns,
  an der Werkzeugkosten-Zeile); ein vorab angelegtes Werkzeug des Projekts
  beim selben Lieferanten wird verknüpft statt verdoppelt.
- **Aktionen:** `einkauf.werkzeug_anlegen` (mit Bestellzeile kommen
  Lieferant, Kosten, Währung und Projekt von dort), `_aendern`,
  `_status_setzen` (Sperren und Ausmustern mit Grund, Ausmustern ist
  endgültig), `einkauf.werkzeug_schuss_buchen` (von Hand, z. B. je Los
  laut Lieferant; negativ = Korrektur, nie unter 0; positiv nur in Betrieb
  oder in Auftrag — T0-Muster entstehen vor der Freigabe).
- **Ab 90 % der Lebensdauer** erscheint eine regelbasierte Wiedervorlage.
- **Oberfläche:** `/einkauf/werkzeuge` (Liste mit Zählerbalken, „Neues
  Werkzeug", vorbelegbar mit `?projekt=` und `?lieferant=`),
  `/einkauf/werkzeuge/[id]` (Schüsse buchen, Status, Stammdaten,
  Zeichnungen und Fotos — Drive `Lieferanten/‹Name›/Werkzeuge`,
  Wiedervorlagen, Verlauf), Karten in Projekt und Lieferantenakte.

### Lieferantenverträge (`lieferantenvertraege`)

- **Nicht** die Fixkosten-Verträge der Finanzen (`vertraege`, 0059).
- Art (NDA, QSV, Rahmenvertrag, Preisliste), Titel, gültig von/bis (ohne
  Ende = unbefristet), **Kündigungsfrist in Monaten**, **automatische
  Verlängerung** in Monaten, **Erinnerung** (Tage vor dem Stichtag,
  Standard 30), Währung der Preise, Status (aktiv, gekündigt, beendet).
  Die Vertragsdatei hängt als Dokument am Vertrag (Drive
  `Lieferanten/‹Name›/Verträge`). Prozessfrei.
- **Laufzeitende und Kündigungsstichtag rechnet die Datenbank**
  (`lieferantenvertrag_ende`, `lieferantenvertrag_stichtag`): mit
  Verlängerung das nächste Ende, dessen Stichtag noch nicht verstrichen ist.
  Die Lage („Frist läuft", „abgelaufen" …) liest die Oberfläche daraus.
- **Status:** gekündigt (läuft bis zum Ende, keine Verlängerung, keine
  Erinnerung), beendet (endet zum Datum; Preise aus dem Vertrag gelten bis
  dahin), wieder aktiv.
- **Preisliste übernehmen** (`einkauf.preisliste_uebernehmen`, `ki`, bei
  Preisliste und Rahmenvertrag): eine Zeile je Preis — „KC-PBT-01 / 500:
  7,20", „KC-PULL: 0,35" (ab 1) oder aus Excel kopiert (SKU⇥Menge⇥Preis).
  Daraus werden **Lieferantenpreise mit der Gültigkeit des Vertrags** in
  seiner Währung (`vendor_prices.vertrag_id`, optional Lieferzeit).
  - Alles oder nichts: eine unlesbare Zeile oder ein unbekannter Artikel
    verhindert die Übernahme und wird genannt.
  - Eine zweite Übernahme ersetzt die Preise des Vertrags.
  - Ändert sich die Laufzeit, ziehen die Preise mit; die Währung lässt sich
    nicht mehr umstellen, solange Preise daraus stammen.
- **Oberfläche:** `/einkauf/vertraege` (aktiv, gekündigt, beendet; sortiert
  nach Stichtag; „Neuer Vertrag", vorbelegbar mit `?lieferant=`),
  `/einkauf/vertraege/[id]` (Status, Bearbeiten, Preise aus dem Vertrag und
  Übernahme, Dateien, Wiedervorlagen, Verlauf), Karte in der
  Lieferantenakte; Lieferantenpreise zeigen ihren Vertrag.

### Regelbasierte Wiedervorlagen (Sicht `einkauf_regel_wiedervorlagen`)

- Berechnet, nie gespeichert: **ablaufende Verträge** (aktiv, mit Ende;
  erscheinen ab Stichtag − Erinnerung, fällig ist der Stichtag) und
  **Werkzeuge ab 90 % der Schuss-Lebensdauer** (aktiv).
- Sie stehen in `/einkauf/wiedervorlagen` unter „Von selbst", in der
  Karte „Wiedervorlagen" am Beleg und in der Lieferantenakte, zählen im
  Menü mit und verschwinden, sobald der Grund behoben ist (verlängert,
  gekündigt, beendet; Werkzeug ersetzt oder Lebensdauer angepasst).
- Manuelle Wiedervorlagen gehen jetzt auch an Muster, Werkzeug und
  Vertrag.

### Nachweis

- `tests/einkauf-stufe4.test.ts` — Preisliste aus Text (Mengen, ab 1,
  Excel-Spalten, Schrägstriche in der SKU, unlesbare Zeilen), Lage eines
  Vertrags, Revisionsfolge, Tracking-Link, Lebensdauer und Buchbarkeit,
  Formular-Adapter (Musterpflicht-Checkbox, Golden-Sample-Marke).
- `tests/prozesse/einkauf-bemusterung.test.ts`:
  - Bestellung ohne Golden Sample abgewiesen, nichts halb angelegt; ein
    Golden Sample eines anderen Lieferanten zählt nicht;
  - Runden mit Kosten aus dem Angebot, Weiche „Muster da?", Nachbessern
    legt Runde 2 an, Teilprozess-Stand;
  - Golden Sample öffnet die Bestellung, ein neues ersetzt das alte;
  - Bestellen legt das Werkzeug an der Werkzeugkosten-Zeile an;
  - Werkzeug mit Artikel, Schüsse, Wiedervorlage ab 90 %, Sperren,
    Korrektur, Ausmustern endgültig, Anlage aus einer Bestellzeile;
  - Preisliste → Lieferantenpreise mit Gültigkeit, alles oder nichts,
    Ersetzen, Gültigkeit folgt dem Vertrag, Beenden kürzt sie
    (`best_vendor_price`);
  - ablaufender, rollierender und ferner Vertrag in der Sicht, Kündigung
    räumt die Wiedervorlage;
  - Dokumente und manuelle Wiedervorlagen an den neuen Belegen.
- Fixture `fixtures/bemusterung.ts` (Golden Sample, Nachbessern, Absage)
  und der vierte Lauf in `fixtures/einkaufsprojekt.ts` (Musterpflicht).

## Stufe 5 — Eingangssendungen, Zoll, Pflichtdokumente, Cockpit, DATEV (0108)

Betreiber-Vorgaben: Sammelsendungen mit mehreren Bestellungen sind häufig
(K+N See/Luft, Express vom Lieferanten); Zollunterlagen je Sendung; Fracht
und Zoll als Einstandskosten, **EUSt getrennt**; Pflichtdokumente je
Bestellung; Wiedervorlagen im Cockpit plus tägliche Zusammenfassung im
Telegram-Chat nach Einkäufer; lernende Schätzwerte. Begründungen:
Entscheidungslog 2026-10-01 „Einkauf Stufe 5".

### Eingangssendung (`eingangs_sendungen`, ES/…, Prozess `eingangs_sendung`)

- **Kopf:** Bezeichnung, Modus (See, Luft, Express), Spediteur (Lieferant,
  z. B. K+N — er schickt die Frachtrechnung), Träger (Reederei, Airline,
  Kurier), HBL/AWB, Container, Tracking-Link, ETD/ETA, kg brutto, cbm,
  Packstücke, Zuständig.
- **Bestellungen** n:m (`eingangs_sendung_bestellungen`) — eine Sendung trägt
  Bestellungen mehrerer Lieferanten, eine Bestellung kann auf zwei Sendungen
  verteilt sein. Beim Zuordnen hängen alle noch freien Wareneingänge der
  Bestellung an der Sendung (`stock_pickings.eingangs_sendung_id`, auch schon
  gebuchte — die Sendung wird oft erst mit der K+N-Rechnung angelegt);
  Backorders erben die Sendung nicht. Herausnehmen geht, solange kein
  Eingang dieser Sendung gebucht ist.
- **Ablauf:** anlegen (`geplant`) → **Verschifft** (`verschifft`, Datum,
  ETD/ETA, HBL/AWB) → **Verzollt** (`verzollt`) → **Angekommen**
  (`angekommen`; Express direkt aus „verschifft") → Teilprozess
  **Wareneingang** (die Eingänge der Sendung) → **Abrechnen**
  (`abgerechnet`) | **Stornieren** (`storniert`, Grund Pflicht, nur vor dem
  ersten gebuchten Eingang und ohne verteilte Kosten).
- **Sendung → Bestellungen:** Verschiffungstag (`verschifft_am`, der
  früheste aller Sendungen der Bestellung), ETA (`eta_confirmed`, wandert an
  die offenen Eingänge), Träger und HBL/AWB als Tracking. Mit
  `verschifft_am` werden die **Zahlplan-Raten „bei Verschiffung" fällig** —
  derselbe Fakt wie bei „Verschiffung erfassen"; die Meldung nennt die
  betroffenen Bestellungen. Eine stornierte Sendung nimmt einen nur von ihr
  gesetzten Tag zurück.

### Kosten, Zoll, Verteilung (Landed Costs)

- **Kostenpositionen** (`sendung_kosten`): Fracht, Zoll, EUSt,
  Versicherung, Sonstiges — Betrag und Währung, Belegdatum, Schätzung oder
  Rechnung (Rechnungssteller, Lieferantenrechnung, Dokument). Eine Rechnung
  **ersetzt die offenen Schätzungen derselben Art**; stornieren nimmt
  gebuchte Landed Costs zurück (ersetzte Schätzungen gelten dann wieder).
- **„Fracht und Zoll schätzen"** (`eingangs_sendung_schaetzung`): Fracht =
  kg (Sendung, sonst Bestellmenge × Artikelgewicht; D-Klauseln ohne) ×
  Frachtsatz des Modus, mindestens der Mindestbetrag; Zoll = Warenwert ×
  Satz des längsten HS-Präfixes, auf Ware + Fracht hochgerechnet (DDP ohne).
  Nur für Arten ohne Kostenposition; die EUSt wird nie geschätzt.
- **Zollbescheid** (`einkauf.sendung_zoll_erfassen`): je HS-Code Zollwert,
  Zoll und EUSt (`sendung_zoll`; Textfeld „HS-Code; Zollwert; Zoll; EUSt",
  auch aus Excel kopiert). Daraus entstehen die Positionen Zoll (ersetzt die
  Schätzung) und EUSt; ein neuer Bescheid ersetzt den alten samt Buchungen.
- **Verteilen** (`eingangs_sendung_verteilen`, Knopf „Kosten verteilen" und
  beim Abrechnen): je Kostenposition und gebuchtem Eingang ein
  `landed_costs`-Satz (`sendung_kosten_id`), gebucht über das unveränderte
  `landed_cost_post`:
  - Fracht **nach Gewicht**, wenn jede gebuchte Position ein Gewicht hat,
    sonst nach Warenwert; Zoll, Versicherung, Sonstiges **nach Warenwert**.
  - Auf den Cent, **Rundungsrest auf den letzten Eingang** — die Summe ist
    exakt der Kostenbetrag.
  - **Schätzung → Rechnung:** die Landed Costs der Schätzung werden
    storniert, die der Rechnung neu gebucht (`corrects_id`) — netto genau
    die Differenz in den Wertschichten.
  - **Die EUSt wird nie verteilt** (Vorsteuer, kein Einstand).
  - Fremdwährung mit dem Kurs am Belegdatum (ohne Kurs: klare Meldung statt
    still 1), eingefroren an der Position.
- **Abrechnen** verlangt alle Eingänge gebucht und keine offene Schätzung
  mehr; spätere Kosten (Standgeld …) gehen per „Kosten verteilen" nach.

### Lernende Schätzwerte (Sicht `einkauf_einstand_vorschlaege`)

Aus **abgerechneten** Sendungen: echte Fracht in €/kg je Modus (€/cbm zur
Information) und echte Zollsätze (Zoll ÷ Zollwert) je HS-Präfix — der
längste vorhandene Tarif-Präfix, sonst die ersten vier Ziffern. Ab 5 %
(Fracht) bzw. 0,1 Prozentpunkten (Zoll) Abweichung erscheint auf
`/einkauf/einstand` ein Vorschlag mit „Übernehmen"
(`einkauf.einstand_vorschlag_uebernehmen` — der Wert kommt aus der Sicht,
nie still überschrieben).

### Pflichtdokumente (`pflichtdokument_regeln`, Sicht `einkauf_offene_pflichtdokumente`)

| Beleg | Dokument | Bedingung (über `prozess_beleg_daten`) | fällig |
|---|---|---|---|
| Bestellung | Proforma Invoice | bestätigt und Zahlplan-Rate „bei Bestellung" (`hat_anzahlung`) | ab Bestätigung |
| Bestellung | Commercial Invoice, Packing List | bestätigt, verschifft, Lieferant aus einem Drittland (außerhalb EU-27) | ab Verschiffung |
| Bestellung | Endrechnung | Ware eingegangen (oder reine Dienstleistung) | 7 Tage nach Eingang |
| Sendung | Spediteursrechnung | angekommen, Spediteur eingetragen | 14 Tage nach Ankunft |
| Sendung | Zollbescheid | angekommen, Ware aus einem Drittland | 7 Tage nach Ankunft |

- Regeln sind Daten (Bedingungssprache wie die Prozessweichen, Stichtag-Feld
  + Frist, aktiv); sie prüfen nur Belege ab `gilt_ab` (Einspieltag) und
  überstehen „Betriebsdaten löschen".
- Ein Dokument der Art zählt, wenn es an der Bestellung, an einer ihrer
  Rechnungen oder an einer ihrer Sendungen hängt (dann nur vom selben
  Lieferanten); für die Sendung an ihr selbst oder an der Rechnung einer
  Kostenposition. Mit dem Upload verschwindet der Eintrag.
- **Nachfragen** (`einkauf.pflichtdokumente_nachfragen`): Mail-Entwurf aus
  der Vorlage „Fehlende Dokumente nachfragen" (de/en/zh, Platzhalter
  `{{dokumente}}`) in der Sprache des Lieferanten bzw. Spediteurs, mit
  genau den fehlenden Dokumenten — gesendet erst nach Freigabe.
- Zu sehen im Cockpit, an der Bestellung (Karte „Sendungen &
  Pflichtdokumente") und an der Sendung (auch die ihrer Bestellungen).

### Einkaufs-Cockpit (`/einkauf/cockpit`, Sicht `einkauf_cockpit`)

Je Einkäufer (Meine/Alle): **überfällig**, **heute fällig** (manuelle und
regelbasierte Wiedervorlagen), **überfällige ETA**, **fehlende
Dokumente** (mit „nachfragen" je Beleg), **fehlende Rechnungen** (Ware da,
Lieferantenrechnung fehlt), **fällige Raten** (7 Tage, nur mit
Finanzrecht — aus einer eigenen Abfrage, nicht aus der Sicht), **wartet auf
uns**, **wartet auf Lieferant**, **nicht zugeordnete Mails**, **laufende
Sendungen**, **laufende Muster**, **Werkzeuge am Lebensende**. Jeder Eintrag
führt zu seinem Beleg. Neu als regelbasierte Wiedervorlage: Bestellungen mit
überschrittenem ETA bei offenem Wareneingang.

### Tägliche Zusammenfassung (Job `einkauf_digest`)

Cron `/api/cron?task=einkauf` täglich 5:15 UTC reiht den Job ein; er legt
eine Benachrichtigung der Art `einkauf` an (Schlüssel je Tag — kein
Doppel), die der Cron „jobs" in den bestehenden Telegram-Chat sendet:
gegliedert nach Einkäufer, nur Handlungsbedarf (je Kategorie die ersten
fünf, „Ohne Zuständigen" zuletzt, nicht zugeordnete Mails als Zahl), mit
Links bei gesetzter `ERP_PUBLIC_URL`. Nichts offen → keine Nachricht.
Abschaltbar unter Einstellungen → Benachrichtigungen.

### DATEV — nur vorbereitet

Betreiber 2026-10-01: **„DATEV erstmal nur vorbereiten"** — der Versand
folgt nach Klärung mit dem Steuerberater (Upload-Adresse,
Absender-Freigabe, ein Beleg je Mail, Größengrenze). KRNL sendet nichts:
kein Job, keine Aktion, kein Cron.

- `/einkauf/datev` (Sicht `einkauf_datev_vorbereitung`): gebuchte
  Lieferantenrechnungen mit verknüpfter Rechnungsdatei → **bereit**, ohne →
  **Beleg fehlt**, mit `dokumente.datev_uebergeben_am` → **übergeben**.
  Verlinkt von den Lieferantenrechnungen.
- Baustein `datevBelegMail` (`src/modules/einkauf/datev.ts`, pur, getestet):
  eine Mail je Beleg mit der Datei als Anhang, im Format der
  Resend-Anbindung — nicht verdrahtet. Die Umgebungsvariable
  `DATEV_BELEG_MAIL` kommt erst mit dem Versand.

### Oberfläche

- `/einkauf/sendungen`: Liste (laufend, abgerechnet, storniert, alle) und
  „Neue Sendung" mit Auswahl offener Bestellungen ohne Sendung; Menüzähler =
  angekommene Sendungen (warten auf Eingang und Abrechnung).
- `/einkauf/sendungen/[id]`: Ablauf, Daten, Bestellungen & Wareneingänge,
  Kosten (schätzen, erfassen, verteilen), Verteilung je Eingang, Zoll,
  fehlende Pflichtdokumente mit Nachfrage, Dokumente (Drive
  `Sendungen/ES-… …`), Wiedervorlagen, Prozess, Verlauf.
- `/einkauf/cockpit`, `/einkauf/datev`; Vorschläge auf `/einkauf/einstand`;
  Karte an der Bestellung; Navigation und Befehlsfeld.

### Nachweis

- `tests/einkauf-stufe5.test.ts` — Verteilung (Summe exakt, Rest auf den
  letzten, Grenzfall), Schlüssel, Zollzeilen aus Text, Dokumentnamen je
  Sprache, Digest-Text nach Einkäufer (Reihenfolge, Kürzen, Maskieren),
  DATEV-Beleg-Mail, Formular-Adapter.
- `tests/prozesse/einkauf-sendungen.test.ts`:
  - drei Bestellungen zweier Lieferanten in einer Sendung; Verschiffung
    macht die Rate „bei Verschiffung" fällig, ETA am Eingang;
  - fehlende CI nach der Verschiffung erscheint und verschwindet mit dem
    Upload (auch über die Sendung, nur für den eigenen Lieferanten);
    Nachfrage-Entwurf auf Chinesisch bzw. an den Spediteur;
  - Schätzung (Mindestfracht, Zoll auf Ware + Fracht), Verteilung nach
    Gewicht und Wert, Rechnung → Storno + Neubuchung mit Rundungsrest auf
    dem letzten Eingang, Zollbescheid, Abrechnung; EUSt nie in den Landed
    Costs; Summe der Verteilung = Kosten (auch in den Wertschichten);
  - Spediteursrechnung/Zollbescheid und Endrechnung nach Frist;
    DATEV-Status (fehlt Beleg → bereit → übergeben, kein Versand-Job);
    gelernte Sätze (Vorschlag, übernehmen);
  - Kosten stornieren, Storno nimmt den Verschiffungstag zurück;
  - Cockpit-Kategorien je Einkäufer, ohne Finanzrecht keine Raten;
    Digest-Job: eine Nachricht je Tag, gegliedert nach Einkäufer.
- Fixture `fixtures/eingangs-sendung.ts` (See mit Verzollung bis zur
  Abrechnung, Express, Storno).
