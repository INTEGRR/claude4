# Modul Verkauf

Referenzverhalten: [docs/odoo-referenz/verkauf.md](../odoo-referenz/verkauf.md)

## Zweck

Verkaufsaufträge verwalten — bei uns entstehen sie fast ausschließlich **automatisch aus Shopify** (bereits bezahlt, direkt im Status „Verkaufsauftrag"). Manuelles Anlegen muss trotzdem möglich sein (B2B, Sonderfälle).

## Status-Maschine (`sales_orders.state`)

```
draft ──(Per E-Mail senden)──▶ sent
draft/sent ──(Bestätigen)──▶ sale ──(Stornieren)──▶ cancel
cancel/sent ──(Auf Angebot zurücksetzen)──▶ draft
sale: Sperren/Entsperren über Flag `locked` (kein eigener Status — Odoo-18-Verhalten)
```

- **Bestätigen** (`confirm_sales_order`):
  1. Nummer aus Sequenz (falls noch keine), Status → `sale`.
  2. **Lieferauftrag anlegen**: ein Picking (Vorgangsart Warenausgang, `WH/Stock → Partner/Kunden`) mit einem Move je lagergeführter Position; Status `confirmed`, Reservierung gemäß Vorgangsart.
  3. **Fertigung anlegen (MTO)**: für jede Position, deren Produkt `route_manufacture + route_mto` hat und eine aktive Stückliste besitzt → ein Fertigungsauftrag je Position (Variante, Menge, `sales_order_id` als Quellbeleg), Status direkt `confirmed`. Odoo-Verhalten: MTO beschafft auch bei vorhandenem Bestand.
  4. Produkte ohne Fertigungsroute werden nur über den Lieferauftrag bedient (ab Lager).
- **Stornieren**: offene, nicht erledigte Lieferungen des Auftrags → `cancel`. Verknüpfte MOs werden **nicht** automatisch storniert, sondern bekommen einen Warnhinweis (Aktivität/Notiz) — bewusst Odoo-Verhalten, Entscheidung liegt beim Fertiger.
- **Sperren**: `locked = true` → Beleg schreibgeschützt (UI + DB-Check in Update-Funktionen).

## Auftragspositionen

Produkt-Auswahl auf **Varianten-Ebene** (Suche über SKU/Name inkl. Attributwerte). Felder: Variante, Beschreibung, Menge, Maßeinheit, Einzelpreis, Rabatt %, Steuersatz, berechnete Spalten **Geliefert** und **Abgerechnet**. Strukturzeilen `section`/`note` für Gliederung.

## Berechnete Status

- **Lieferstatus** (`delivery_status`): `pending` → `partial` → `full`, abgeleitet aus den Pickings (siehe Datenmodell). Anzeige als Badge in Liste + Formular.
- **Abrechnungsstatus** (`invoice_status`): `no` / `to_invoice` / `invoiced` gemäß Abrechnungspolitik des Produkts (Standard: nach bestellter Menge). Kundenrechnungen selbst sind im ersten Ausbau **nicht** enthalten (Shopify rechnet ab); das Feld hält den Weg frei.

## Shopify-Aufträge (siehe auch Modul Integrationen)

- `source = 'shopify'`, `shopify_order_id`/`shopify_order_name` gesetzt, Kunde per `shopify_customer_id`-Upsert.
- Bezahlte Shopify-Orders entstehen direkt in `sale` (Bestätigungslogik läuft identisch durch — Lieferung + MOs).
- Auf dem Formular: Link zur Order im Shopify-Admin, Anzeige der gesetzten Tags, Fulfillment-/Zahlungsstatus aus Shopify (read-only Info).
- Stornierte Shopify-Orders (`orders/cancelled`-Webhook) stornieren den Verkaufsauftrag nach denselben Regeln.

## UI

- **Liste**: Nummer, Shopify-Name, Kunde, Datum, Status-Badges (Status/Liefer-/Abrechnungsstatus), Summe; Filter nach Status/Quelle; Volltextsuche.
- **Formular**: Kopf (Kunde, Datum, Quelle), Positionstabelle, Buttons je Status (Bestätigen, Per E-Mail senden, Stornieren, Sperren), Smart-Buttons **Lieferungen (n)** und **Fertigungsaufträge (n)** mit Verknüpfung, Aktivitäten-/Notiz-Verlauf (einfacher Chatter: Statuswechsel + Notizen protokolliert in `audit_log`).

## Abnahmekriterien

1. Manuell angelegter Auftrag mit Tastatur-Variante (route_manufacture+mto): Bestätigen erzeugt genau 1 Lieferung + 1 MO mit korrekt gefilterten BoM-Komponenten; beide per Smart-Button erreichbar; MO trägt den Auftrag als Quelle.
2. Auftrag mit Lagerprodukt ohne Fertigungsroute: nur Lieferung, kein MO.
3. Stornieren storniert die offene Lieferung, MO bleibt mit Warnhinweis bestehen.
4. Gesperrter Auftrag lässt sich weder in UI noch per API ändern, bis entsperrt.
5. Validierte Teillieferung setzt `qty_delivered` der Positionen und `delivery_status = partial`.
