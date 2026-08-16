/**
 * Katalog der Outbox-Jobs — die asynchronen Prozessschritte („dienst").
 *
 * Die Handler selbst leben unverändert in src/modules/integrationen/jobs.ts;
 * hier stehen ihre Metadaten, damit Prozesse, Repository-Seite und Tests sie
 * adressieren können. `faehigkeit` benennt, WAS der Schritt leistet, nicht
 * WER es tut — Prozesse referenzieren die Fähigkeit, damit ein späterer
 * Anbieterwechsel (anderer Shop, anderer Paketdienst) die Prozessdefinitionen
 * nicht anfasst.
 */

export interface JobEintrag {
  label: string
  beschreibung: string
  /** Anbieterneutraler Zweck, z. B. 'shop:fulfillment_melden'. */
  faehigkeit: string
}

export const JOB_KATALOG = {
  shopify_fulfillment_create: {
    label: 'Fulfillment an den Shop melden',
    beschreibung: 'Meldet die Sendung mit Trackingnummer; der Shop verschickt die Kundenmail.',
    faehigkeit: 'shop:fulfillment_melden',
  },
  shopify_tag_add: {
    label: 'Shop-Tag setzen',
    beschreibung: 'Hängt einen Status-Tag an die Shop-Bestellung (optional, Default aus).',
    faehigkeit: 'shop:tag_setzen',
  },
  shopify_order_cancel: {
    label: 'Storno an den Shop melden',
    beschreibung:
      'Storniert die Shop-Bestellung nach einem ERP-Storno (Bestand zurück ins Shop-Inventar); ' +
      'die Rückerstattung bleibt ein manueller Schritt im Shop.',
    faehigkeit: 'shop:bestellung_stornieren',
  },
  shopify_inventory_push: {
    label: 'Bestand an den Shop melden',
    beschreibung: 'Überträgt geänderte verfügbare Mengen (Dedupe „inventar-abgleich").',
    faehigkeit: 'shop:bestand_melden',
  },
  shopify_customer_import: {
    label: 'Kunden aus dem Shop übernehmen',
    beschreibung: 'Erstübernahme aller Shop-Kunden in Häppchen (Cursor im Dedupe-Schlüssel).',
    faehigkeit: 'shop:kunden_import',
  },
  shopify_product_push: {
    label: 'Produkt in den Shop übertragen',
    beschreibung: 'Legt ein ERP-Produkt samt Varianten im Shop an bzw. gleicht Änderungen ab.',
    faehigkeit: 'shop:produkt_uebertragen',
  },
  shopify_product_import: {
    label: 'Produkte aus dem Shop übernehmen',
    beschreibung: 'Erstübernahme des Shop-Katalogs (verknüpfen per SKU/Barcode, sonst anlegen).',
    faehigkeit: 'shop:produkt_import',
  },
  shopify_order_backfill: {
    label: 'Bestellungen aus dem Shop übernehmen',
    beschreibung: 'Holt historische Bestellungen zur Abfrage q in Häppchen.',
    faehigkeit: 'shop:bestellungen_import',
  },
  send_po_email: {
    label: 'Bestellung mailen',
    beschreibung: 'Schickt die Einkaufsbestellung als PDF an den Lieferanten.',
    faehigkeit: 'mail:bestellung',
  },
  send_return_label_email: {
    label: 'Retourenlabel mailen',
    beschreibung: 'Schickt das DHL-Retourenlabel samt QR-Code an den Kunden.',
    faehigkeit: 'mail:retourenlabel',
  },
} satisfies Record<string, JobEintrag>

export type JobKind = keyof typeof JOB_KATALOG
