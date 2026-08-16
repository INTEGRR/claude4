import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Versands. Kern für den Shopify-Prozess (P4) ist
 * `versand.label_erstellen` — Massendruck, Storno, Tracking und Retouren
 * sind Werkzeuge außerhalb des Prozessflusses (prozessfrei).
 */
export const VERSAND = {
  'versand.label_erstellen': {
    label: 'DHL-Label erstellen',
    bereich: 'versand',
    beschreibung:
      'Erstellt das Versandlabel für eine Lieferung — Produkt und Versicherung nach den ' +
      'Versandregeln (überschreibbar), Zolldaten bei Drittland automatisch.',
    bindung: 'beleg',
    modell: 'stock_picking',
    schema: z.object({
      weight_g: z.number().positive().optional().describe('Gewicht überschreiben (Gramm)'),
      dhl_product: z.string().max(20).optional().describe('DHL-Produkt überschreiben'),
    }),
    formdata: (fd) => ({
      weight_g: fd.get('weight_g') ? Number(fd.get('weight_g')) : undefined,
      dhl_product: String(fd.get('dhl_product') ?? '') || undefined,
    }),
    revalidate: ['/versand', '/lager/:id'],
  },

  'versand.label_stornieren': {
    label: 'Label stornieren',
    bereich: 'versand',
    beschreibung:
      'Storniert eine Sendung bei DHL (bis zum Tagesabschluss) und entfernt sie aus der Liste.',
    bindung: 'beleg',
    modell: 'shipment',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/versand'],
  },

  'versand.tracking_aktualisieren': {
    label: 'Tracking aktualisieren',
    bereich: 'versand',
    ki: true,
    beschreibung: 'Fragt den Sendungsstatus offener Sendungen bei DHL ab (Rate-Limit beachtet).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/versand'],
  },

  'versand.massendruck': {
    label: 'Massendruck',
    bereich: 'versand',
    beschreibung:
      'Labels für alle gefilterten versandbereiten Lieferungen nach Regelvorschlag; ' +
      'wahlweise direkt ausbuchen (Warenausgang + Shopify-Rückmeldung).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      einzel: z.boolean().default(false).describe('Nur Ein-Positions-Lieferungen'),
      sku: z.string().max(60).default(''),
      land: z.string().max(8).default(''),
      produkt: z.string().max(20).default(''),
      ausbuchen: z.boolean().default(false).describe('Nach dem Label direkt ausbuchen'),
    }),
    formdata: (fd) => ({
      einzel: fd.get('einzel') === 'on',
      sku: String(fd.get('sku') ?? ''),
      land: String(fd.get('land') ?? ''),
      produkt: String(fd.get('produkt') ?? ''),
      ausbuchen: fd.get('ausbuchen') === 'on',
    }),
    revalidate: ['/versand', '/lager'],
  },

  'versand.retourenlabel_erstellen': {
    label: 'Retourenlabel erstellen',
    bereich: 'versand',
    beschreibung: 'Erstellt ein DHL-Retourenlabel für einen Kunden und mailt es ihm zu.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      partner_id: z.string().min(1, 'Bitte einen Kunden auswählen'),
      reference: z.string().max(50).optional(),
    }),
    formdata: (fd) => ({
      partner_id: String(fd.get('partner_id') ?? ''),
      reference: String(fd.get('reference') ?? '') || undefined,
    }),
    revalidate: ['/versand/retouren'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
