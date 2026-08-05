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

## Sendungen (`shipments`)

Eine Lieferung kann 1..n Sendungen haben (Multicollo-Erweiterung vorgesehen; erster Ausbau: 1 Paket je Lieferung).

Felder: Lieferung (`picking_id`), Verkaufsauftrag, DHL-Produkt (`V01PAK` national, `V54EPAK` Europaket, `V53WPAK` Kleinpaket), `billing_number`, Gewicht (aus Produktgewichten summiert, editierbar), `shipment_number` (= Trackingnummer), `tracking_url`, Label-Pfad (Storage), Status, `shopify_fulfillment_id`, Fehlerinfo.

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
