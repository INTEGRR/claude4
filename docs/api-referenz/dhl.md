# DHL-Direktanbindung — Integrations-Referenz

Stand: 2026-08-05. Recherchiert auf developer.dhl.com (Quell-URLs am Ende).

## 1. Die richtige API: **Parcel DE Shipping API v2** (Post & Parcel Germany)

REST-Nachfolger des alten SOAP-„Geschäftskundenversands" (die Alt-Schnittstellen laufen zum **31.05.2026** aus; entwickler.dhl.de ist in developer.dhl.com aufgegangen).

- **Aktuelle Version:** v2.1.14 (Stand Mai 2026)
- **Base-URLs:**
  - Sandbox: `https://api-sandbox.dhl.com/parcel/de/shipping/v2/`
  - Produktion: `https://api-eu.dhl.com/parcel/de/shipping/v2/`
- **Voraussetzungen:**
  - **DHL-Geschäftskundenvertrag** + Zugang zum **Geschäftskundenportal (GKP)**
  - **EKP-Nummer** (10-stellige Kundennummer)
  - **Abrechnungsnummern (billingNumber)**: 14-stellig = EKP (10) + Verfahren (2) + Teilnahme (2), z. B. EKP + `01` + `01` für V01PAK
  - **API-Key (+ Secret)** aus einer App im DHL Developer Portal („My Apps")
  - Im GKP angelegter **Systembenutzer** (Passwort 365 Tage gültig) — empfohlen statt persönlichem User (90 Tage)
- **Auth:**
  - **OAuth2 (ROPC, empfohlen):** Token-Endpoint `…/parcel/de/account/auth/ropc/v1/token`, `grant_type=password`, `username`/`password` = GKP-Systemuser, `client_id`/`client_secret` = API-Key/Secret
  - Legacy Basic Auth + `dhl-api-key`-Header ist **deprecated** — direkt mit OAuth2 bauen.

## 2. Label erstellen

- **Endpoint:** `POST /orders` (Array `shipments[]`, Bulk möglich; `?validate=true` für reine Validierung)
- **Wichtigste Request-Felder pro Sendung:**
  - `product`: **V01PAK** (DHL Paket national), **V62KP** (DHL Kleinpaket — Warenpost-Nachfolger seit 01/2025, max. 35,5 × 25 × 8 cm und 1 kg; der alte Code V62WP wird seit 31.05.2026 nicht mehr umgeschrieben), **V54EPAK** (Europaket, EU), **V53WPAK** (Paket International, mit Zolldaten), **V66WPI** (Kleinpaket international), **V07PAK** (Retoure)
  - `billingNumber` (muss zum Produkt passen), optional `refNo` (Kundenreferenz — z. B. unsere Auftragsnummer)
  - `shipper` (oder `shipperRef` auf im GKP hinterlegte Absenderadresse) und `consignee`: `name1..3`, `addressStreet`, `addressHouse`, `postalCode`, `city`, `country` (**ISO-3166-1 alpha-3**, z. B. `DEU` — Pflicht seit v2.1.13), `email`/`phone`; Packstation über `lockerID` + Postnummer
  - `details.weight` (Pflicht), `details.dim` (optional, dann vollständig)
  - `services`: Transportversicherung, IdentCheck, Preferred-Services, GoGreen Plus, Signatur … (nicht jede Kombination je Produkt erlaubt)
  - Label-Steuerung: `docFormat` (**PDF** oder **ZPL2**), `printFormat` (Formate s. u.)
- **Response:** pro Sendung `shipmentNumber` (= Trackingnummer), `label` (Base64 bzw. `labelUrl`), ggf. `returnShipmentNumber`, `routingCode`, `status`/`warnings` (**Teilerfolge im Batch möglich** — einzelne Sendungen können fehlschlagen)
- **Weitere Endpoints:** `GET /orders` (Label nachladen, bis 3 Tage nach Manifestierung), **Storno** `DELETE /orders?shipment={shipmentNumber}` — nur **vor** Manifestierung; `POST /manifests` (Tagesabschluss, sonst automatisch ~17:45 Uhr), `GET /manifests` (Versandliste)
- **Sandbox:** Test-User `user-valid`, dokumentierte Test-Abrechnungsnummern; Sandbox-Accounts sind **geteilt**, Labels sind Muster.

## 3. Tracking

**a) Shipment Tracking – Unified API** (einfach, konzernweit):
- `GET https://api-eu.dhl.com/track/shipments?trackingNumber=…&service=parcel-de&requesterCountryCode=DE&language=de`
- Auth: nur Header `DHL-API-Key` (separate Freischaltung der API im Portal nötig)
- Response: `shipments[]` mit `status` und `events[]`; normalisierter `status.statusCode` ∈ **`pre-transit` | `transit` | `delivered` | `failure` | `unknown`** (plus Parcel-DE-Rohcodes, z. B. „ZU" = zugestellt)
- **Rate Limit initial: 250 Calls/Tag, max. 1 Call/5 s** — für Produktion Upgrade beantragen. Trackingdaten müssen 30 Tage nach Zustellung gelöscht werden (Vertragsauflage).
- **Push statt Polling:** „Shipment Tracking – Unified **Push** API" (Webhooks je Sendungsnummer; Zugang per Antrag; Endpoint braucht SSL + HTTP 200 < 5 s; Retry nach 1 h/6 h, dann Deaktivierung).

**b) Parcel DE Shipment Tracking API** (Geschäftskunden-Variante, volle Daten):
- `GET https://api-eu.dhl.com/parcel/de/tracking/v0/shipments`; Auth: `DHL-API-Key` + GKP-User; bis 20 Sendungsnummern je Call, inkl. POD-Unterschrift
- Limits: 1.000 Abfragen und 10.000 Sendungen/Tag, 3 Requests/s

