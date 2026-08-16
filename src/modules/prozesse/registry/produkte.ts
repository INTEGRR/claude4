import { z } from 'zod'
import { AKTIONEN } from '../../ki/aktionen.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Produktbereichs. Die Produktanlage teilt sich Schema und
 * Fachlogik mit der KI-Aktion `produkt_anlegen` — eine Definition, drei
 * Transporte (KI-Chat, generierte Maske, Prozesstest). Die Richtung stimmt
 * schon mit Phase 6 überein, wo der KI-Katalog ganz aus der Registry kommt.
 */
export const PRODUKTE = {
  'produkte.produkt_anlegen': {
    label: AKTIONEN.produkt_anlegen.label,
    bereich: 'produkte',
    beschreibung: AKTIONEN.produkt_anlegen.beschreibung,
    bindung: 'frei',
    schema: AKTIONEN.produkt_anlegen.schema,
    zusammenfassung: AKTIONEN.produkt_anlegen.zusammenfassung,
    revalidate: ['/produkte'],
  },

  'produkte.produkt_erfassen': {
    label: 'Produkt erfassen',
    bereich: 'produkte',
    beschreibung:
      'Einfache Anlage über das Formular (Preise, Routen, Artikelnummer) — für die ' +
      'Variantenmatrix den Anlage-Assistenten oder produkt_anlegen nutzen.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(200),
      uom_id: z.string().min(1),
      list_price: z.number().nonnegative().default(0),
      standard_cost: z.number().nonnegative().default(0),
      weight_g: z.number().nonnegative().default(0),
      can_be_sold: z.boolean().default(false),
      can_be_purchased: z.boolean().default(false),
      route_buy: z.boolean().default(false),
      route_manufacture: z.boolean().default(false),
      route_mto: z.boolean().default(false),
      sku: z.string().max(40).optional(),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      uom_id: String(fd.get('uom_id') ?? ''),
      list_price: Number(fd.get('list_price') ?? 0),
      standard_cost: Number(fd.get('standard_cost') ?? 0),
      weight_g: Number(fd.get('weight_g') ?? 0),
      can_be_sold: fd.get('can_be_sold') === 'on',
      can_be_purchased: fd.get('can_be_purchased') === 'on',
      route_buy: fd.get('route_buy') === 'on',
      route_manufacture: fd.get('route_manufacture') === 'on',
      route_mto: fd.get('route_mto') === 'on',
      sku: String(fd.get('sku') ?? '').trim() || undefined,
    }),
    revalidate: ['/produkte'],
  },

  'produkte.produkt_aendern': {
    label: 'Produkt ändern',
    bereich: 'produkte',
    beschreibung:
      'Ändert Preise, Routen, Steuern, Belegtexte, Zolldaten und Versandmerkmale; ' +
      'Shopify-verknüpfte Produkte werden nachgezogen (Outbox).',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1).max(200),
      list_price: z.number().nonnegative().default(0),
      standard_cost: z.number().nonnegative().default(0),
      weight_g: z.number().nonnegative().default(0),
      purchase_uom_id: z.string().optional(),
      invoice_policy: z.string().default('order'),
      bill_policy: z.string().default('received'),
      can_be_sold: z.boolean().default(false),
      can_be_purchased: z.boolean().default(false),
      route_buy: z.boolean().default(false),
      route_manufacture: z.boolean().default(false),
      route_mto: z.boolean().default(false),
      category_id: z.string().optional(),
      sale_delay: z.number().nonnegative().default(0),
      hs_code: z.string().max(20).optional(),
      country_of_origin: z.string().max(2).optional(),
      sale_tax_id: z.string().optional(),
      purchase_tax_id: z.string().optional(),
      description_sale: z.string().max(2000).optional(),
      description_purchase: z.string().max(2000).optional(),
      description_picking: z.string().max(2000).optional(),
      responsible_id: z.string().optional(),
      tracking: z.string().default('none'),
      kleinpaket: z.boolean().default(false),
      platzbedarf: z.number().positive().default(1),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      list_price: Number(fd.get('list_price') ?? 0),
      standard_cost: Number(fd.get('standard_cost') ?? 0),
      weight_g: Number(fd.get('weight_g') ?? 0),
      purchase_uom_id: String(fd.get('purchase_uom_id') ?? '') || undefined,
      invoice_policy: String(fd.get('invoice_policy') ?? 'order'),
      bill_policy: String(fd.get('bill_policy') ?? 'received'),
      can_be_sold: fd.get('can_be_sold') === 'on',
      can_be_purchased: fd.get('can_be_purchased') === 'on',
      route_buy: fd.get('route_buy') === 'on',
      route_manufacture: fd.get('route_manufacture') === 'on',
      route_mto: fd.get('route_mto') === 'on',
      category_id: String(fd.get('category_id') ?? '') || undefined,
      sale_delay: Number(fd.get('sale_delay') ?? 0),
      hs_code: String(fd.get('hs_code') ?? '').trim() || undefined,
      country_of_origin:
        String(fd.get('country_of_origin') ?? '').trim().toUpperCase() || undefined,
      sale_tax_id: String(fd.get('sale_tax_id') ?? '') || undefined,
      purchase_tax_id: String(fd.get('purchase_tax_id') ?? '') || undefined,
      description_sale: String(fd.get('description_sale') ?? '').trim() || undefined,
      description_purchase: String(fd.get('description_purchase') ?? '').trim() || undefined,
      description_picking: String(fd.get('description_picking') ?? '').trim() || undefined,
      responsible_id: String(fd.get('responsible_id') ?? '') || undefined,
      tracking: String(fd.get('tracking') ?? 'none'),
      kleinpaket: fd.get('kleinpaket') === 'on',
      platzbedarf: Math.max(Number(fd.get('platzbedarf') ?? 1) || 1, 0.01),
    }),
    revalidate: ['/produkte/:id'],
  },

  'produkte.attribut_zuweisen': {
    label: 'Attribut zuweisen',
    bereich: 'produkte',
    beschreibung: 'Weist der Vorlage ein Attribut mit Werten zu und erzeugt die Variantenmatrix.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      attribute_id: z.string().min(1, 'Bitte ein Attribut auswählen'),
      value_ids: z.array(z.string()).min(1, 'Bitte mindestens einen Wert auswählen'),
    }),
    formdata: (fd) => ({
      attribute_id: String(fd.get('attribute_id') ?? ''),
      value_ids: fd.getAll('value_ids').map(String).filter(Boolean),
    }),
    revalidate: ['/produkte/:id'],
  },

  'produkte.variante_codes': {
    label: 'Variantencodes setzen',
    bereich: 'produkte',
    beschreibung: 'Artikelnummer, Barcode und Shopify-Verknüpfung einer Variante.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      sku: z.string().max(60).optional(),
      barcode: z.string().max(60).optional(),
      shopify_variant_id: z.string().max(80).optional(),
    }),
    formdata: (fd) => ({
      sku: String(fd.get('sku') ?? '').trim() || undefined,
      barcode: String(fd.get('barcode') ?? '').trim() || undefined,
      shopify_variant_id: String(fd.get('shopify_variant_id') ?? '').trim() || undefined,
    }),
    revalidate: ['/produkte/variante/:id', '/produkte/:ergebnis'],
  },

  'produkte.attribut_anlegen': {
    label: 'Attribut anlegen',
    bereich: 'produkte',
    beschreibung: 'Legt ein Attribut mit Werten an (vorhandene Namen werden wiederverwendet).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(60),
      werte: z.array(z.string()).min(1, 'Bitte mindestens einen Wert angeben (kommagetrennt)'),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      werte: String(fd.get('values') ?? '')
        .split(/[,\n]/)
        .map((v) => v.trim())
        .filter(Boolean),
    }),
    revalidate: ['/produkte/attribute'],
  },

  'produkte.zu_shopify': {
    label: 'In Shopify anlegen',
    bereich: 'produkte',
    beschreibung:
      'Legt das Produkt samt Varianten in Shopify an und verknüpft beide Seiten — danach laufen Bestandsabgleich und Bestellzuordnung automatisch.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/produkte/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
