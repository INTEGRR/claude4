# Modul Integrationen (Shopify, E-Mail)

API-Referenz: [docs/api-referenz/shopify.md](../api-referenz/shopify.md) · Versand/DHL: [docs/module/versand.md](versand.md)

## Shopify — Lese-/Schreibmodus (Staging-Schalter)

Die Anbindung hat einen Betreiber-Schalter `settings.shopify.modus`
(Einstellungen → Schnittstellen, Registry-Aktion
`einstellungen.shopify_modus_setzen`, nur Admin, auditiert):

- **lesen** (Standard, auch ohne Eintrag): KRNL hängt am Live-Shop und
  holt Bestellungen, Kunden und Produkte — Webhook-Empfang, 15-Minuten-
  Abgleich, Importe. Aber **nichts geht hinaus**: keine Fulfillments,
  kein Tracking, keine Bestände, keine Produktänderungen, keine
  Webhook-Registrierung. Das ist der Parallelbetrieb neben Odoo.
- **schreiben**: alle Rückmeldungen scharf. Ab dem Stichtag.

Durchgesetzt wird das an **einer** Naht: `shopifyGraphQL()` weist jede
GraphQL-Mutation mit `ShopifyNurLesen` ab (Erkennung in
`shopify-modus.ts`) — vor der Konfigurationsprüfung, hinter dem Fake
(der Fake hat keinen Shop zu schützen). Die Outbox hakt einen so
abgewiesenen Job als **erledigt mit „Übersprungen: …"** ab — nicht als
fehlgeschlagen, und er läuft nach dem Umschalten **nicht nach**: Eine
Bestellung aus der Lesezeit ist bis dahin im Altsystem erledigt, ein
verspätetes Fulfillment würde den Kunden doppelt benachrichtigen. Am
Beleg steht ein Info-Ereignis, im Job-Monitor das Ergebnis, im
Transaktionsprotokoll ein Eintrag mit `ok = false`. Nach dem
Scharfschalten: einmal „Mit Shopify abgleichen" (Bestand) und Webhooks
registrieren. Der Wächter hängt am Dokumentanfang (`mutation …`); der
Token-Tausch (Client-Credentials) ist keine Mutation und läuft immer.
Entscheidungslog 2026-09-18.

## Shopify — Order-Import

**Setup (einmalig, manuell):** Custom App im Shopify Dev Dashboard mit Scopes `read_orders`, `write_orders`, `write_merchant_managed_fulfillment_orders`; Admin-API-Token (`shpat_…`) + Webhook-Secret als Env-Vars. Webhook-Subscriptions per `webhookSubscriptionCreate` auf: `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled` → `https://<app>/api/webhooks/shopify`.

**Empfang (Route Handler):**
1. Raw Body lesen, HMAC (`X-Shopify-Hmac-Sha256`, Schlüssel = Client Secret) timing-sicher prüfen; Mismatch ⇒ 401.
2. Event in `shopify_webhook_events` speichern — idempotent über `X-Shopify-Webhook-Id` (Duplikat ⇒ 200, skip).
3. Sofort **200** antworten (Shopify-Timeout: 5 s); Verarbeitung asynchron.

**Verarbeitung (Job-Runner, Vercel Cron im Minutentakt):**
- `orders/create` / `orders/paid`:
  1. Kunde per `shopify_customer_id` anlegen bzw. **nur Lücken füllen** (seit 0089 — im ERP Gepflegtes bleibt; die Lieferadresse steht eingefroren am Auftrag). **Straße/Hausnummer beim Import trennen**, DHL braucht sie getrennt.
  2. Positionen mappen: Shopify-`sku` bzw. `variant_id` → `product_variants` (Felder `sku`, `shopify_variant_id`). **Kein Treffer ⇒ Zeile in `shopify_unmatched_lines`**, Order wird mit Hinweis-Status angelegt, manuelle Zuordnung in der UI (lernt: Mapping wird an der Variante gespeichert).
  3. Verkaufsauftrag anlegen (`source = 'shopify'`, `shopify_order_id` unique ⇒ Upsert statt Duplikat). Bezahlte Order (`financial_status = paid`) ⇒ direkt `confirm_sales_order` (Status `sale`, Lieferung + Fertigungsaufträge entstehen automatisch). In Shopify bereits versandte Orders werden **historisch** übernommen (`historisch = true`, geliefert, ohne Lieferung/Fertigung).
  4. **Preise netto (seit 0089):** An der Position steht der Netto-Stückpreis **nach allen Rabatten** (`discountedUnitPriceAfterAllDiscountsSet`, bei `taxesIncluded` mit herausgerechneter Steuer) und der Steuersatz aus den `taxLines`; die Versandkosten netto am Auftrag (`sales_orders.versandkosten`, nicht Teil von `sales_order_total` = Warenumsatz). Bis 0089 stand dort der Brutto-Listenpreis vor Rabatt — Umsätze waren um Steuer und Rabatte zu hoch. Alt-Aufträge korrigiert die Aktion `integrationen.shopify_preise_nachziehen` (Integrationen → Historie aus Shopify, je Klick 30, liest nur).
