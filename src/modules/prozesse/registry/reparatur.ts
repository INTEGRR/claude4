import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen der Reparatur — der erste vollständige Belegprozess des Hauses
 * (klare lineare Statusmaschine new → confirmed → under_repair → repaired,
 * wenige Sonderfälle). Deshalb Pilot für Prozessdiagramm und -test.
 */
export const REPARATUR = {
  'reparatur.auftrag_anlegen': {
    label: 'Reparaturauftrag anlegen',
    bereich: 'reparatur',
    beschreibung: 'Legt einen Reparaturauftrag für Kunde + Produkt an (Status new).',
    bindung: 'frei',
    modell: 'repair_order',
    uebergang: { von: [], nach: ['new'] },
    schema: z.object({
      partner_id: z.string().min(1, 'Bitte einen Kunden auswählen'),
      variant_id: z.string().min(1, 'Bitte das zu reparierende Produkt auswählen'),
      qty: z.number().positive().default(1),
      under_warranty: z.boolean().default(false),
      note: z.string().max(2000).optional(),
    }),
    formdata: (fd) => ({
      partner_id: String(fd.get('partner_id') ?? ''),
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 1) || 1,
      under_warranty: fd.get('under_warranty') === 'on',
      note: String(fd.get('note') ?? '') || undefined,
    }),
    revalidate: ['/reparatur'],
  },

  'reparatur.teil_hinzufuegen': {
    label: 'Teil hinzufügen',
    bereich: 'reparatur',
    beschreibung: 'Nimmt ein Teil in den Auftrag auf (einbauen / ausbauen / wiederverwenden).',
    bindung: 'beleg',
    modell: 'repair_order',
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Teil auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
      part_type: z.enum(['add', 'remove', 'recycle']).default('add'),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
      part_type: String(fd.get('part_type') ?? 'add'),
    }),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.teil_entfernen': {
    label: 'Teil entfernen',
    bereich: 'reparatur',
    beschreibung: 'Entfernt ein Teil aus dem Auftrag (eine offene Reservierung wird storniert).',
    bindung: 'beleg',
    modell: 'repair_order',
    prozessfrei: true,
    schema: z.object({ part_id: z.string().min(1) }),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.bestaetigen': {
    label: 'Bestätigen',
    bereich: 'reparatur',
    beschreibung: 'Bestätigt den Auftrag: Teilebewegungen entstehen, Einbauteile werden reserviert.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['new'], nach: ['confirmed'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.beginnen': {
    label: 'Reparatur beginnen',
    bereich: 'reparatur',
    beschreibung: 'Setzt den Auftrag in Arbeit.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['confirmed'], nach: ['under_repair'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.abschliessen': {
    label: 'Abschließen',
    bereich: 'reparatur',
    beschreibung: 'Schließt die Reparatur ab und bucht die Teile mit Ist-Mengen.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['confirmed', 'under_repair'], nach: ['repaired'] },
    schema: z.object({
      /** Ist-Mengen je Teilezeile (partId → Menge); leer = Sollmenge. */
      mengen: z.record(z.string(), z.number().nonnegative()).default({}),
    }),
    formdata: (fd) => {
      const mengen: Record<string, number> = {}
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith('done_') || typeof value !== 'string' || value.trim() === '') continue
        const n = Number(value.trim())
        if (Number.isFinite(n) && n >= 0) mengen[key.slice(5)] = n
      }
      return { mengen }
    },
    revalidate: ['/reparatur/:id', '/lager/bestand'],
  },

  'reparatur.stornieren': {
    label: 'Stornieren',
    bereich: 'reparatur',
    beschreibung: 'Storniert den Auftrag samt offener Teilebewegungen.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['new', 'confirmed', 'under_repair'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.angebot_erstellen': {
    label: 'Angebot aus Reparatur',
    bereich: 'reparatur',
    beschreibung:
      'Erzeugt aus den verbauten Teilen ein Verkaufsangebot (nicht bei Garantie).',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['repaired'], nach: ['repaired'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id', '/verkauf'],
  },

  'reparatur.details': {
    label: 'Verantwortlichen/Priorität setzen',
    bereich: 'reparatur',
    beschreibung: 'Setzt Verantwortlichen und Priorität des Auftrags.',
    bindung: 'beleg',
    modell: 'repair_order',
    prozessfrei: true,
    schema: z.object({
      user_id: z.string().optional(),
      priority: z.boolean().default(false),
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      priority: fd.get('priority') === 'on',
    }),
    revalidate: ['/reparatur/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
