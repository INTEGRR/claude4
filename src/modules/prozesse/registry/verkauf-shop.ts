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
  'verkauf.shop_verkauf_schalten': {
    label: 'Shop: Verkauf starten oder stoppen',
    bereich: 'verkauf',
    prozessfrei: true,
    beschreibung:
      'Stellt mehrere Shop-Artikel (z. B. alle Tastaturen eines Shop-Projekts) in einem Schritt um: ' +
      'start = „berechnet" (die Regeln greifen, die verteilten Mengen gehen an Shopify), ' +
      'stopp = „aus" (0 = ausverkauft). Ein Abgleich für alle — der Knopf für den Release.',
    bindung: 'frei',
    schema: z.object({
      template_ids: z.array(z.string().guid()).min(1, 'Keine Artikel gewählt').max(100),
      start: z.boolean(),
    }),
    zusammenfassung: (p) => `${p.template_ids.length} Shop-Artikel: Verkauf ${p.start ? 'starten' : 'stoppen'}`,
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },


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
        template_id: z.string().guid(),
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
      'Teil brauchen. Nur für den Einzelverkauf eines Lagerartikels (Ersatzteil): rueckhalt = so viele ' +
      'Stück bleiben der Fertigung, hoechstmenge = nie mehr gleichzeitig im Shop anbieten (leer = ohne); ' +
      'Tastaturen rechnen weiter mit dem vollen Bestand.',
    bindung: 'frei',
    schema: z
      .object({
        variant_id: z.string().guid(),
        modus: z.enum(['auto', 'immer', 'aus', 'erben']).optional(),
        oos_unter: z.number().int().min(1).max(100000).nullable().optional(),
        zurueckhalten: z.boolean().optional(),
        rueckhalt: z.number().min(0).max(1000000).nullable().optional(),
        hoechstmenge: z.number().int().min(0).max(100000).nullable().optional(),
      })
      .refine(
        (p) =>
          p.modus !== undefined || p.oos_unter !== undefined || p.zurueckhalten !== undefined ||
          p.rueckhalt !== undefined || p.hoechstmenge !== undefined,
        'Nichts zu ändern',
      ),
    zusammenfassung: (p) =>
      [
        p.modus ? `Variante an Shopify: ${p.modus}` : null,
        p.oos_unter !== undefined ? (p.oos_unter ? `ausverkauft unter ${p.oos_unter}` : 'keine Schwelle') : null,
        p.zurueckhalten !== undefined ? (p.zurueckhalten ? 'zurückhalten' : 'nicht zurückhalten') : null,
        p.rueckhalt !== undefined ? (p.rueckhalt ? `Rückhalt ${p.rueckhalt}` : 'kein Rückhalt') : null,
        p.hoechstmenge !== undefined ? (p.hoechstmenge !== null ? `höchstens ${p.hoechstmenge}` : 'keine Höchstmenge') : null,
      ]
        .filter(Boolean)
        .join(', '),
    formdata: (fd) => {
      const schwelle = leer(fd, 'oos_unter')
      // Leeres Feld = Regel aufheben; fehlt das Feld im Formular, bleibt sie.
      const zahl = (k: string) => {
        const v = leer(fd, k)
        return v === undefined ? undefined : v === '' ? null : Number(v.replace(',', '.'))
      }
      return {
        variant_id: String(fd.get('variant_id') ?? ''),
        modus: leer(fd, 'modus') || undefined,
        oos_unter: schwelle === undefined ? undefined : schwelle === '' ? null : Number(schwelle),
        // Checkbox: nur auswerten, wenn das Formular sie führt (Marker-Feld).
        zurueckhalten: fd.has('zurueckhalten_feld') ? fd.get('zurueckhalten') === 'on' : undefined,
        rueckhalt: zahl('rueckhalt'),
        hoechstmenge: zahl('hoechstmenge'),
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
      template_id: z.string().guid(),
      ptav_id: z.string().guid(),
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
      angebot_id: z.string().guid(),
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

  'verkauf.shop_not_aus': {
    label: 'Shop: Not-Aus',
    bereich: 'verkauf',
    prozessfrei: true,
    beschreibung:
      'Not-Aus für den Shop (0136): setzt JEDES Angebot sofort auf 0 (ausverkauft) — absolut, unabhängig ' +
      'vom Buch — und hält es dort, bis der Not-Aus aufgehoben wird. Für den Fall, dass am Release-Tag ' +
      'etwas nicht stimmt. Aufheben verteilt die Kontingente neu.',
    bindung: 'frei',
    schema: z.object({
      aktiv: z.boolean().describe('true = alles auf ausverkauft, false = Not-Aus aufheben'),
    }),
    zusammenfassung: (p) => (p.aktiv ? 'Not-Aus: alle Angebote auf ausverkauft' : 'Not-Aus aufheben'),
    formdata: (fd) => ({ aktiv: fd.get('aktiv') === 'true' }),
    revalidate: ['/verkauf/shop-verfuegbarkeit', '/'],
  },

  'verkauf.shop_gewicht_setzen': {
    label: 'Shop: erwartete Nachfrage (Gewicht) setzen',
    bereich: 'verkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Kontingent (0136): Gewicht eines Artikels oder eines Optionswerts für die Verteilung knapper Teile ' +
      'auf die Shop-Angebote — doppeltes Gewicht bekommt doppelt so viel. Leer = 1. Das Gewicht einer ' +
      'Variante ist Artikel × alle ihre Optionswerte. alle_farben: für gleich benannte Optionswerte der ' +
      'übrigen Artikel desselben Shop-Projekts.',
    bindung: 'frei',
    schema: z.object({
      template_id: z.string().guid(),
      ptav_id: z.string().guid().optional().describe('Optionswert; leer = Gewicht des Artikels'),
      gewicht: z.number().positive().max(1000).nullable().describe('leer = 1'),
      alle_farben: z.boolean().default(false),
    }),
    zusammenfassung: (p) => `Gewicht ${p.gewicht ?? 1}${p.ptav_id ? ' für einen Optionswert' : ' für den Artikel'}`,
    formdata: (fd) => {
      const roh = String(fd.get('gewicht') ?? '').trim().replace(',', '.')
      return {
        template_id: String(fd.get('template_id') ?? ''),
        ptav_id: String(fd.get('ptav_id') ?? '') || undefined,
        gewicht: roh === '' ? null : Number(roh),
        alle_farben: fd.get('alle_farben') === 'on',
      }
    },
    revalidate: ['/verkauf/shop-verfuegbarkeit'],
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
