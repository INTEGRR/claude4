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
  1. Kunde per `shopify_customer_id` upserten (Name, E-Mail, Lieferadresse — **Straße/Hausnummer beim Import trennen**, DHL braucht sie getrennt).
  2. Positionen mappen: Shopify-`sku` bzw. `variant_id` → `product_variants` (Felder `sku`, `shopify_variant_id`). **Kein Treffer ⇒ Zeile in `shopify_unmatched_lines`**, Order wird mit Hinweis-Status angelegt, manuelle Zuordnung in der UI (lernt: Mapping wird an der Variante gespeichert).
  3. Verkaufsauftrag anlegen (`source = 'shopify'`, `shopify_order_id` unique ⇒ Upsert statt Duplikat). Bezahlte Order (`financial_status = paid`) ⇒ direkt `confirm_sales_order` (Status `sale`, Lieferung + Fertigungsaufträge entstehen automatisch).
- `orders/cancelled`: zugehörigen Auftrag stornieren (Regeln des Verkaufsmoduls); nicht manifestierte DHL-Sendungen der Lieferung werden storniert (siehe Versand-Modul).
- `orders/updated`: Adress-/Tag-Änderungen nachziehen; Mengenänderungen nur solange kein MO `done` und kein Label erstellt ist, sonst Warn-Aktivität.

**Reconciliation (Sicherheitsnetz, Cron alle 15 min):** GraphQL `orders(query: "updated_at:>{last_sync}")` paginiert abholen und mit `shopify_order_id` abgleichen — fängt verlorene Webhooks ab (Shopify garantiert keine Zustellung). `last_reconciliation_at` in `shopify_sync_state`.

*Vergleich: Sendcloud hätte Shopify nur alle ~5 Minuten gepollt und nur ein 30-Tage-Fenster synchronisiert — unser Webhook+Reconciliation-Ansatz ist schneller und lückenlos.*

## Shopify — Versand-Rückmeldung (Fulfillment + Tracking)

Die Rückmeldung, die bei Sendcloud die Integration übernommen hätte, machen wir selbst — Details und Trigger im [Versand-Modul](versand.md):

- Nach **Validierung der Lieferung** (DHL-Label existiert): Outbox-Job `shopify_fulfillment_create` → `fulfillmentCreate` mit `trackingInfo { company: "DHL", number, url }` und `notifyCustomer: true` — die Order wird „fulfilled", **Shopify verschickt die Versandbestätigung an den Kunden**.
- Teillieferungen ⇒ Teil-Fulfillments über die Line-Item-Zuordnung.
- Korrekturen (Label neu erstellt) ⇒ `fulfillmentTrackingInfoUpdate`.
- Fehlerbilder (Out-of-Stock `nonFulfillableQuantity`, fehlende Location, Rate-Limits) ⇒ Retry mit Backoff, nach 10 Versuchen Fehler-Aktivität am Auftrag.
- Der frühere `ready-to-ship`-Tag entfällt als Trigger (war nur für Sendcloud nötig); optional konfigurierbarer Info-Tag, Default aus.

## Shopify — Bestandsabgleich (Inventar-Push)

Das ERP ist die Quelle der Wahrheit für Bestände; der Shop bekommt die frei
verfügbare Menge (`free_to_use`: Bestand minus Reservierungen an internen
Orten, abgerundet auf ganze Stücke) gemeldet.

- **Push**: Outbox-Job `shopify_inventory_push`, angestoßen viertelstündlich
  vom Reconcile-Cron, von Hand über die Monitor-Karte, und automatisch bei
  erkannter Abweichung. Der Dedupe-Schlüssel `inventar-abgleich` bündelt
  beliebig viele Auslöser zu einem Durchlauf. Übertragen wird nur, was sich
  seit der letzten Meldung geändert hat (`shopify_inventory_state.pushed_qty`)
  — ein leerer Durchlauf kostet keinen API-Aufruf.
- **Mechanik**: `inventorySetQuantities` (name `available`, reason
  `correction`, `ignoreCompareQuantity: true` — das ERP hat recht), höchstens
  200 Mengen je Aufruf. Adressiert wird das InventoryItem der Variante; die
  Zuordnung wird einmal über `nodes(ids:…)` erfragt und an der Variante
  gespeichert (`shopify_inventory_item_gid`). Der Standort ist der erste
  aktive des Shops und wird in `shopify_sync_state` festgehalten.
- **Abweichungserkennung**: Webhook `inventory_levels/update` schreibt den
  Shop-Stand nach `shopify_inventory_state.shop_qty`. Weicht er vom ERP ab
  (Handkorrektur im Shopify-Admin), zeigt die Sicht
  `shopify_inventory_drift` die Differenz auf der Monitor-Seite, und ein
  korrigierender Push wird eingereiht.
- **Scopes**: zusätzlich `write_inventory` und `read_locations`.

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

## E-Mail (Einkauf)

Resend + React-Email-Vorlage „Bestellung": Betreff `Bestellung {number} — {Firmenname}`, Bestell-PDF als Anhang, Empfänger = Lieferanten-E-Mail, Reply-To = Einkaufs-Postfach. Versand als Outbox-Job (Retry bei Fehlern), Protokoll am Beleg. Ebenfalls über diesen Kanal: DHL-Retourenlabel-Mail an Kunden (siehe Versand-Modul).

## Monitoring

Admin-Seite „Integrationen": letzte Webhooks (Status, Fehler), offene/fehlgeschlagene Jobs mit Retry-Button, nicht zugeordnete Shopify-Zeilen, letzter Reconciliation-Lauf, DHL-Sendungsfehler/-Warnings. Jeder endgültig fehlgeschlagene Job und jede unzugeordnete Shopify-Zeile zählt in den Header-Status („n Vorgänge brauchen Aufmerksamkeit") und ins Navigations-Badge.

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