- `orders/cancelled`: zugehörigen Auftrag stornieren (Regeln des Verkaufsmoduls); nicht manifestierte DHL-Sendungen der Lieferung werden storniert (siehe Versand-Modul).
- `orders/updated`: Adress-/Tag-Änderungen nachziehen; Mengenänderungen nur solange kein MO `done` und kein Label erstellt ist, sonst Warn-Aktivität.

**Kunden-Erstübernahme** (Monitor → „Kunden (mit Bestellung) und Bestellungen"): holt nur
Shopify-Kunden mit mindestens einer Bestellung (`customers(query: "orders_count:>0")`,
`KUNDEN_MIT_BESTELLUNG`). Shopify führt auch Newsletter-, SMS-Gateway- und Bot-Anmeldungen als
Kunden — beim ersten ANVIL-Import waren 7.464 von 7.567 Kontakten ohne Bestellung
(Entscheidungslog 2026-09-29). Kunden aus Bestellungen entstehen ohnehin beim Order-Import.

**Reihenfolge der Erstübernahme (erzwungen seit 2026-09-30):** Die Karte auf dem Monitor
nummeriert die Schritte: **1 · Produkte** („Produkte aus Shopify verknüpfen/übernehmen"),
dazwischen am besten die Stücklisten aus Odoo (Einstellungen → Odoo-Übernahme), dann
**2 · Kunden und Bestellungen**. Bestellungen lassen sich erst übernehmen, wenn mindestens
eine Variante mit Shopify verknüpft ist und keine Produktübernahme mehr in der Outbox steht.
Ohne Artikel landete jede Position in der Klärliste, und bereits versandte Bestellungen
würden als Historie **ohne Positionen** übernommen (ein zweiter Lauf füllt sie nicht nach).
„Nur Kunden" geht jederzeit.

**Reconciliation (Sicherheitsnetz, Cron alle 15 min):** GraphQL `orders(query: "updated_at:>{last_sync}", sortKey: UPDATED_AT)` paginiert abholen (bis 500 je Lauf) und mit `shopify_order_id` abgleichen — fängt verlorene Webhooks ab (Shopify garantiert keine Zustellung). `last_reconciliation_at` in `shopify_sync_state` rückt bei weiteren Seiten nur bis zur letzten gelesenen Änderung vor (bis 0089 las der Abgleich nur 50 und übersprang den Rest).

**Historie aus dem CSV-Export (seit 0089, Integrationen → Historie aus Shopify):** Die Schnittstelle liefert ohne den geschützten Scope `read_all_orders` nur die **letzten 60 Tage** — die Erstübernahme endete deshalb bei rund 100 Bestellungen. Die ältere Historie kommt aus dem Export des Shop-Admins (Bestellungen → Exportieren → „Alle Bestellungen", CSV):

- Der Browser liest die Datei (`src/modules/integrationen/shopify-csv.ts`, RFC 4180, Zeilen je Bestellung gruppiert), zeigt eine Vorschau (Zeitraum, Anzahl, Warenumsatz netto, unbekannte SKUs — `integrationen.historie_pruefen`) und überträgt in Paketen zu 100 (`integrationen.historie_importieren`, nur Admin; anhalten und fortsetzen gefahrlos).
- **Netto-Preise:** Steuer inklusive oder nicht wird aus Zwischensumme, Versand, Steuern und Gesamt abgeleitet; Zeilen- und Auftragsrabatte werden anteilig verteilt (`exportPositionenNetto`, Summe trifft die Zwischensumme). Steuersatz aus „Tax 1 Name".
- **Übernommen werden** erfüllte und stornierte/erstattete Bestellungen sowie offene, die älter als 60 Tage sind; offene der letzten 60 Tage bleiben dem Live-Import (Lieferung, Fertigung).
- **Als Historie:** `historisch = true`, Nummer = Shopify-Name (`#38690`, schont den Nummernkreis), `sale`/`full` bzw. `cancel`, `qty_delivered` = Menge — keine Lieferung, Reservierung oder Fertigung (`confirm_sales_order` tut für `sale` nichts). Zählt in Abverkauf, Umsatz und Deckungsbeitrag am Bestelldatum.
- **Doppel-Schutz** über Shopify-ID und Bestellname; ein zweiter Lauf legt nichts doppelt an.
- **Kontakte** per E-Mail zugeordnet, sonst mit Name, E-Mail und Land angelegt — bestehende werden nie geändert.
- **Unbekannte SKUs** (gelöschte Produkte) werden archivierte Historie-Artikel (`product_templates.zusatz.historie = 'artikel'`, inaktiv, nicht verkäuflich); Positionen ohne SKU (Gutschein, Trinkgeld) laufen auf einen Sammelartikel, der Text bleibt an der Position. Kein Klärfall, kein Dashboard-Alarm.
- „Betriebsdaten löschen" löscht auch die Historie.

*Vergleich: Sendcloud hätte Shopify nur alle ~5 Minuten gepollt und nur ein 30-Tage-Fenster synchronisiert — unser Webhook+Reconciliation-Ansatz ist schneller und lückenlos.*

## Shopify — Versand-Rückmeldung (Fulfillment + Tracking)

Die Rückmeldung, die bei Sendcloud die Integration übernommen hätte, machen wir selbst — Details und Trigger im [Versand-Modul](versand.md):

- Nach **Validierung der Lieferung** (DHL-Label existiert): Outbox-Job `shopify_fulfillment_create` → `fulfillmentCreate` mit `trackingInfo { company: "DHL", number, url }` und `notifyCustomer: true` — die Order wird „fulfilled", **Shopify verschickt die Versandbestätigung an den Kunden**.
- Teillieferungen ⇒ Teil-Fulfillments über die Line-Item-Zuordnung.
- Korrekturen (Label neu erstellt) ⇒ `fulfillmentTrackingInfoUpdate`.
- Fehlerbilder (Out-of-Stock `nonFulfillableQuantity`, fehlende Location, Rate-Limits) ⇒ Retry mit Backoff, nach 10 Versuchen Fehler-Aktivität am Auftrag.
- Der frühere `ready-to-ship`-Tag entfällt als Trigger (war nur für Sendcloud nötig); optional konfigurierbarer Info-Tag, Default aus.

## Shopify — Bestandsabgleich (Inventar-Push)

Das ERP ist die Quelle der Wahrheit für Bestände; der Shop bekommt
`shopify_soll_menge()` (0100) gemeldet: für normale Artikel die frei
verfügbare Menge (`free_to_use`: Bestand minus Reservierungen an internen
Orten, abgerundet auf ganze Stücke), für **Made-to-Order** die baubare Menge
(Abschnitt darunter).

- **Push**: Outbox-Job `shopify_inventory_push`, angestoßen über
  `inventar_abgleich_anstossen()` — **nach jeder importierten
  Shopify-Bestellung (auch Storno) sofort** (der Webhook arbeitet den Job
  direkt nach der Antwort ab: Sekunden), **jede Minute** im Job-Cron
  (Änderungen in KRNL: Wareneingang, Inventur, Fertigmeldung — beides nur im
  Modus „schreiben"), viertelstündlich vom Reconcile-Cron, von Hand über die
  Monitor-Karte und bei Abweichung. Der Dedupe-Schlüssel `inventar-abgleich`
  bündelt beliebig viele Auslöser. Übertragen wird nur, was sich seit der
  letzten Meldung geändert hat (`shopify_inventory_state.pushed_qty`) — ein
  leerer Durchlauf kostet keinen API-Aufruf.
- **Ein Abgleich zur Zeit, nichts geht verloren**: Sperre mit Ablauf
  (`shopify_sync_state.inventar_sperre`, 90 s). Läuft ein Abgleich, verpufft
  ein neues Einreihen (Schlüssel belegt) — darum zählt jeder Anstoß einen
  Zähler hoch (`inventar_anstoss`), und der laufende Abgleich rechnet eine
  weitere Runde, wenn sich der Zähler währenddessen bewegt hat (höchstens
  fünf). Wichtig bei Releases mit vielen Bestellungen in kurzer Zeit.
- **Mechanik**: `inventorySetQuantities` (name `available`, reason
  `correction`, `ignoreCompareQuantity: true` — das ERP hat recht), höchstens
  200 Mengen je Aufruf. Adressiert wird das InventoryItem der Variante; die
  Zuordnung wird einmal über `nodes(ids:…)` erfragt und an der Variante
  gespeichert (`shopify_inventory_item_gid`). Der Standort ist der erste
  aktive des Shops und wird in `shopify_sync_state` festgehalten.
- **Abweichungserkennung**: Webhook `inventory_levels/update` schreibt den
  Shop-Stand nach `shopify_inventory_state.shop_qty`; die Sicht
  `shopify_inventory_drift` zeigt Differenzen zur Soll-Menge auf der
  Monitor-Seite. **Asymmetrisch** (seit 0100): zeigt der Shop MEHR als das
  ERP hergibt, wird sofort korrigiert; zeigt er WENIGER, hat Shopify meist
  eine Bestellung abgezogen, die das ERP noch nicht importiert hat — dann
  wird nicht hochgesetzt (das überschriebe die Bestellung), sondern nur der
  Shop-Stand als gemeldet gemerkt; der nächste reguläre Abgleich setzt die
  richtige Menge.
- **Scopes**: zusätzlich `write_inventory` und `read_locations`;
  `write_products` für die Made-to-Order-Einrichtung.

### Made-to-Order (Tastaturen) — baubare Menge statt Bestand (0100)

Tastaturen werden auf Auftrag gefertigt (Route Fertigen + Auf Auftrag,
aktive Stückliste): ihr Lagerbestand ist immer 0, verkauft werden sie
trotzdem. Früher hatte Shopify für sie gar keinen Bestandsabgleich.

- **Rechnung** `baubar(variante)`: über die gefilterte Stückliste je Teil
  freier Bestand ÷ Menge je Stück, das Minimum ist die baubare Menge, das
  Teil der Engpass. Halbfabrikate mit eigener Stückliste zählen ihren
  freien Bestand plus das daraus Baubare (bis Tiefe 3). Offene Aufträge sind
  eingerechnet: ihre Fertigungsaufträge reservieren die Teile.
- **Meldung** `shopify_soll_menge()` je Einstellung
  (`settings.shopify.mto`, Einstellungen → Schnittstellen, Karte
  „Made-to-Order an Shopify"): „baubar" (Standard) = baubare Menge + freier
  Bestand des Fertigprodukts − Puffer (Standard 2), höchstens Deckel (99);
  „fest" = der Deckel, solange mehr als der Puffer baubar ist, sonst 0.
  „baubar" ist sicherer: Shopify zieht bei jeder Bestellung selbst ab und
  stoppt bei 0, auch bevor KRNL neu gemeldet hat.
- **Geteilte Teile** (Clicky Blue in 36 Varianten): jede Variante zeigt die
  volle baubare Menge; nach jeder Bestellung sinken alle sofort (Anstoß),
  der Puffer fängt die Sekunden dazwischen ab — für Releases gern höher.
- **Einrichtung in Shopify**: beim ersten Abgleich stellt KRNL jede
  Made-to-Order-Variante auf „Menge verfolgen" und „nicht ohne Bestand
  verkaufen" (`productVariantsBulkUpdate`, `inventoryPolicy: DENY`,
  `inventoryItem.tracked`), gemerkt in
  `shopify_inventory_state.mto_eingerichtet_at`.
- **Vorschau** auf derselben Karte: Varianten, ausverkauft, knapp, Engpässe
  und je Variante baubar / Engpass / an Shopify / zuletzt gemeldet — auch im
  Modus „nur lesen", vor dem Scharfschalten.

## Shopify — Produkt-Sync (beide Richtungen, laufend)

- **ERP → Shop**: „In Shopify anlegen" am Produkt legt Produkt samt Varianten
  an (Attribute → Optionen, Preis = Listenpreis + Aufpreis, SKU/Barcode,
  Beschreibung) und verknüpft über die SKU. Danach überträgt jedes Speichern
  am verknüpften Produkt die Änderungen als Outbox-Job
  (`shopify_product_push`, Dedupe je Produkt) — Titel, Beschreibung, Preise,
  SKU, Barcode.
- **Shop → ERP**: Webhooks `products/create` und `products/update` gleichen
  sofort ab (`aktualisiereProduktAusShopify`): verknüpfte Produkte folgen dem
  Shop bei Titel, Preisen und Codes; neue Shop-Varianten werden per
  SKU/Barcode angekoppelt, Unzuordenbares steht als Klärfall am Produkt;
  unbekannte Produkte laufen durch Verknüpfen/Anlegen wie die Erstübernahme.
- **Erstübernahme**: Knopf auf dem Monitor holt den kompletten Shop-Katalog
  in Häppchen (verknüpfen per SKU/Barcode, sonst anlegen inkl. Attributen).
- **Eine SKU, ein Artikel — Bundles und Zweitangebote** (Entscheidungslog
  2026-09-29): Führen zwei Shop-Angebote dieselbe SKU (typisch: die
  Bestandteil-Liste eines Bundles aus Shopifys Bundles-App trägt die SKUs
  der eigentlichen Tastaturen), wird die SKU nur **einmal** Artikel. Das
  weitere Angebot ist ein *Zweitangebot*: seine Variante wird nicht angelegt
  bzw. am neuen Produkt archiviert, Bestellungen finden den Artikel über die
  SKU (`matchVariant`). Früher scheiterte daran das ganze Produkt am
  Eindeutigkeits-Index — samt seiner eindeutigen Varianten.
  - Die Erstübernahme läuft in **zwei Durchgängen**: erst eigenständige
    Produkte, dann Bundle-Bestandteile (`productParents` nicht leer). So
    gehört der Artikel dem normalen Produkt, nicht der Bundle-Liste.
  - **Bundles selbst** (`hasVariantsThatRequiresComponents`) werden nie
    angelegt: Shopify liefert in Bestellungen die Bestandteile als eigene
    Positionen (`LineItem.lineItemGroup`), das Bundle ist kein Lagerartikel.
  - Doppelte SKUs **innerhalb** eines Produkts: die erste Variante wird
    Artikel, die weitere archiviert. Varianten ohne SKU sind nie Duplikate.
  - Das Ergebnis (Monitor-Karte, Job-Protokoll) nennt Zweitangebote und
    Bundles; am angelegten Produkt steht ein Protokolleintrag mit den SKUs.
  - **Offen bis zum Schreibmodus:** Der Bestands-Push meldet nur an das
    verknüpfte Angebot, nicht an Zweitangebote (siehe
    [go-live.md](../go-live.md) §6).

## E-Mail (Einkauf)

Resend + React-Email-Vorlage „Bestellung": Betreff `Bestellung {number} — {Firmenname}`, Bestell-PDF als Anhang, Empfänger = Lieferanten-E-Mail, Reply-To = Einkaufs-Postfach. Versand als Outbox-Job (Retry bei Fehlern), Protokoll am Beleg. Ebenfalls über diesen Kanal: DHL-Retourenlabel-Mail an Kunden (siehe Versand-Modul).

## Einrichtung und Monitoring

**Einrichtung** steht unter Einstellungen → Schnittstellen
(`/einstellungen/anbindungen`, seit 2026-09-26): je Anbindung, welche
Umgebungsvariablen gesetzt sind (nur Namen, nie Werte), was der
Dienste-Wächter zuletzt gesehen hat, der Shopify-Modus lesen/schreiben, die
**Webhook-Registrierung** (Registry-Aktion `integrationen.webhooks_registrieren`,
nur https, im Lesemodus gesperrt) und die Einrichtungshinweise der App.

**Betrieb** zeigt der Ereignis-Monitor (`/integrationen`): letzte Webhooks
(Status, Fehler), offene/fehlgeschlagene Jobs mit Retry-Button, nicht
zugeordnete Shopify-Zeilen, letzter Reconciliation-Lauf, Bestandsabgleich,
Erstübernahme, Dienste-Wächter, DHL-Sendungsfehler. Die Kacheln Shopify und DHL
verlinken auf die Schnittstellen. Jeder endgültig fehlgeschlagene Job und jede
unzugeordnete Shopify-Zeile zählt in den Header-Status („n Vorgänge brauchen
Aufmerksamkeit") und ins Navigations-Badge.

### Telegram-Benachrichtigungen (seit 0084)

Ein Telegram-Bot des Betreibers bekommt Push-Nachrichten — der einzige Kanal
nach außen. Zugangsdaten als Umgebungsvariablen `TELEGRAM_BOT_TOKEN` und
`TELEGRAM_CHAT_ID` (Chat-ID über Einstellungen → Benachrichtigungen →
„Chat-IDs ermitteln", nachdem man dem Bot einmal geschrieben hat);
`TELEGRAM_FAKE=1` sendet nichts und meldet Erfolg (Tests, lokal).

| Ereignis | Schlüssel | Wann |
|---|---|---|
| Anmeldung (Name, Rolle, Zeit, IP, Browser · System, Methode) | `login:<sitzung>` | sofort nach der Anmeldung (`after()`), spätestens mit dem nächsten Cron |
| Fehlversuche je Konto (Passwort oder Code falsch) | `fehlversuch:<konto>:<Viertelstunde>` | gebündelt: zwei Minuten nach dem letzten Versuch, eine Nachricht je Konto und Viertelstunde mit Endstand |
| Kontosperre (Drossel erreicht) | `sperre:<konto>:<Viertelstunde>` | sofort |
| Job endgültig fehlgeschlagen | `job:<id>:<versuch>` | mit dem Cron `jobs`, genau einmal je Versuchszähler |
| Dienststörung / Entstörung | `dienst:<name>:<zustand>:<seit>` | Dienste-Wächter (0085) |

Die Meldungen liegen in der Outbox `benachrichtigungen` (Status offen /
gesendet / übersprungen / fehlgeschlagen, 30 Tage, KI-Sperrliste); der Cron
`jobs` sendet jede Minute, Sendefehler wiederholen mit Backoff bis fünf
Versuche. Schalter je Ereignisart unter Einstellungen → Benachrichtigungen
gelten beim Senden. Jeder Versand steht im Transaktionslog (System
`telegram`). Testnachricht: Knopf auf derselben Karte.

### Dienste-Wächter (seit 0085)

Der Cron `wache` (alle fünf Minuten, `/api/cron?task=wache`) prüft jeden
konfigurierten Dienst aktiv — DHL (Token), Shopify (`{ shop { name } }`,
läuft auch im Lesemodus), Resend, Anthropic, OpenAI, Telegram (`getMe`),
Druckbrücke (Agent-Heartbeat jünger als 15 Minuten) — parallel mit 8 s
Zeitlimit und hält den Zustand in `dienst_status`. **Gestört** gilt ein
Dienst ab dem zweiten Fehlschlag in Folge (ein Aussetzer flattert nicht),
**erreichbar** wieder beim ersten Erfolg; beides geht genau einmal als
Telegram-Meldung hinaus (Schlüssel `dienst:<name>:gestoert|ok:<seit>`),
die Entstörung mit Dauer. Nicht konfigurierte Dienste stehen als „nicht
konfiguriert" und melden nie.

Sichtbar: Header-Status („Störung: DHL, …" vor jeder Zählerei) und die Karte
„Dienste" auf dieser Seite mit „Jetzt prüfen". Fällt die Datenbank selbst
aus, sendet der Cron direkt an Telegram — höchstens viermal je Stunde.
Kosten: DHL-Token und Shopify-Abfrage stehen je Lauf im Transaktionslog.

## Abnahmekriterien

1. Webhook mit gültiger HMAC wird gespeichert und verarbeitet; ungültige Signatur ⇒ 401, kein Event; Duplikat (gleiche Webhook-Id) ⇒ genau ein Auftrag.
2. Bezahlte Shopify-Order mit 1 Tastatur-Variante ⇒ Auftrag in `sale`, Lieferung + MO existieren, Kunde angelegt/aktualisiert, Adresse mit getrennter Hausnummer.
3. Order mit unbekannter SKU ⇒ Eintrag in `shopify_unmatched_lines`, sichtbar in der Monitoring-UI; nach manueller Zuordnung läuft der Import durch und die Zuordnung ist dauerhaft gespeichert.
4. Reconciliation legt eine Order an, deren Webhook absichtlich verworfen wurde.
5. `orders/cancelled` storniert den Auftrag samt offener Lieferung und nicht manifestierter DHL-Sendung.
6. (Fulfillment-Rückmeldung: siehe Abnahmekriterien im Versand-Modul.)
