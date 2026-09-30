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
| 2a | Einkaufspostfach lesen und zuordnen, Posteingang, Wiedervorlagen | geplant |
| 2b | Aus KRNL schreiben, Vorlagen je Sprache, Übersetzung | geplant |
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
- **Gmail** (ab Stufe 2) mit domänenweiter Delegation, nur Scope
  `gmail.modify`, nur für das Einkaufspostfach.
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
  Mails und Projekte folgen mit den Stufen 2 und 3.
- **Einkaufsdaten** (`einkauf.lieferantendaten_setzen`): Sprache (de/en/zh),
  **Maildomains** (je Domain genau ein Lieferant — sie ordnen ab Stufe 2
  eingehende Mails zu), zuständiger Einkäufer, Standard-Incoterm und
  -Währung.
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
