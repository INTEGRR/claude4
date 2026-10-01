# Modul Versand (DHL-Direktanbindung)

API-Referenz: [docs/api-referenz/dhl.md](../api-referenz/dhl.md) · Nachbau-Vorlage: [docs/api-referenz/sendcloud-shopify-funktionsumfang.md](../api-referenz/sendcloud-shopify-funktionsumfang.md)

## Zweck

Ersetzt Sendcloud vollständig: Unser System erstellt DHL-Versandlabels direkt (Parcel DE Shipping API v2), verfolgt den Sendungsstatus und meldet Fulfillment + Tracking selbst an Shopify zurück (inkl. Versandmail an den Kunden über Shopify).

## Ablauf (Happy Path)

```
Fertigung abgeschlossen (alle MOs des Auftrags done)
  → Lieferung (WH/OUT) wird reserviert und erscheint in „Versandbereit"
  → Packen: „Label erstellen" (Versandliste, Packtisch oder Massendruck)
      → POST /orders (Parcel DE Shipping API): shipment_number + Label-PDF
      → Label-PDF in Supabase Storage persistieren (DHL hält es nur ~3 Tage vor!)
      → im selben Schritt ausbuchen (0103): Warenausgang bucht Bestand aus,
        Kartonage wird verbraucht
      → Outbox-Job „shopify_fulfillment_create": fulfillmentCreate mit
        trackingInfo { company: "DHL", number, url } + notifyCustomer: true
        (Shopify verschickt die Versandbestätigung an den Kunden)
      → Label drucken (Labeldrucker des Arbeitsplatzes, sonst PDF)
  → Tracking-Sync aktualisiert den Sendungsstatus bis „zugestellt"
```

**Das Label bucht aus** (Entscheidungslog 2026-10-01, Migration 0103):
sobald das Label rausgeht, ist die Ware weg — Einzel-Label, Massendruck und
Packtisch buchen den Warenausgang mit und reihen die Shop-Rückmeldung ein.
Bis dahin brauchte es einen eigenen Buchen-Schritt bzw. im Massendruck den
Haken „direkt ausbuchen"; ohne ihn blieb die Ware im Lager und Shopify
erfuhr nichts. Die Shopify-Rückmeldung hängt weiterhin am **Warenausgang**,
der jetzt mit dem Label zusammenfällt (wie Sendclouds „Rückmeldung bei
Label-Erstellung").

- **Ausnahme „nur Label"** (Haken am Einzel-Label bzw. „nicht ausbuchen" im
  Massendruck): die Lieferung bleibt reserviert, der Buchen-Schritt bleibt
  angeboten.
- **Nachholen:** Lieferungen mit Label, die nicht ausgebucht sind, zeigt die
  Versandseite oben mit „Alle ausbuchen" und je Zeile „Ausbuchen"
  (`versand.gelabelte_ausbuchen`) — bucht wie direkt nach dem Label.
- **Ersatz-Label nach Storno:** eine ausgebuchte Lieferung, deren Label
  storniert wurde, bekommt in der Sendungsliste „Ersatz-Label"; die neue
  Sendungsnummer geht an Shopify (war schon gemeldet: Tracking-Nachtrag am
  bestehenden Fulfillment). Ohne Storno bleibt eine ausgebuchte Lieferung
  gesperrt.
- Nur reservierte Lieferungen (`assigned`) werden ausgebucht; scheitert die
  Buchung, bleibt das Label gültig, der Grund steht am Beleg und die
  Lieferung erscheint unter „Nachholen".
- Im Shopify-Probelauf steht die Rückmeldung als „Bestellung als versendet
  melden" in der Debug-Box; im Modus „nur lesen" wird sie übersprungen.

## Artikelgewichte (Versandgewicht)

