import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Shop-Verfügbarkeit (0101): was Shopify je Artikel, Option, Variante und
 * Teil bekommt. Jede Änderung stößt sofort einen Bestandsabgleich an.
 * Entscheidungslog 2026-10-01, „Shop-Verfügbarkeit: Regeln".
 */

const MODUS = z.enum(['auto', 'immer', 'aus'])
const leer = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return v === null ? undefined : String(v).trim()
}

export const VERKAUF_SHOP = {
  'verkauf.shop_artikel_setzen': {
    label: 'Shop: Artikel steuern',
    bereich: 'verkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Steuert ein Shopify-Produkt (Artikel): Modus auto (berechnet), immer (Deckel melden — z. B. ' +
      'Switch-Tester) oder aus (0 = ausverkauft — z. B. Black Week Editions); optional das Shop-Projekt, ' +
      'unter dem Produkte im Shop als ein Artikel mit Farb-Pills erscheinen.',
    bindung: 'frei',
    schema: z
      .object({
        template_id: z.string().uuid(),
        modus: MODUS.optional(),
        projekt: z.string().trim().max(100).nullable().optional().describe('leer = kein Projekt'),
      })
      .refine((p) => p.modus !== undefined || p.projekt !== undefined, 'Modus oder Projekt angeben'),
    zusammenfassung: (p) =>
      [p.modus ? `Artikel an Shopify: ${p.modus}` : null, p.projekt !== undefined ? `Projekt: ${p.projekt ?? '—'}` : null]
        .filter(Boolean)
        .join(', '),
    formdata: (fd) => {
      const projekt = leer(fd, 'projekt')
      return {
        template_id: String(fd.get('template_id') ?? ''),
        modus: leer(fd, 'modus') || undefined,
        projekt: projekt === undefined ? undefined : projekt || null,
      }
    },
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },

  'verkauf.shop_variante_setzen': {
    label: 'Shop: Variante oder Teil steuern',
    bereich: 'verkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Für eine Variante: Modus auto/immer/aus oder erben (wie der Artikel). Als Teil bzw. Artikel mit ' +
      'Bestand: Schwelle „ausverkauft unter N Stück" (nur was darüber liegt, zählt; leer = keine) und ' +
      'zurückhalten (zählt für den Shop als 0 — z. B. Yellow Cases). Wirkt auf alle Tastaturen, die das ' +
      'Teil brauchen.',
    bindung: 'frei',
    schema: z
      .object({
        variant_id: z.string().uuid(),
        modus: z.enum(['auto', 'immer', 'aus', 'erben']).optional(),
        oos_unter: z.number().int().min(1).max(100000).nullable().optional(),
        zurueckhalten: z.boolean().optional(),
      })
      .refine(
        (p) => p.modus !== undefined || p.oos_unter !== undefined || p.zurueckhalten !== undefined,
        'Nichts zu ändern',
      ),
    zusammenfassung: (p) =>
      [
        p.modus ? `Variante an Shopify: ${p.modus}` : null,
        p.oos_unter !== undefined ? (p.oos_unter ? `ausverkauft unter ${p.oos_unter}` : 'keine Schwelle') : null,
        p.zurueckhalten !== undefined ? (p.zurueckhalten ? 'zurückhalten' : 'nicht zurückhalten') : null,
      ]
        .filter(Boolean)
        .join(', '),
    formdata: (fd) => {
      const schwelle = leer(fd, 'oos_unter')
      return {
        variant_id: String(fd.get('variant_id') ?? ''),
        modus: leer(fd, 'modus') || undefined,
        oos_unter: schwelle === undefined ? undefined : schwelle === '' ? null : Number(schwelle),
        // Checkbox: nur auswerten, wenn das Formular sie führt (Marker-Feld).
        zurueckhalten: fd.has('zurueckhalten_feld') ? fd.get('zurueckhalten') === 'on' : undefined,
      }
    },
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },

  'verkauf.shop_option_setzen': {
    label: 'Shop: Option sperren oder freigeben',
    bereich: 'verkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Sperrt einen Optionswert eines Artikels (z. B. Switches: Clicky Blue) — alle Varianten damit melden ' +
      '0 — oder gibt ihn frei. alle_farben: für alle Artikel desselben Shop-Projekts mit gleichem Option- ' +
      'und Wertnamen.',
    bindung: 'frei',
    schema: z.object({
      template_id: z.string().uuid(),
      ptav_id: z.string().uuid(),
      gesperrt: z.boolean(),
      alle_farben: z.boolean().default(false),
    }),
    zusammenfassung: (p) => `Option ${p.gesperrt ? 'deaktivieren' : 'freigeben'}${p.alle_farben ? ' (alle Farben)' : ''}`,
    formdata: (fd) => ({
      template_id: String(fd.get('template_id') ?? ''),
      ptav_id: String(fd.get('ptav_id') ?? ''),
      gesperrt: fd.get('gesperrt') === 'true',
      alle_farben: fd.get('alle_farben') === 'on',
    }),
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },

  'verkauf.shop_zweitangebot_setzen': {
    label: 'Shop: Zweitangebot steuern',
    bereich: 'verkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Steuert ein Zweitangebot — ein weiteres Shop-Angebot mit der SKU eines Artikels, z. B. die ' +
      'Bestandteil-Liste eines Bundles („Black Week Editions"): auto = dieselbe Menge wie der Artikel, ' +
      'immer = Deckel melden, aus = 0 (ausverkauft) — unabhängig vom Artikel selbst.',
    bindung: 'frei',
    schema: z.object({
      angebot_id: z.string().uuid(),
      modus: MODUS,
    }),
    zusammenfassung: (p) => `Zweitangebot an Shopify: ${p.modus}`,
    formdata: (fd) => ({
      angebot_id: String(fd.get('angebot_id') ?? ''),
      modus: leer(fd, 'modus') || undefined,
    }),
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },

  'verkauf.shop_stand_holen': {
    label: 'Shop: Stand aus Shopify holen',
    bereich: 'verkauf',
    prozessfrei: true,
    beschreibung:
      'Liest je Shopify-Variante Menge, „verkaufbar", Mengenverfolgung und Produktstatus aus dem Shop ' +
      '(nur lesend, auch im Modus „nur lesen") — für den Vergleich Ist gegen Soll.',
    bindung: 'frei',
    schema: z.object({}),
    revalidate: ['/verkauf/shop-verfuegbarkeit', '/einstellungen/anbindungen'],
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
