import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen der Reparatur — der erste vollständige Belegprozess des Hauses.
 * Seit 0082 mit beiden Enden: das Gerät kommt per Post (Retourenlabel →
 * awaiting_device → received) und geht per Post zurück (rueckversand →
 * shipped); die Reparaturanfrage aus dem Kundenformular ist ein Vorgang, den
 * reparatur.anfrage_annehmen in Kunde + Auftrag + Retourenlabel verwandelt.
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
    ki: true,
    beschreibung: 'Bestätigt den Auftrag: Teilebewegungen entstehen, Einbauteile werden reserviert.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['new', 'received'], nach: ['confirmed'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id'],
  },

  'reparatur.beginnen': {
    label: 'Reparatur beginnen',
    bereich: 'reparatur',
    ki: true,
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
    ki: true,
    beschreibung: 'Storniert den Auftrag samt offener Teilebewegungen.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: {
      von: ['new', 'awaiting_device', 'received', 'confirmed', 'under_repair'],
      nach: ['cancel'],
    },
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

  'reparatur.anfrage_annehmen': {
    label: 'Annehmen → Reparaturauftrag',
    bereich: 'reparatur',
    beschreibung:
      'Nimmt eine Reparaturanfrage (Vorgang) an: Kunde per E-Mail wiederverwenden oder anlegen, ' +
      'Reparaturauftrag mit RMA-Nummer und Herkunft anlegen und — wenn gewünscht und DHL ' +
      'konfiguriert — sofort das Retourenlabel mit der RMA-Nummer mailen. Idempotent: existiert ' +
      'schon ein Auftrag zur Anfrage, wird er verlinkt.',
    bindung: 'beleg',
    modell: 'vorgang',
    uebergang: { von: ['neu', 'rueckfrage'], nach: ['angenommen'] },
    schema: z.object({
      state: z.string().min(1).max(60),
      variant_id: z.string().min(1, 'Bitte das zu reparierende Produkt auswählen'),
      under_warranty: z.boolean().default(false),
      qty: z.number().positive().default(1),
      label_senden: z
        .boolean()
        .default(true)
        .describe('Retourenlabel sofort an den Kunden mailen (braucht DHL)'),
      vermerk: z.string().max(1000).optional(),
    }),
    zusammenfassung: (p) =>
      `→ Reparaturauftrag${p.under_warranty ? ' (Garantie)' : ''}${p.label_senden ? ' + Retourenlabel' : ''}`,
    formdata: (fd) => ({
      state: String(fd.get('state') ?? ''),
      variant_id: String(fd.get('variant_id') ?? ''),
      under_warranty: fd.get('under_warranty') === 'on' || fd.get('under_warranty') === 'true',
      qty: Number(fd.get('qty') ?? 1) || 1,
      label_senden: fd.get('label_senden') === 'on' || fd.get('label_senden') === 'true',
      vermerk: String(fd.get('vermerk') ?? '').trim() || undefined,
    }),
    revalidate: ['/vorgaenge/:id', '/vorgaenge', '/reparatur', '/versand/retouren', '/lager/zulauf'],
  },

  'reparatur.retourenlabel_senden': {
    label: 'Retourenlabel senden',
    bereich: 'reparatur',
    ki: true,
    beschreibung:
      'Erzeugt das DHL-Retourenlabel mit der RMA-Nummer als Kundenreferenz, mailt es dem Kunden ' +
      'und stellt den Auftrag auf „wartet auf Gerät".',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['new', 'awaiting_device'], nach: ['awaiting_device'] },
    schema: z.object({}),
    revalidate: ['/reparatur/:id', '/versand/retouren', '/lager/zulauf'],
  },

  'reparatur.geraet_eingegangen': {
    label: 'Gerät eingegangen',
    bereich: 'reparatur',
    ki: true,
    beschreibung:
      'Das Kundengerät ist im Haus (Scan der Retouren-Sendungsnummer oder RMA am Wareneingang). ' +
      'Keine Bestandsbuchung — das Gerät gehört dem Kunden.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['new', 'awaiting_device'], nach: ['received'] },
    schema: z.object({
      vermerk: z.string().max(500).optional().describe('z. B. Zustand der Verpackung'),
    }),
    formdata: (fd) => ({ vermerk: String(fd.get('vermerk') ?? '').trim() || undefined }),
    revalidate: ['/reparatur/:id', '/reparatur', '/lager/zulauf'],
  },

  'reparatur.rueckversand_label': {
    label: 'Rückgabe an den Kunden',
    bereich: 'reparatur',
    beschreibung:
      'Erstellt das DHL-Versandlabel zum Kunden (Referenz = RMA-Nummer, mit Sendungsverfolgung) ' +
      'und setzt den Auftrag auf „versendet". Mit ohne_label: Abholung oder Eigenversand ohne ' +
      'DHL — der Auftrag ist trotzdem abgeschlossen.',
    bindung: 'beleg',
    modell: 'repair_order',
    uebergang: { von: ['repaired'], nach: ['shipped'] },
    schema: z.object({
      weight_g: z.number().positive().optional().describe('Paketgewicht in Gramm (leer = Produktgewicht)'),
      dhl_product: z.string().max(20).optional().describe('DHL-Produkt (leer = nach Land)'),
      ohne_label: z.boolean().default(false).describe('Abholung/Eigenversand — kein DHL-Label'),
      vermerk: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) => (p.ohne_label ? 'ohne Label (Abholung/Eigenversand)' : 'DHL-Label an den Kunden'),
    formdata: (fd) => ({
      weight_g: Number(fd.get('weight_g') ?? 0) || undefined,
      dhl_product: String(fd.get('dhl_product') ?? '').trim() || undefined,
      ohne_label: fd.get('ohne_label') === 'on' || fd.get('ohne_label') === 'true',
      vermerk: String(fd.get('vermerk') ?? '').trim() || undefined,
    }),
    revalidate: ['/reparatur/:id', '/reparatur', '/versand'],
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
