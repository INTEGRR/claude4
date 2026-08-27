# Modul Versand (DHL-Direktanbindung)

API-Referenz: [docs/api-referenz/dhl.md](../api-referenz/dhl.md) · Nachbau-Vorlage: [docs/api-referenz/sendcloud-shopify-funktionsumfang.md](../api-referenz/sendcloud-shopify-funktionsumfang.md)

## Zweck

Ersetzt Sendcloud vollständig: Unser System erstellt DHL-Versandlabels direkt (Parcel DE Shipping API v2), verfolgt den Sendungsstatus und meldet Fulfillment + Tracking selbst an Shopify zurück (inkl. Versandmail an den Kunden über Shopify).

## Ablauf (Happy Path)

```
Fertigung abgeschlossen (alle MOs des Auftrags done)
  → Lieferung (WH/OUT) wird reserviert und erscheint in „Versandbereit"
  → Packen: Lieferung öffnen → „DHL-Label erstellen"
      → POST /orders (Parcel DE Shipping API): shipment_number + Label-PDF
      → Label-PDF in Supabase Storage persistieren (DHL hält es nur ~3 Tage vor!)
      → Label drucken (PDF; ZPL-Thermodruck als Erweiterung)
  → Lieferung validieren (Warenausgang bucht Bestand aus)
      → Outbox-Job „shopify_fulfillment_create": fulfillmentCreate mit
        trackingInfo { company: "DHL", number, url } + notifyCustomer: true
        (Shopify verschickt die Versandbestätigung an den Kunden)
  → Tracking-Sync aktualisiert den Sendungsstatus bis „zugestellt"
```

Reihenfolge-Entscheidung: Label **vor** Validierung (physisch: Label aufs Paket, dann raus); die Shopify-Rückmeldung hängt an der **Validierung** der Lieferung — das entspricht Sendclouds Verhalten „Rückmeldung bei Label-Erstellung", nur sauberer an unseren Warenausgang gekoppelt.

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
beschriftete **VERSAND-Barcode** (Lieferungsnummer — öffnet die Sendung
am Packtisch), dazu Auftrag/Shopify-Nummer/Kunde, die Lieferadresse und
die Positionsliste mit **Artikel-Code je Zeile** (EAN bzw. Code 128 der
SKU) zum Gegenscannen. Für Bestellungen mit Fertigung übernimmt der
Fertigungszettel diese Rolle (zwei Barcodes, docs/module/fertigung.md);
der Packzettel ist das Gegenstück für reine Lager-Bestellungen — und
zugleich der Kommissionierbeleg.

## Packtisch-Arbeitsplatz (/packtisch)

Der Arbeitsplatz für den echten Ablauf am Tisch (Menüpunkt „Packtisch",
Schreibrechte im Versand nötig) — dieselbe Scan-Maschine wie der
Scanner-Arbeitsplatz (Dauerfokus-Feld, Beeps, Leuchten), aber ohne
Teilmengen: ein Paket ist erst dann ein Paket, wenn alles drin ist.

1. **VERSAND-Code scannen** (vom Fertigungs- oder Packzettel; tippbar sind
   auch Liefer-, Auftrags- oder Shopify-Nummer). `/api/packtisch/lookup`
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

Ist die Druckbrücke konfiguriert, kommt das Label still aus dem
Labeldrucker; sonst (und zusätzlich, als Zweitausdruck) öffnet es sich
als Tab und über den Knopf „Label öffnen". Im Kopf der Seite zeigt ein
Typenschild, ob DHL konfiguriert ist (sonst mit den Namen der fehlenden
Variablen). Der Scan des nächsten Zettels im „Versandfertig"-Zustand
startet direkt das nächste Paket.

## Druckbrücke (stiller Labeldruck am Packtisch)

Die App (Vercel) erreicht den LAN-Drucker nie — deshalb ein
**Pull-Modell**: `versand.packtisch_abschliessen` reiht das Label als
Druckauftrag ein (Tabelle `druckauftraege`, idempotent solange einer
offen ist), und ein kleiner Agent auf dem Packtisch-PC holt ab, druckt
und quittiert. Kein Benutzer-Login auf dem Gerät; authentifiziert wird
über das gemeinsame Token.

**Einrichtung:**

1. In Vercel die Env-Variable `DRUCK_AGENT_TOKEN` setzen (langer
   Zufallswert, z. B. `openssl rand -hex 32`) und redeployen. Ohne die
   Variable gilt weiter der Tab-Fallback.
