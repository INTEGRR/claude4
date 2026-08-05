# Modul Integrationen (Shopify, Sendcloud, E-Mail)

API-Referenz: [docs/odoo-referenz/shopify-sendcloud.md](../odoo-referenz/shopify-sendcloud.md)

## Shopify — Order-Import

**Setup (einmalig, manuell):** Custom App im Shopify Dev Dashboard mit Scopes `read_orders`, `write_orders`; Admin-API-Token (`shpat_…`) + Webhook-Secret als Env-Vars. Webhook-Subscriptions per `webhookSubscriptionCreate` auf: `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled` → `https://<app>/api/webhooks/shopify`.

**Empfang (Route Handler):**
1. Raw Body lesen, HMAC (`X-Shopify-Hmac-Sha256`, Schlüssel = Client Secret) timing-sicher prüfen; Mismatch ⇒ 401.
2. Event in `shopify_webhook_events` speichern — idempotent über `X-Shopify-Webhook-Id` (Duplikat ⇒ 200, skip).
3. Sofort **200** antworten (Shopify-Timeout: 5 s); Verarbeitung asynchron.

**Verarbeitung (Job-Runner, Vercel Cron im Minutentakt):**
- `orders/create` / `orders/paid`:
  1. Kunde per `shopify_customer_id` upserten (Name, E-Mail, Lieferadresse).
  2. Positionen mappen: Shopify-`sku` bzw. `variant_id` → `product_variants` (Felder `sku`, `shopify_variant_id`). **Kein Treffer ⇒ Zeile in `shopify_unmatched_lines`**, Order wird mit Hinweis-Status angelegt, manuelle Zuordnung in der UI (lernt: Mapping wird an der Variante gespeichert).
  3. Verkaufsauftrag anlegen (`source = 'shopify'`, `shopify_order_id` unique ⇒ Upsert statt Duplikat). Bezahlte Order (`financial_status = paid`) ⇒ direkt `confirm_sales_order` (Status `sale`, Lieferung + Fertigungsaufträge entstehen automatisch).
- `orders/cancelled`: zugehörigen Auftrag stornieren (Regeln des Verkaufsmoduls).
- `orders/updated`: Adress-/Tag-Änderungen nachziehen; Mengenänderungen nur solange kein MO `done` ist, sonst Warn-Aktivität.

**Reconciliation (Sicherheitsnetz, Cron alle 15 min):** GraphQL `orders(query: "updated_at:>{last_sync}")` paginiert abholen und mit `shopify_order_id` abgleichen — fängt verlorene Webhooks ab (Shopify garantiert keine Zustellung). `last_reconciliation_at` in `shopify_sync_state`.

## Shopify — „ready-to-ship"-Tag (Versandfreigabe)

Auslöser: **alle** Fertigungsaufträge eines Shopify-Verkaufsauftrags sind `done` (bzw. bei Aufträgen ohne Fertigung: Lieferung `assigned`/reserviert). Dann:

1. Outbox-Job `shopify_tag_add` mit `{ order_gid, tags: ["ready-to-ship"] }`.
2. Job-Runner ruft GraphQL-Mutation **`tagsAdd`** auf (additiv — überschreibt keine bestehenden Tags; `orderUpdate` würde die Tag-Liste ersetzen, daher nicht verwenden).
3. Erfolg ⇒ Tag in `sales_orders.shopify_tags_pushed` vermerken; Fehler ⇒ Retry mit Backoff (max. 10 Versuche, dann Fehler-Aktivität am Auftrag).

Der Tag-Name ist konfigurierbar (Einstellung), Default `ready-to-ship`.

## Sendcloud

**Erster Ausbau — Variante A (empfohlen):** Sendclouds eigene Shopify-Integration zieht die Orders direkt aus Shopify; eine Sendcloud-Versandregel filtert auf den Tag `ready-to-ship`. Unser System redet **nicht direkt** mit Sendcloud — es setzt nur den Tag. Sendcloud erstellt Label + Fulfillment + Tracking-Rückmeldung an Shopify selbst. Null Eigenentwicklung, voller Effekt.

**Erweiterung — Variante B (direkte API v3):** falls später eigenes Label-Handling gewünscht (z. B. ZPL-Direktdruck): `POST /api/v3/shipments/announce` (Basic Auth Public/Secret Key, Idempotenz über `external_reference_id`), Label-PDF via `GET /api/v3/parcels/{id}/documents/label`, Status-Webhook `parcel_status_changed`. Die Outbox-Infrastruktur trägt das ohne Umbau. **Wichtig:** v2 Parcels API ist Legacy — nur v3 verwenden.

## E-Mail (Einkauf)

Resend + React-Email-Vorlage „Bestellung": Betreff `Bestellung {number} — {Firmenname}`, Bestell-PDF als Anhang, Empfänger = Lieferanten-E-Mail, Reply-To = Einkaufs-Postfach. Versand als Outbox-Job (Retry bei Fehlern), Protokoll am Beleg.

## Monitoring

Admin-Seite „Integrationen": letzte Webhooks (Status, Fehler), offene/fehlgeschlagene Jobs mit Retry-Button, nicht zugeordnete Shopify-Zeilen, letzter Reconciliation-Lauf. Fehlgeschlagene Jobs > 1 h alt ⇒ Hinweis-Banner im ERP.

## Abnahmekriterien

1. Webhook mit gültiger HMAC wird gespeichert und verarbeitet; ungültige Signatur ⇒ 401, kein Event; Duplikat (gleiche Webhook-Id) ⇒ genau ein Auftrag.
2. Bezahlte Shopify-Order mit 1 Tastatur-Variante ⇒ Auftrag in `sale`, Lieferung + MO existieren, Kunde angelegt/aktualisiert.
3. Order mit unbekannter SKU ⇒ Eintrag in `shopify_unmatched_lines`, sichtbar in der Monitoring-UI; nach manueller Zuordnung läuft der Import durch und die Zuordnung ist dauerhaft gespeichert.
4. Nach Abschluss aller MOs erhält die Shopify-Order den Tag `ready-to-ship` (verifizierbar via API); bestehende Tags bleiben erhalten.
5. Reconciliation legt eine Order an, deren Webhook absichtlich verworfen wurde.
6. `orders/cancelled` storniert den Auftrag samt offener Lieferung.