## 4. Retouren: **Parcel DE Returns API**

- v1.0.9; Base-URL `https://api-eu.dhl.com/parcel/de/shipping/returns/v1/` (+ Sandbox analog); Auth wie Shipping (OAuth2)
- **Endpoint:** `POST /orders?labelType=SHIPMENT_LABEL|QR_LABEL|BOTH`; `GET /locations` listet konfigurierte Retourenempfänger
- **Pflichtfelder:** `receiverId` (z. B. `deu`), `shipper` = Adresse des Endkunden; international ggf. `customsDetails`
- **Voraussetzungen:** Retouren-Vertrag + Freischaltung im GKP; Retourenempfänger mit Retouren-Abrechnungsnummer (Verfahren 07) im GKP angelegt
- **Response:** `shipmentNo`, `label.b64` (PDF), `qrLabel.b64` (PNG, national), `qrLink`; Labelerzeugung kostenlos, berechnet wird nur die eingelieferte Retoure. Alternativ Retourenlabel direkt beim Hinversand mitbestellen (Service „dhlRetoure").

## 5. Rahmenbedingungen & Fallstricke

- **Label-/Druckformate (`printFormat`):** A4, **910-300-700** (105×208), 910-300-710, 910-300-600/610 (Thermo 103×199), 910-300-400/410 (Thermo 103×150) u. a.; Thermo 203 dpi; ZPL2 zusätzlich zu PDF.
- **Leitcodierung/Adressen:** API prüft nur „weich" (Warnings). Nicht leitcodierbare Adressen ⇒ Nachcodierungs-Entgelt. Empfehlung: Straße/Hausnummer getrennt führen, Warnings aus der Response im ERP anzeigen.
- **Lifecycle:** Storno nur bis Manifest; Label-URLs ~48 h gültig, `GET /orders` bis 3 Tage nach Manifest — **Label-PDF im ERP persistieren** (Supabase Storage).
- **Rate Limits Shipping:** Fair-Use (Batch nutzen); Unified-Tracking-Default (250/Tag) reicht nicht für Produktion — Upgrade früh beantragen oder Push API.
- **Kosten/Vertrag:** API kostenlos; abgerechnet werden Sendungen laut Geschäftskundenvertrag. Beförderungsvertrag entsteht erst mit physischer Übergabe. Versand nur ab Deutschland.
- **Status/Monitoring:** https://post-paket-deutschland.status.api.dhl.com/, Support: https://support-developer.dhl.com/. OpenAPI-Spec + Postman-Collection im Portal.

## Quellen

- https://developer.dhl.com/api-reference/parcel-de-shipping-post-parcel-germany-v2
- https://developer.dhl.com/api-reference/parcel-de-returns-post-parcel-germany
- https://developer.dhl.com/api-reference/shipment-tracking
- https://developer.dhl.com/api-reference/dhl-parcel-de-shipment-tracking-post-parcel-germany
- https://developer.dhl.com/api-reference/shipment-tracking-unified-push
- https://support-developer.dhl.com/support/solutions/articles/47001197243