2. Auf dem Packtisch-PC: Node ≥ 22 installieren, die Datei
   `scripts/druck-agent.ts` aus dem Repo kopieren (sie ist bewusst
   abhängigkeitsfrei — kein `npm install` nötig) und starten:

   ```powershell
   $env:KRNL_URL = "https://<instanz>.vercel.app"
   $env:DRUCK_AGENT_TOKEN = "<dasselbe Token>"
   $env:DRUCKER = "Zebra GK420d"     # optional, sonst Standarddrucker
   node druck-agent.ts
   ```

3. Windows druckt standardmäßig über **SumatraPDF**
   (`SumatraPDF -print-to … -silent`, muss im PATH liegen),
   Linux/macOS über `lp`. Ein eigenes Kommando geht über
   `DRUCK_KOMMANDO` mit den Platzhaltern `{datei}` und `{drucker}`.

Der Agent fragt alle 3 Sekunden (`DRUCK_INTERVALL_MS`) nach den ältesten
offenen Aufträgen (`GET /api/druck/abholen`, Bearer-Token; liefert die
PDFs base64), druckt und meldet je Auftrag ok/fehler
(`POST /api/druck/quittieren`). Solange Aufträge kommen, zieht er ohne
Pause weiter (Fließband). Diagnose auf der Integrationen-Seite: Karte
„Druckbrücke" mit letztem Abruf des Agenten, offenen Aufträgen und
Fehlern der letzten 7 Tage. Ein Auftrag ohne gespeichertes Label-PDF
wird serverseitig sofort als Fehler quittiert.

## Massendruck (Fließband am Packtisch)

Die Versandbereit-Liste ist filterbar (nur Einzelpositions-Aufträge, SKU,
Zielland, DHL-Produkt laut Regel) — „alle Single-Line mit SKU KC-*" ist ein
Filter plus ein Klick. Der Massendruck erstellt Labels für die gefilterte
Liste nach Regelvorschlag (bis 25 je Lauf), liefert ein **Sammel-PDF** über
`/api/label/sammel?ids=…` und bucht auf Wunsch je Lauf direkt aus
(Warenausgang + Shopify-Fulfillment); Standard ist „nur Labels", ausgebucht
wird beim Packen. Fehler einzelner Lieferungen brechen den Lauf nicht ab und
stehen am jeweiligen Beleg.

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

- **Cron (stündlich):** alle Sendungen mit Status `created/manifested/transit` über die **Unified Tracking API** abfragen (`service=parcel-de`), Status + letztes Event speichern; `delivered` beendet den Sync.
- **Rate-Limit-Budget:** Initial 250 Calls/Tag, 1 Call/5 s — Sync dros­selt sich selbst (Batching nach ältestem Sync zuerst); **Upgrade früh bei DHL beantragen**. Erweiterung: Unified **Push API** (Webhooks je Sendung) statt Polling, oder die Parcel-DE-Tracking-API (20 Sendungen/Call, 10.000/Tag).
- **Datenschutz-Auflage:** Trackingdaten 30 Tage nach Zustellung löschen (Cron bereinigt `last_tracking_event`).

## Shopify-Rückmeldung

- Outbox-Job nach Validierung der Lieferung: FulfillmentOrders der Order abfragen → `fulfillmentCreate` (Voll-Fulfillment; Teil-Fulfillment bei Teillieferung über die Line-Item-Zuordnung der gelieferten Positionen), `notifyCustomer: true`.
- Fehlerbilder behandeln (aus der Sendcloud-Praxis bekannt): `nonFulfillableQuantity > 0`, fehlende Location, Rate-Limits → Retry mit Backoff, nach 10 Versuchen Fehler-Aktivität am Auftrag.
- Tracking-Korrektur (z. B. Label storniert + neu erstellt): `fulfillmentTrackingInfoUpdate`.
- Der `ready-to-ship`-Tag entfällt als Versand-Trigger (das machte nur für Sendcloud Sinn). Optional bleibt ein konfigurierbarer Status-Tag (z. B. `in-fertigung`) als Info im Shopify-Admin — Default: aus.

## Retouren (DHL Returns API)

Aus dem Reparatur-/Retourenprozess heraus: Button „DHL-Retourenlabel erstellen" → `POST returns/v1/orders?labelType=BOTH` (`receiverId` des GKP-Retourenempfängers, Kundenadresse als Absender) → Label-PDF + QR-Code per E-Mail an den Kunden (Resend). Voraussetzung: Retouren-Vertrag + Retourenempfänger im GKP.

## UI

- **Versandbereit-Liste**: alle reservierten, unversandten Lieferungen (Auftrag, Kunde, Shopify-Name, Fertigungsstatus) — die Packstation-Arbeitsliste.
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