Das Paketgewicht ist Warengewicht (Gewicht je Stück am Artikel,
`product_templates.weight_g`) plus Leergewicht der Kartonage. Der
Shopify-Produktimport hatte keine Gewichte übernommen — ohne sie rechnet der
Versand mit 0 g, und Versandregeln wählen das falsche DHL-Produkt.
Seit 2026-10-01 (Entscheidungslog „Gewichte im Versand"):

- **Versand → Karte „Gewichte fehlen":** alle Artikel offener Lieferungen
  ohne Gewicht, je Zeile ein Feld „g je Stück" (`versand.artikelgewicht_setzen`
  — Bereich Versand, darf also auch die Lager-Rolle) und der Knopf
  **„Gewichte aus Shopify übernehmen"** (`versand.gewichte_aus_shopify`):
  liest je verknüpfter Shop-Variante `inventoryItem.measurement.weight`
  (reine Abfrage, auch im Modus „nur lesen" und im Probelauf), rechnet in
  Gramm um und setzt es nur, wo KRNL noch keines führt (mit „überschreiben"
  auch gepflegte).
- **Beim Packen im Scanfeld:** eine Position ohne Gewicht zeigt „Gewicht
  fehlt" mit Eingabefeld; gespeichert wird am Artikel, danach rechnet KRNL
  Paketgewicht und DHL-Produktvorschlag neu — die gescannten Mengen bleiben.
- Das Gewicht gilt je Artikel (alle Varianten).

## Versandregeln (Kleinpaket/Paket-Wahl)

Regelwerk nach Sendcloud-Vorbild („wenn Bedingung, dann Aktion"), gepflegt
unter Einstellungen → Versandregeln, ausgewertet von oben nach unten — je
Aktion gewinnt die erste passende Regel, weitere Regeln steuern andere
Aktionen bei (Stapeln):

- **Bedingungen**: Gewicht (min/max), Zone (DE / EU-Zollunion / Welt),
  SKU-Muster (`KC-*`, eine Position genügt oder alle), „passt ins
  Kleinpaket".
- **Aktionen**: DHL-Produkt, Abrechnungsnummer, Transportversicherung ab
  Warenwert (versichert wird die Auftragssumme).
- **Kleinpaket-Eignung** steht am Produkt: Flag „passt ins Kleinpaket" plus
  **Platzbedarf** (1 = ein volles Kleinpaket, 35,5 × 25 × 8 cm; zwei Stück je
  Kleinpaket sind also 0,5, eine Tastatur etwa 3). Geprüft wird die ganze
  Lieferung, vier K.-o.-Kriterien:
  1. **Jede** Position muss markiert sein — eine unmarkierte (die Tastatur
     zum Zubehör) macht die Sendung zum Paket.
  2. Der Platz reicht: Summe (Menge × Platzbedarf) ≤ 1.
  3. Versandgewicht ≤ 1 kg — **einschließlich Karton**, denn gewogen wird das
     Paket. Diese Prüfung sitzt in der Eignung selbst, nicht nur im
     Höchstgewicht der Regel: sonst würde eine entschärfte Regel ein von DHL
     abgelehntes Label vorschlagen.
  4. Die gewählte Kartonage ist als Kleinpaket zugelassen (siehe unten).
- Die Regeln liefern einen **Vorschlag** am Packtisch (sichtbar mit
  Regelname, Produkt vorausgewählt, überschreibbar) und steuern den
  Massendruck. Ohne Regeltreffer gilt die Länder-Automatik: DE → V01PAK,
  EU → V54EPAK, sonst V53WPAK.
- Die **Abrechnungsnummer** wird zum Produkt passend gebildet (Verfahren 62
  für Kleinpaket, 01 für Paket …): Standard-Nummer aus der Umgebung, das
  Verfahren wird ausgetauscht, die Teilnahme bleibt; eine Regel kann eine
  abweichende Nummer explizit setzen. Voraussetzung: die Produkte sind im
  DHL-Geschäftskundenvertrag gebucht.

## Kartonagen (Verpackung und Verbrauch)

Eine Kartonage ist **kein eigener Stammdatenzweig, sondern ein Produkt mit
Zusatzangaben** (Einstellungen → Kartonagen): Bestand, Einkaufspreis,
Leergewicht und Meldebestand kommen aus dem verknüpften Artikel, neu sind nur
Fassungsvermögen (gleiche Skala wie der Platzbedarf), Höchstgewicht des
Inhalts und die Kleinpaket-Tauglichkeit.

- **Wahl**: die kleinste Kartonage, deren Fassungsvermögen den Platzbedarf
  deckt und deren Höchstgewicht das Warengewicht trägt. Ein Keycap-Set reist
  damit nicht im Tastaturkarton.
- **Gewicht**: Versandgewicht = Warengewicht + Leergewicht der Kartonage. Das
  ist der Wert, den DHL bekommt und der am Packtisch vorbelegt ist — an der
  Kleinpaket-Grenze (980 g Ware + 60 g Karton) entscheidet genau das über
  Annahme oder Ablehnung.
- **Verbrauch**: beim **Warenausgang** (nicht beim Etikettieren — ein
  storniertes Label verbraucht keinen Karton) bucht `packaging_consume()` ein
  Stück als Bestandsbewegung denselben Weg wie die Ware. Damit gilt die
  Grundregel weiter: jede Bestandsänderung ist eine Bewegung, der Kartonvorrat
  läuft über Meldebestände und Auswertungen wie jedes andere Material. Die
  Funktion ist idempotent; scheitert sie (Karton nicht auf Bestand), blockiert
  das den Warenausgang nicht, sondern hinterlässt einen Fehler am Beleg.
- Ohne gepflegte Kartonagen bleibt alles wie zuvor: reines Warengewicht, keine
  Verbrauchsbuchung.

## Packzettel (Kommissionier- und Scanbeleg)

Jede Lieferung hat eine Druckansicht `/lager/<id>/druck` (Knopf
„Packzettel" an der Lieferung, 🖨 in der Versandbereit-Liste): oben der
beschriftete **VERSAND-Barcode** (Lieferungsnummer — im Scanfeld startet
er den Packablauf), dazu Auftrag/Shopify-Nummer/Kunde, die Lieferadresse, die
**Kundennotiz** und die Positionsliste mit **Artikel-Code je Zeile** (EAN
bzw. Code 128 der SKU) zum Gegenscannen, dem Belegtext „Lieferschein"
des Artikels (`description_picking`) und einem Abhak-Kästchen. Die
Positionen stehen **nach Artikelname** — die Laufreihenfolge beim
Sammeln (Lagerplätze gibt es vorerst nicht). Unten zwei Felder
„Gesammelt von" und „Gepackt von". Für Bestellungen mit Fertigung
übernimmt der Fertigungszettel diese Rolle (zwei Barcodes,
docs/module/fertigung.md); der Packzettel ist das Gegenstück für reine
Lager-Bestellungen — und zugleich der Kommissionierbeleg.

Eine Datenquelle für alle Wege: `src/modules/versand/packzettel-daten.ts`
speist die HTML-Ansicht, den **Sammeldruck** `/versand/packzettel?ids=…`
(bis 100 Zettel in einem Dokument, Seitenumbruch je Lieferung) und das
**PDF der Druckbrücke** (`packzettel-pdf.tsx`, A4). Gedruckt wird aus der
Versand-Liste: Zeilen anhaken (oder „Alle auswählen") → **„Packzettel
drucken (N)"** führt `versand.packzettel_drucken` aus — auf dem
A4-Drucker des Arbeitsplatzes (Druckart `packzettel`, sonst Ersatz),
ohne Drucker öffnet der Sammeldruck im Browser. Die Lieferung merkt sich
`packzettel_gedruckt_am` (Marke „Zettel gedruckt").

## Kommissionieren (/kommissionieren, seit 0091)

Bestellung für Bestellung die Ware im Lager sammeln und zum Packtisch
bringen — **analog** mit dem Packzettel oder **digital** am Handy/Tablet.
Der Packtisch scannt danach wie gewohnt jeden Artikel noch einmal als
Kontrolle; Kommissionieren bucht nichts.

- **Prozess:** optionaler Schritt `kommissionieren` im Versandprozess
  zwischen Verfügbarkeit und Packtisch (Aktion `lager.kommissionieren`).
  Abschaltbar je Firma (Prozesse → Versand); dann verschwindet der
  Menüpunkt und der Ablauf geht direkt zum Packtisch. Die Lieferung
  bleibt `assigned` — „kommissioniert" ist eine Tatsache am Beleg
  (`kommissioniert_am/_von`), kein zweiter Zustand.
- **Arbeitsvorrat** (`/kommissionieren`, Menü im Verkauf):
  versandbereite Lieferungen, Priorität und ältestes Datum zuerst, mit
  Marken „sammelt: Name", „teilweise 2/5", „Zettel gedruckt".
  **„Nächste Bestellung"** beansprucht die nächste freie (oder die eigene
  angefangene) und öffnet sie. Bereits kommissionierte stehen darunter
  („wartet am Packtisch").
- **Sperre:** `lager.kommissionierung_starten` setzt
  `kommissionierung_von/_seit`. Solange jemand sammelt (bis 30 Minuten
  ohne Abschluss), wird ein Zweiter mit Namen abgewiesen — auch beim
  Melden.
- **Sammel-Screen** (`/kommissionieren/<id>`, fürs Handy gebaut): eine
  große Karte je Artikel mit Name, SKU/Barcode, Belegtext und „0 / 2",
  geführt in Laufreihenfolge. Gescannt wird mit dem **Bluetooth-
  Handscanner** (unsichtbares Feld ohne Bildschirmtastatur) oder der
  **Kamera** (eingebauter `BarcodeDetector`, sonst — etwa auf iPhone —
  `@zxing/browser`, erst bei Bedarf geladen); SKU eintippen geht immer.
  Fremde Artikel: Fehlerton und Vibration. „+1 ohne Scan" gibt es nur für
  Artikel ohne SKU und Barcode (wird am Beleg vermerkt), „Fehlt" markiert
  und springt weiter, „Übersicht" zeigt alle Positionen. „Fehlt" lässt
  sich jederzeit zurücknehmen: „Rückgängig" in der Meldung, „Doch da" an
  der Karte (über die Übersicht erreichbar), die Liste unter „Alles durch"
  oder die offene Zeile im Abschluss antippen.
- **Ohne Scan bestätigen (Einstellung, für den Start ohne Barcodes):**
  Einstellungen → Versand & Druck → Kommissionieren
  (`einstellungen.kommissionieren_setzen`,
  `settings.kommissionieren.manuell_bestaetigen`). An: jede Karte hat
  „+1" und „Alle n" (setzt die offene Menge auf einmal), Scannen geht
  weiterhin; im Handbetrieb wird „ohne Scan" nicht an jeder Lieferung
  vermerkt. Der Arbeitsvorrat zeigt die Betriebsart („ohne Scan erlaubt"
  bzw. „Scan-Pflicht"). Aus: Scan-Pflicht bis auf Artikel ohne Code. Der Fortschritt
  liegt zusätzlich im Browser — ein Reload verliert nichts. Packzettel
  drucken geht vom Handy auf den Drucker des Arbeitsplatzes.
- **Abschluss:** `lager.kommissionieren` prüft serverseitig dieselbe
  Rechnung wie der Screen (`kommissionier-logik.ts`): nichts Fremdes,
  nicht zu viel, und vollständig — sonst nur mit **„unvollständig"** und
  Vermerk. Gespeichert wird je Bewegung `stock_moves.qty_kommissioniert`
  (Fortschritt, getrennt von `qty_done`); vollständig setzt die Marke,
  unvollständig schreibt „fehlt: …" als Fehler in den Verlauf der
  Lieferung und lässt sie im Vorrat. Die Sperre fällt in beiden Fällen.
- **Anzeige:** Die Versand-Liste zeigt je Zeile „kommissioniert" bzw.
  „sammelt: Name" und „Zettel gedruckt"; der Packtisch zeigt nach dem
  Scan „kommissioniert von … am …".

## Packen im Scanfeld (/scanner, früher /packtisch)

**Ein Scanfeld für alles** (Entscheidungslog 2026-10-01): Der eigene
Packtisch-Menüpunkt ist im Menüpunkt **„Scannen"** aufgegangen — die
gescannte Nummer entscheidet den Ablauf. Ein **Packzettel** (Lieferung
`WH/OUT/…`, auch Auftrags- oder Shop-Nummer) startet den Packablauf unten;
Wareneingang/Transfer und Fertigungsauftrag laufen als Checkliste
(docs/module/rollen-auswertungen-scanner-ki.md). Vorher buchte ein am
Scanner gescannter Packzettel die Lieferung als bloßen Transfer — ohne
Label und ohne Shop-Rückmeldung. `/packtisch` leitet auf `/scanner` um;
die Auflösung des Versand-Codes lebt in `versand/packtisch-beleg.ts`
(genutzt von `/api/scanner/lookup`, Antwort `{ versand }`).

Der Packablauf (Schreibrechte im Versand nötig) ist dieselbe Scan-Maschine
wie die Checkliste (Dauerfokus-Feld, Beeps, Leuchten), aber ohne
Teilmengen: ein Paket ist erst dann ein Paket, wenn alles drin ist.
Scans werden in beiden Tastaturbelegungen gesucht: ein US-Scanner an
deutschem Windows liefert „WH-OUT-00003" statt „WH/OUT/00003"
(`shared/scan.ts`, docs/module/rollen-auswertungen-scanner-ki.md).

1. **VERSAND-Code scannen** (vom Fertigungs- oder Packzettel). Ohne
   Scanner gibt es ein sichtbares Eingabefeld für Liefer-, Auftrags-
   oder Shopify-Nummer — nach dem Öffnen springt der Fokus zurück ans
   Scanfeld für die Artikel-Scans. `/api/packtisch/lookup`
   liefert die Sendung mit Auftrag, Kunde, Lieferadresse, den Positionen
   (je Variante aggregiert, mit SKU/Barcode) und dem Regelvorschlag für
   Gewicht und DHL-Produkt. Wächter mit Klartext statt stummem Fehler:
   „wartet auf die Fertigung: WH/MO/…" (der Zettel hängt noch dort),
   „nicht reserviert", „bereits versendet", „Position ohne SKU/Barcode".
   Ein vorhandenes Label ist kein Blocker — es wird wiederverwendet.
2. **Artikel scannen** (SKU- oder Artikel-Barcode vom Zettel bzw. vom
   Produkt) oder per +/− abhaken; fremde Artikel lehnt der Tisch mit
   Fehlerton ab.
3. **VERSAND-Code erneut scannen**, wenn alles im Paket ist → Bestätigung
   mit Gewichts-/Produktfeld (vorbelegt aus der Versandregel) → dritter
   Scan oder Knopf führt `versand.packtisch_abschliessen` aus: Label,
   Warenausgang, Kartonage, Shopify-Fulfillment mit Tracking (Shopify
   benachrichtigt den Kunden). Die Gegenprobe „gescannt ⊇ Soll" läuft
   serverseitig noch einmal — der Arbeitsplatz ist nur die Hülle um die
   Registry-Aktion (docs/prozesse.md, Abschnitt „Packtisch").

Druckt die Brücke am Platz des PCs (siehe „Arbeitsplätze und Drucker"),
kommt das Label still aus dem Labeldrucker des Tisches — **ohne**
zusätzlichen Tab (früher öffnete er immer, das ergab Doppeldrucke); die
Meldung sagt, auf welchem Drucker. Nur ohne Drucker öffnet es sich als
Tab und über den Knopf „Label öffnen". Im Kopf der Seite zeigt ein
Typenschild, ob DHL konfiguriert ist (sonst mit den Namen der fehlenden
Variablen). Der Scan des nächsten Zettels im „Versandfertig"-Zustand
geht zurück ans Scanfeld, das ihn wieder zuordnet — das nächste Paket,
ein Wareneingang oder ein Fertigungsauftrag, ohne Seitenwechsel.

## Druckbrücke (stiller Druck am Arbeitsplatz)

Die App (Vercel) erreicht die LAN-Drucker nie — deshalb ein
**Pull-Modell**: Aktionen reihen Druckaufträge ein (Tabelle
`druckauftraege`, idempotent solange einer offen ist), und kleine Agenten
auf den Arbeitsplatz-PCs holen ab, drucken und quittieren. Kein
Benutzer-Login auf den Geräten; authentifiziert wird über das gemeinsame
Token.

**Der Druckweg ist eine Betreiber-Einstellung**, keine Env-Variable
(Einstellungen → Versand & Druck, Registry-Aktion
`einstellungen.druckbruecke_setzen`, settings-Schlüssel `druckbruecke`;
Reihenfolge wie bei den KI-Modellen: Einstellung → Env-Notausgang
`DRUCK_AGENT_TOKEN` → Standard):

- **„PDF im Browser"** (Standard): Labels und Zettel öffnen als Tab und
  laufen über den Browser-Druckdialog — zum Testen und für Aufbauten
  ohne Agenten, kein Setup nötig.
- **„Druckbrücke"**: Aufträge gehen in die Warteschlange und die Agenten
  drucken still. Beim ersten Umstellen erzeugt die App das Agent-Token
  automatisch; es steht in der Karte zum Kopieren. Gilt sofort, kein
  Redeploy.

### Arbeitsplätze und Drucker (0087)

Jeder Druck kommt am Platz des PCs heraus — zwei Packtische mit je
eigenem Labeldrucker (verschiedene Formate), der Etikettendrucker für
Fertigungsaufträge und der A4-Drucker der Werkstatt. Gepflegt unter
**Einstellungen → Arbeitsplätze & Drucker** (nur Administratoren):

- **Arbeitsplätze** sind die Arbeitsplätze der Fertigung (`work_centers`,
  eine Liste für alles) mit einer **Art**: Fertigung (Montagetisch),
  Versand (Packtisch), Lager, Sonstiges. Angelegt/geändert über
  `fertigung.arbeitsplatz_anlegen/_aendern`.
- **Drucker** (`drucker`): Name, Standort, Name unter Windows, Typ
  (Etikett oder A4), Etikettenmaße in mm (bei Etiketten Pflicht) und
  optional das **DHL-Format** für Labels auf diesem Drucker — das Label
  wird schon beim Erzeugen in diesem Format bei DHL bestellt
  (`shipments.label_format`); ohne Angabe gilt das Standardformat aus
  Versand & Druck. Aktionen `einstellungen.drucker_speichern/_schalten/
  _loeschen` (Löschen storniert offene Aufträge des Druckers).
- **Druckwege** (`arbeitsplatz_druckwege`): je Arbeitsplatz und Druckart
  ein Drucker — Druckarten `versandlabel`, `packzettel`,
  `fertigungszettel`, `fertigungsetikett`, `artikeletikett`. Die Zeile
  **„Ersatz"** (Weg ohne Arbeitsplatz) springt für alle Plätze ohne
  eigenen Weg ein. Aktion `einstellungen.druckweg_setzen`.

**Wo bin ich?** Jeder PC wählt **einmal oben im Kopf** seinen
Arbeitsplatz (Cookie `erp_arbeitsplatz`, 400 Tage, übersteht das
Abmelden). Ab dann druckt jede Anmeldung an diesem PC auf die Drucker des
Platzes; umschalten geht jederzeit im Kopf. `serverAktion` gibt den Platz
als `arbeitsplatzId` an die Aktionen weiter.

**Auflösung je Druck** (`src/modules/druck/`): Weg des Platzes → Ersatz →
PDF im Browser. Die Meldung sagt, wo gedruckt wurde, z. B. „Gedruckt auf
HP Werkstatt (Montagetisch 1) — Ersatzdrucker, Packtisch 1 hat keinen
Drucker für Fertigungszettel." Ein abgeschalteter Drucker oder
Arbeitsplatz zählt wie keiner.

**Übergang:** Solange **kein** Drucker angelegt ist, läuft die Brücke wie
vor 0087 über die festen Ziele `labeldrucker`/`zetteldrucker` (Alt-Agenten
mit `DRUCK_ZIELE` drucken weiter). Sobald der erste Drucker existiert,
gehen Aufträge nur noch an Drucker — alte Pakete je PC dann durch die
Pakete je Drucker ersetzen.

### Einrichtung der Agenten (ein Agent je Drucker)

1. Einstellungen → Versand & Druck: den Druckweg auf **Druckbrücke**
   stellen (erzeugt das Agent-Token).
2. Einstellungen → Arbeitsplätze & Drucker: Plätze, Drucker und Wege
   anlegen; das Paket gibt es oben auf der Seite in der Karte
   **„Druckbrücke einrichten — ein Paket je Drucker"** (drei Schritte,
   ein Knopf „Paket herunterladen" je aktivem Drucker, Warnung, wenn der
   Windows-Druckername fehlt) und an der Druckerzeile in der Spalte
   „Paket"
   (`GET /api/druck/paket?drucker_id=…`, nur Administratoren — es enthält
   das Token). Darin: `druck-agent.ps1` (Windows-Agent, unverändert aus
   `scripts/`), `druckbruecke-starten.cmd` mit Adresse, Token,
   Drucker-ID und Windows-Druckername bereits eingetragen (startet nach
   einem Absturz neu), `autostart-einrichten.cmd` (Verknüpfung mit dem
   Druckernamen — zwei Drucker an einem PC stören sich nicht),
   `LIESMICH.txt` sowie `druck-agent.ts` + `druckbruecke-starten.sh` für
   Linux/macOS.
3. Auf dem PC **wird nichts installiert**: ZIP je Drucker in einen
   eigenen Ordner entpacken, `druckbruecke-starten.cmd` doppelklicken,
   einmal `autostart-einrichten.cmd`. Bei „Agent" steht an der
   Druckerzeile dann „aktiv".
4. Windows druckt über **SumatraPDF** — Etiketten mit
   `-print-settings fit` (auf das Etikett eingepasst), A4 mit `shrink`.
   Der Agent sucht ein vorhandenes SumatraPDF (`DRUCK_SUMATRA`, Ordner
   des Pakets, `%LOCALAPPDATA%`, `Programme`); fehlt es, lädt er beim
   ersten Start einmalig die **portable** Version 3.5.2 (64 Bit) in den
   Paketordner — SHA-256 fest im Skript hinterlegt, bei Abweichung bricht
   er ab. Linux/macOS drucken über `lp` (Etiketten mit
   `-o fit-to-page`); ein eigenes Kommando geht dort über
   `DRUCK_KOMMANDO` mit den Platzhaltern `{datei}`, `{drucker}` und
   `{skalierung}`.

**Zwei Agenten, ein Protokoll** (Entscheidungslog 2026-09-30):

- **Windows:** `scripts/druck-agent.ps1` läuft mit dem eingebauten
  Windows PowerShell 5.1 (`powershell -NoProfile -ExecutionPolicy Bypass
  -File`), ohne Node.js. Das Skript ist reines ASCII (PowerShell 5.1 liest
  Skripte ohne BOM als ANSI) und im Paket mit CRLF. Es holt **je Abruf
  genau einen Auftrag** (`&limit=1`, Server erlaubt 1–3), weil
  `ConvertFrom-Json` in 5.1 an großen Antworten scheitert; gelesen wird
  mit `JavaScriptSerializer` ohne Längengrenze. Störungen (Token
  ungültig, Drucker unbekannt, Netz weg) meldet es einmal verständlich
  und versucht weiter.
- **Linux/macOS:** `scripts/druck-agent.ts` mit Node ≥ 22.6
  (`node --experimental-strip-types druck-agent.ts`).
- Beide nehmen dieselben Variablen: `KRNL_URL`, `DRUCK_AGENT_TOKEN`,
  `DRUCK_DRUCKER_ID`, optional `DRUCKER`. Ohne `DRUCK_DRUCKER_ID` laufen
  sie im Alt-Betrieb (`DRUCK_ZIELE`, `DRUCK_AGENT_NAME`).

**Abholen mit Sperre:** Der Agent fragt alle 3 Sekunden
(`DRUCK_INTERVALL_MS`) `GET /api/druck/abholen?drucker=<id>` (Bearer-Token;
liefert die PDFs base64 und den Druckertyp), druckt und meldet je Auftrag
ok/fehler (`POST /api/druck/quittieren`). Abgeholt wird mit `for update
skip locked` und Zeitstempel `abgeholt_am` — zwei Agenten bekommen nie
denselben Auftrag; bleibt die Quittung zwei Minuten aus, wird er erneut
angeboten (`src/modules/druck/abholen.ts`). Jeder Abruf setzt
`drucker.zuletzt_gesehen`. Solange Aufträge kommen, zieht der Agent ohne
Pause weiter (Fließband). Ein Label-Auftrag ohne gespeichertes PDF wird
serverseitig sofort als Fehler quittiert, ein Zettel-Auftrag ebenso, wenn
sein Rendern scheitert. Diagnose: Druckerzeile (Agent, offene Aufträge,
Fehler der letzten 7 Tage) und die Karte „Druckbrücke" auf der
Integrationen-Seite.

## Massendruck (Fließband am Packtisch)

Die Versandbereit-Liste ist filterbar (nur Einzelpositions-Aufträge, SKU,
Zielland, DHL-Produkt laut Regel) — „alle Single-Line mit SKU KC-*" ist ein
Filter plus ein Klick. Der Massendruck erstellt Labels für die gefilterte
Liste nach Regelvorschlag (bis 25 je Lauf) und druckt sie am Labeldrucker
des Arbeitsplatzes (im Format dieses Druckers); ohne Drucker liefert er ein
**Sammel-PDF** über `/api/label/sammel?ids=…`. Jede Lieferung wird dabei
ausgebucht (Warenausgang + Shopify-Fulfillment, 0103); nur mit dem Haken
„nicht ausbuchen" bleibt es bei den Labels. Fehler einzelner Lieferungen
brechen den Lauf nicht ab und stehen am jeweiligen Beleg.

## Zolldaten (Drittland)

Sendungen in Nicht-EU-Länder (auch CH, GB, NO) bekommen automatisch einen
`customs`-Block (CN23): Positionen aus der Lieferung mit HS-Code und
Ursprungsland vom Produkt, Warenwert aus den Auftragszeilen (sonst
Listenpreis), `exportType COMMERCIAL_GOODS`, Rechnungsnummer =
Auftragsnummer. Fehlt ein HS-Code, wird das Label trotzdem erstellt und ein
Hinweis an der Sendung hinterlegt.

## Sendungen (`shipments`)

Eine Lieferung kann 1..n Sendungen haben (Multicollo-Erweiterung vorgesehen; erster Ausbau: 1 Paket je Lieferung).

Felder: Lieferung (`picking_id`), Verkaufsauftrag, DHL-Produkt (`V01PAK` national, `V62KP` Kleinpaket, `V54EPAK` Europaket, `V53WPAK` International), `billing_number`, Gewicht (aus Produktgewichten summiert, editierbar), Versicherungswert, Regelname, `shipment_number` (= Trackingnummer), `tracking_url`, Label-Pfad (Storage), Status, `shopify_fulfillment_id`, Fehlerinfo.

**Status-Maschine:**

```
created ──(Manifest/Tagesabschluss)──▶ manifested ──▶ transit ──▶ delivered
created ──(Storno, nur vor Manifest)──▶ cancelled                └──▶ failure
```

- `created` → `cancelled`: `DELETE /orders?shipment=…` — nur bis zur Manifestierung (automatisch ~17:45 Uhr); danach ist das Label verbraucht und eine neue Sendung nötig.
- `transit`/`delivered`/`failure` kommen aus dem Tracking-Sync (DHL-`statusCode`: `pre-transit`, `transit`, `delivered`, `failure`, `unknown`).

## Label-Erstellung (Detail)

- **Auth:** OAuth2 ROPC (GKP-Systembenutzer + API-Key/Secret); Token-Refresh im DHL-Client gekapselt. Kein Basic Auth (deprecated).
- **Request:** Empfängeradresse aus der Lieferung (Straße/Hausnummer getrennt — Feld-Splitting beim Shopify-Import), `country` als ISO-alpha-3, `refNo` = Auftragsnummer, `docFormat: PDF`, `printFormat` konfigurierbar (Default 910-300-700).
- **Warnings** aus der DHL-Response (weiche Adressvalidierung) am Beleg anzeigen — nicht leitcodierbare Adressen kosten Nachcodierungs-Entgelt.
- **Fehler:** DHL-Aufruf läuft als synchrone Aktion mit klarer Fehlermeldung (kein stiller Outbox-Retry — der Packer steht am Tisch und braucht das Label jetzt); bei Teilerfolgen im Batch einzelne Fehler anzeigen.
- **Sandbox** in Entwicklung/Tests (`api-sandbox.dhl.com`, Test-Abrechnungsnummern); Produktions-Keys nur in Vercel-Prod-Env.

## Tracking-Sync

- **Cron (stündlich):** alle Sendungen mit Status `created/manifested/transit` (älteste Prüfung zuerst, je Sendung höchstens alle zwei Stunden) über die **Parcel DE Tracking API** als Sammelabfrage holen — 20 Sendungen je Aufruf, bis 100 je Lauf —, Status + letztes Ereignis speichern; `delivered` beendet den Sync. XML-Bau, Antwort-Parser und Statusableitung liegen rein und getestet in `dhl-tracking-xml.ts`, der HTTP-Aufruf in `trackShipments()` (dhl.ts).
- **Rate-Limit-Budget:** 1.000 Aufrufe und 10.000 Sendungen je Tag, 3 Aufrufe je Sekunde (Sync pausiert 400 ms zwischen Stapeln) — bei stündlichem Lauf reicht das für rund 2.000 offene Sendungen ohne Erhöhung. Bricht DHL eine Abfrage ab (Limit, Anmeldung), gilt der ganze Stapel als geprüft und der Grund steht im Ergebnis des Laufs (`fehler`) bzw. im Aktionstext „Tracking aktualisieren". Rückfall auf die Unified Tracking API per `DHL_TRACKING_API=unified` (250 Aufrufe/Tag, 1 alle 5 s, Stapel 20). Erweiterung: Unified **Push API** (Webhooks je Sendung) statt Polling.
- **Datenschutz-Auflage:** Trackingdaten 30 Tage nach Zustellung löschen (Cron bereinigt `last_tracking_event`).

## Shopify-Rückmeldung

- Outbox-Job nach Validierung der Lieferung: FulfillmentOrders der Order abfragen → `fulfillmentCreate` (Voll-Fulfillment; Teil-Fulfillment bei Teillieferung über die Line-Item-Zuordnung der gelieferten Positionen), `notifyCustomer: true`.
- Fehlerbilder behandeln (aus der Sendcloud-Praxis bekannt): `nonFulfillableQuantity > 0`, fehlende Location, Rate-Limits → Retry mit Backoff, nach 10 Versuchen Fehler-Aktivität am Auftrag.
- Tracking-Korrektur (z. B. Label storniert + neu erstellt): `fulfillmentTrackingInfoUpdate`.
- Der `ready-to-ship`-Tag entfällt als Versand-Trigger (das machte nur für Sendcloud Sinn). Optional bleibt ein konfigurierbarer Status-Tag (z. B. `in-fertigung`) als Info im Shopify-Admin — Default: aus.

## Retouren (DHL Returns API)

Aus dem Reparatur-/Retourenprozess heraus: Button „DHL-Retourenlabel erstellen" → `POST returns/v1/orders?labelType=BOTH` (`receiverId` des GKP-Retourenempfängers, Kundenadresse als Absender) → Label-PDF + QR-Code per E-Mail an den Kunden (Resend). Voraussetzung: Retouren-Vertrag + Retourenempfänger im GKP.
Meldet DHL „Sorry, this recipient is not available", kennt das Konto die
gesendete `receiverId` nicht (Standard `deu`, solange
`DHL_RETURN_RECEIVER_ID` fehlt): im Geschäftskundenportal unter Retouren
einen Retourenempfänger mit Retouren-Abrechnungsnummer (Verfahren 07)
anlegen und dessen Empfänger-ID als `DHL_RETURN_RECEIVER_ID` setzen. Die
Fehlermeldung nennt die gesendete ID.

**Reparaturen (seit 0082):** Das Retourenlabel entsteht aus dem Reparaturauftrag (`reparatur.retourenlabel_senden`, auch als Teil von „Annehmen" der Reparaturanfrage) mit der **RMA-Nummer als `customerReference`**; die Mail nennt die RMA-Nummer und bittet um einen Zettel im Paket. Die generische Retouren-Seite bleibt für Retouren ohne Reparatur. Der **Rückversand** des reparierten Geräts ist eine Sendung **ohne Lieferung** (`shipments.repair_order_id`, `picking_id` null — genau eins per Check): Adresse vom Kunden, Referenz die RMA-Nummer, Gewicht aus dem Produkt oder Handeingabe, Produkt nach Land, keine Kartonage, keine Versicherung, Zoll bei Drittland als `RETURN_OF_GOODS`. Tracking läuft über denselben Sync wie bei Lieferungen; die Versandliste zeigt solche Sendungen mit `RMA/…` statt Lieferung. Retourenlabels selbst werden nicht verfolgt (Folgeaufgabe).

## UI

- **Versandbereit-Liste**: alle reservierten, unversandten Lieferungen (Auftrag, Kunde, Shopify-Name, Fertigungsstatus) — die Packstation-Arbeitsliste, mit Auswahl für den Packzettel-Druck und den Kommissionier-Marken. Darüber steht live, wie viele Lieferungen noch auf Ware warten; sie rücken von selbst nach, sobald Bestand gebucht ist (Live-Reservierung, [lager.md](lager.md)).
- **Lieferungs-Formular**: Abschnitt „Versand" mit Paketgewicht, DHL-Produkt, Buttons „Label erstellen"/„Label drucken"/„Sendung stornieren", Tracking-Status-Badge + Link, Shopify-Rückmeldestatus.
- **Sendungsliste**: alle Sendungen mit Status-Filter; Fehler-Feed (fehlgeschlagene Fulfillment-Jobs, DHL-Warnings).
- **Einstellungen**: DHL-Zugangsdaten-Check (Test-Call), Abrechnungsnummern je Produkt, Default-Produkt/-Format, Absenderadresse (`shipperRef`), Status-Tag an/aus.

## Abnahmekriterien

1. Lieferung mit DE-Adresse: „Label erstellen" liefert Trackingnummer + druckbares PDF (Sandbox); Sendung `created`, Label liegt im Storage.
2. Validierung der Lieferung erzeugt genau einen Fulfillment-Job; die Shopify-Order (Dev-Store) ist danach „fulfilled" mit DHL-Trackingnummer und der Kunde erhält die Shopify-Versandmail (`notifyCustomer: true`).
3. Teillieferung erzeugt Teil-Fulfillment nur über die gelieferten Positionen.
4. Storno vor Manifest: DHL-Sendung gelöscht, Status `cancelled`, neues Label erstellbar; nach Manifest wird der Storno mit verständlicher Meldung abgelehnt.
5. Tracking-Cron setzt den Status bis `delivered` und respektiert das Rate-Limit-Budget.
6. EU-Adresse (z. B. AT) erzeugt ein Europaket-Label mit alpha-3-Ländercode.
7. Retourenlabel-Erstellung liefert PDF + QR und versendet die Mail an den Kunden.
