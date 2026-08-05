# Modul Integrationen (Shopify, E-Mail)

API-Referenz: [docs/api-referenz/shopify.md](../api-referenz/shopify.md) · Versand/DHL: [docs/module/versand.md](versand.md)

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

## E-Mail (Einkauf)

Resend + React-Email-Vorlage „Bestellung": Betreff `Bestellung {number} — {Firmenname}`, Bestell-PDF als Anhang, Empfänger = Lieferanten-E-Mail, Reply-To = Einkaufs-Postfach. Versand als Outbox-Job (Retry bei Fehlern), Protokoll am Beleg. Ebenfalls über diesen Kanal: DHL-Retourenlabel-Mail an Kunden (siehe Versand-Modul).

## Monitoring

Admin-Seite „Integrationen": letzte Webhooks (Status, Fehler), offene/fehlgeschlagene Jobs mit Retry-Button, nicht zugeordnete Shopify-Zeilen, letzter Reconciliation-Lauf, DHL-Sendungsfehler/-Warnings. Fehlgeschlagene Jobs > 1 h alt ⇒ Hinweis-Banner im ERP.

## Abnahmekriterien

1. Webhook mit gültiger HMAC wird gespeichert und verarbeitet; ungültige Signatur ⇒ 401, kein Event; Duplikat (gleiche Webhook-Id) ⇒ genau ein Auftrag.
2. Bezahlte Shopify-Order mit 1 Tastatur-Variante ⇒ Auftrag in `sale`, Lieferung + MO existieren, Kunde angelegt/aktualisiert, Adresse mit getrennter Hausnummer.
3. Order mit unbekannter SKU ⇒ Eintrag in `shopify_unmatched_lines`, sichtbar in der Monitoring-UI; nach manueller Zuordnung läuft der Import durch und die Zuordnung ist dauerhaft gespeichert.
4. Reconciliation legt eine Order an, deren Webhook absichtlich verworfen wurde.
5. `orders/cancelled` storniert den Auftrag samt offener Lieferung und nicht manifestierter DHL-Sendung.
6. (Fulfillment-Rückmeldung: siehe Abnahmekriterien im Versand-Modul.)
