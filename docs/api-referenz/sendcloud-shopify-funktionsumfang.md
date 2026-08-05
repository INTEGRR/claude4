# Sendcloud ↔ Shopify: Funktionsumfang (Vorlage für unseren Nachbau)

Sendcloud wird **nicht** eingesetzt — dieses Dokument beschreibt, was die Sendcloud-Shopify-Integration leistet, damit klar ist, welche Funktionen unser eigenes Versandmodul (DHL-Direktanbindung) übernehmen muss. Stand: 2026-08-05.

## 1. Order-Sync Shopify → Sendcloud

- **Mechanik: Polling, keine Webhooks.** Abruf ca. alle 4–5 Minuten (inaktive Accounts: ~90 Minuten), kein manuelles Force-Sync.
- **Import-Fenster: 30 Tage.** Nur Orders der letzten 30 Tage; auch Updates (z. B. Adressänderungen) werden nur innerhalb dieses Fensters nachgezogen.
- Für Shopify keine konfigurierbaren Status-Importfilter; importiert wird der offene/unfulfillte Bestand. Payment-Status, Shop-Status und Order-Tags werden mitimportiert und sind als Filter/in Versandregeln nutzbar.
- **Importierte Felder:** Gewicht, SKU, EAN, Checkout-Delivery-Methode, Multicollo-Menge, COD, Parcel Items, HS-Codes, Ursprungsland, Order-Gesamtwert, Währung, Order-Kommentar, Produktbild, Order-Tags, Servicepunkt-Auswahl.

→ **Unser Nachbau ist hier besser:** Webhooks (`orders/create`, `orders/updated`, `orders/cancelled`) + Reconciliation statt 5-Minuten-Polling und 30-Tage-Fenster.

## 2. Status-Rückmeldung Sendcloud → Shopify (der Kern, den wir nachbauen)

- **Trigger:** bei **Label-Erstellung** (bzw. Carrier-Erstscan) wird der Order-Status im Shop aktualisiert.
- **Was geschrieben wird:** ein **Fulfillment** auf der Shopify-Order mit **Tracking-Nummer + Tracking-Link**; die Order wird dadurch „fulfilled". **Teil-Fulfillments** werden unterstützt.
- **Kundenmail:** Das Fulfillment löst Shopifys Versandbestätigung aus (`notifyCustomer`); Sendclouds eigene Tracking-Mails sind ein separater, abschaltbarer Kanal. Für den Nachbau entscheiden: Shopify schickt die Mail (`notifyCustomer: true`) — empfohlen, null Aufwand.
- **Bekannte Fehlerbilder, die wir abfangen müssen:** Shopify-Rate-Limits (Retry mit Backoff), Out-of-Stock (`nonFulfillableQuantity > 0` blockiert Fulfillment), Produkte ohne Location (422), Multi-Location-Setups.

## 3. Genutzte Shopify-APIs/Scopes (abgeleitet)

- Orders lesen/schreiben (Line Items, Tags, Status), `read_inventory`/`write_inventory` (HS-Code/Ursprungsland am InventoryItem)
- **Fulfillments schreiben** über das FulfillmentOrder-Modell (`write_merchant_managed_fulfillment_orders` u. ä.)
- Returns-API (Return-Status-Sync), Locations lesen, Produkte lesen
- CarrierService/Checkout-Extensions (Servicepunkte) — **für uns nicht relevant**

## 4. Weitere Funktionen (Relevanz für uns bewertet)

| Funktion | Sendcloud | Für unseren Nachbau |
|---|---|---|
| Retouren-Sync (Return requested/created/completed → Shopify Return-Objekte, Tags, Notes) | ✅ | Später (Erweiterung); zunächst DHL-Retourenlabel aus dem Reparatur-/Retourenprozess ohne Shopify-Return-Sync |
| Servicepunkte im Checkout | ✅ | Nicht benötigt |
| Multicollo (mehrere Pakete/Tracking-Nummern je Order) | ✅ | Datenmodell sieht es vor (`shipments` 1:n zur Lieferung); UI später |
| Zolldokumente aus HS-Code/Ursprungsland | ✅ | Später (nur bei Nicht-EU-Versand nötig) |
| Versandregeln (Regelwerk Carrier/Produktwahl) | ✅ | Vereinfacht: DHL-Produkt + Abrechnungsnummer je Sendung wählbar, Default per Einstellung |
| Stornierungen Shopify → Versand | teilweise (Update-Sync) | Webhook `orders/cancelled` storniert Auftrag; nicht manifestierte DHL-Labels werden storniert |
| External Parcel Tracking, Branded-Tracking-Mails | ✅ | Nicht benötigt (Shopify-Mail reicht) |

## 5. Shopify-Fulfillment-Modell — was unsere Eigenentwicklung aufrufen muss

- **Modell:** Order → 1..n **FulfillmentOrder** (Line Items je Location, mit `supportedActions` und `remainingQuantity`) → 1..n **Fulfillment**. Apps fulfillen nie die Order direkt, sondern immer FulfillmentOrders.
- **Ablauf „Label erstellt → Tracking in Shopify + Kundenmail":**
  1. `order { fulfillmentOrders { ... } }` abfragen (`supportedActions` enthält `CREATE_FULFILLMENT`?)
  2. **`fulfillmentCreate`** mit `lineItemsByFulfillmentOrder` (ohne Line-Item-Angabe = Voll-Fulfillment), `trackingInfo { company: "DHL", number, url }`, `notifyCustomer: true` (Default ist false!). Bekannte `company`-Werte wie „DHL" erzeugen automatisch Tracking-URLs.
  3. Korrekturen: **`fulfillmentTrackingInfoUpdate`** (`fulfillmentId`, neue Nummern/URLs, `notifyCustomer`).
- **Scopes:** `write_merchant_managed_fulfillment_orders` (+ ggf. `write_assigned_fulfillment_orders`), `fulfill_and_ship_orders`-Permission.
- **Abzufangen:** `nonFulfillableQuantity > 0`, fehlende Location-Zuordnung, Rate-Limits (Retry-Queue mit Backoff — haben wir mit der Outbox ohnehin).

## Quellen

Sendcloud Help Center:
- https://support.sendcloud.com/hc/en-us/articles/360024966852-Shopify-Integration
- https://support.sendcloud.com/hc/en-us/articles/42668871960849-Shopify-functionalities-overview
- https://support.sendcloud.com/hc/en-us/articles/360046201532-Shopify-troubleshooter
- https://support.sendcloud.com/hc/en-us/articles/32390272169745-Returns-feedback-Shopify
- https://support.sendcloud.com/hc/en-us/articles/48586022354577-How-orders-are-imported-into-Sendcloud
- https://support.sendcloud.com/hc/en-us/articles/360025263691-Process-your-orders
- https://support.sendcloud.com/hc/en-us/articles/360026047191-FAQ-Label-creation

Shopify:
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentTrackingInfoUpdate
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentInput
- https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/build-fulfillment-solutions
