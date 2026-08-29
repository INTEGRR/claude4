import { z } from 'zod'
import { geld, type RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Produktbereichs. Die Produktanlage hat EINE Definition und
 * drei Transporte (KI-Chat, generierte Maske, Prozesstest) — seit der
 * Auflösung des KI-Anlage-Katalogs lebt sie hier, die Fachlogik weiter in
 * ki/produkt-anlegen.ts (Entscheidungslog 2026-08-27).
 */

interface Attribut {
  name: string
  werte: { name: string; aufpreis?: number; kuerzel?: string; farbe?: string }[]
}

export const PRODUKTE = {
  'produkte.produkt_anlegen': {
    label: 'Produkt anlegen',
    bereich: 'produkte',
    ki: true,
    beschreibung:
      'Legt ein Produkt an — mit Attributen entsteht daraus sofort die komplette ' +
      'Variantenmatrix (z. B. 3 Farben × 4 Schaltertypen = 12 Varianten). Fehlende Attribute ' +
      'und Attributwerte werden dabei mit angelegt, vorhandene wiederverwendet (Abgleich über ' +
      'den Namen). Taugt auch für Einkaufsteile: verkaufbar=false, einkaufbar=true.',
    bindung: 'frei',
    schema: z.object({
      name: z.string().min(1).max(200),
      verkaufspreis: z.number().nonnegative().optional().describe('Listenpreis netto'),
      einstandspreis: z.number().nonnegative().optional().describe('Plankosten je Stück'),
      gewicht_g: z.number().nonnegative().max(1_000_000).optional(),
      verkaufbar: z.boolean().default(true),
      einkaufbar: z.boolean().default(false),
      route: z.enum(['kaufen', 'fertigen']).optional(),
      sku: z
        .string()
        .max(40)
        .optional()
        .describe('Artikelnummer; mit Attributen als Präfix, ergänzt um die Kürzel je Wert'),
      beschreibung: z.string().max(500).optional().describe('Belegtext Verkauf'),
      attribute: z
        .array(
          z.object({
            name: z.string().min(1).max(60).describe('z. B. Farbe oder Switch'),
            werte: z
              .array(
                z.object({
                  name: z.string().min(1).max(60),
                  aufpreis: z.number().optional().describe('Aufschlag auf den Listenpreis'),
                  kuerzel: z.string().max(8).optional().describe('für die SKU, z. B. BK'),
                  farbe: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als Hex-Wert, z. B. #1a1a1a')
                    .optional(),
                }),
              )
              .min(1)
              .max(40),
          }),
        )
        .max(3)
        .default([])
        .describe('Höchstens drei Attribute — die Matrix wächst multiplikativ'),
    }).refine(
      (p) => p.attribute.reduce((n, a) => n * a.werte.length, 1) <= 200,
      { message: 'Mehr als 200 Varianten — bitte die Attributwerte eingrenzen', path: ['attribute'] },
    ),
    zusammenfassung: (p) => {
      const varianten = p.attribute.reduce((n: number, a: Attribut) => n * a.werte.length, 1)
      const teile = p.attribute
        .map((a: Attribut) => `${a.name} (${a.werte.map((w) => w.name).join(', ')})`)
        .join(' × ')
      return (
        `${p.name}${p.verkaufspreis ? `, ${geld(p.verkaufspreis)}` : ''}` +
        (p.attribute.length > 0 ? ` — ${teile} ⇒ ${varianten} Varianten` : ' — ohne Varianten')
      )
    },
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

  'produkte.lieferantenpreis_anlegen': {
    label: 'Lieferantenpreis anlegen',
    bereich: 'produkte',
    beschreibung:
      'Preisliste je Lieferant am Produkt: je Zeile eine Staffel ab Mindestmenge (MOQ), ' +
      'mit Rabatt, Lieferzeit und Gültigkeit. Die Beschaffung empfiehlt Mengen ab der ' +
      'MOQ und zieht den Staffelpreis der bestellten Menge.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      vendor_id: z.string().min(1, 'Bitte einen Lieferanten auswählen'),
      preis: z.number().nonnegative(),
      rabatt: z.number().min(0).max(100).default(0),
      moq: z.number().nonnegative().default(0),
      lieferzeit_tage: z.number().int().nonnegative().default(0),
      gueltig_von: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      gueltig_bis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    formdata: (fd) => ({
      vendor_id: String(fd.get('vendor_id') ?? ''),
      preis: Number(fd.get('preis') ?? 0),
      rabatt: Number(fd.get('rabatt') ?? 0),
      moq: Number(fd.get('moq') ?? 0),
      lieferzeit_tage: Number(fd.get('lieferzeit_tage') ?? 0),
      gueltig_von: String(fd.get('gueltig_von') ?? '') || undefined,
      gueltig_bis: String(fd.get('gueltig_bis') ?? '') || undefined,
    }),
    revalidate: ['/produkte/:id', '/lager/beschaffung'],
  },

  'produkte.lieferantenpreis_loeschen': {
    label: 'Lieferantenpreis löschen',
    bereich: 'produkte',
    beschreibung: 'Entfernt eine Staffelzeile aus der Lieferanten-Preisliste des Produkts.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({
      preis_id: z.string().min(1),
    }),
    formdata: (fd) => ({
      preis_id: String(fd.get('preis_id') ?? ''),
    }),
    revalidate: ['/produkte/:id', '/lager/beschaffung'],
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
