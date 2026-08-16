import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Lagerbereichs — der Härtetest der Registry, weil hier die
 * längste Prozesskette des Hauses liegt (Warenausgang: Lose zuordnen →
 * buchen → Kartonage verbrauchen → Shopify-Meldung einreihen).
 */

/** Mengen je Bewegung (moveId → Ist-Menge); leer = Vorgabemenge gilt. */
const mengenSchema = z.record(z.string(), z.number().nonnegative())

export const LAGER = {
  'lager.transfer_buchen': {
    label: 'Buchen',
    bereich: 'lager',
    beschreibung:
      'Validiert einen Transfer (Warenein-/-ausgang): bucht Ist-Mengen und Lose, ' +
      'legt bei Restmengen einen Rückstandstransfer an, verbraucht die Kartonage ' +
      'der Sendung und reiht die Shopify-Fulfillment-Meldung ein.',
    bindung: 'beleg',
    modell: 'stock_picking',
    uebergang: { von: ['assigned', 'confirmed'], nach: ['done'] },
    schema: z.object({
      mengen: mengenSchema.default({}),
      /** Roh-Loseingabe je Bewegung ("SN-1, SN-2" bzw. "CHARGE-A:10") — aufgelöst wird in der Ausführung. */
      lose: z.record(z.string(), z.string()).default({}),
      backorder: z.boolean().default(true),
    }),
    formdata: (fd) => {
      const mengen: Record<string, number> = {}
      const lose: Record<string, string> = {}
      for (const [key, value] of fd.entries()) {
        if (typeof value !== 'string') continue
        if (key.startsWith('done_') && value.trim() !== '') {
          const n = Number(value.trim())
          if (Number.isFinite(n) && n >= 0) mengen[key.slice(5)] = n
        }
        if (key.startsWith('lots_') && value.trim() !== '') lose[key.slice(5)] = value
      }
      return { mengen, lose, backorder: fd.get('backorder') !== 'no' }
    },
    revalidate: ['/lager/:id', '/lager', '/versand'],
  },

  'lager.transfer_bestaetigen': {
    label: 'Bestätigen',
    bereich: 'lager',
    beschreibung: 'Bestätigt einen Transfer-Entwurf und reserviert je Vorgangsart.',
    bindung: 'beleg',
    // Verwaltung: Entwurfs-Transfers entstehen manuell außerhalb der Belegprozesse.
    prozessfrei: true,
    modell: 'stock_picking',
    uebergang: { von: ['draft'], nach: ['confirmed', 'assigned'] },
    schema: z.object({}),
    revalidate: ['/lager/:id'],
  },

  'lager.verfuegbarkeit_pruefen': {
    label: 'Verfügbarkeit prüfen',
    bereich: 'lager',
    beschreibung: 'Reserviert erneut — holt inzwischen eingetroffenen Bestand in den Transfer.',
    bindung: 'beleg',
    modell: 'stock_picking',
    uebergang: { von: ['confirmed', 'assigned'], nach: ['confirmed', 'assigned'] },
    schema: z.object({}),
    revalidate: ['/lager/:id'],
  },

  'lager.transfer_stornieren': {
    label: 'Stornieren',
    bereich: 'lager',
    beschreibung: 'Storniert einen nicht erledigten Transfer samt Bewegungen.',
    bindung: 'beleg',
    // Korrektur: der Abbruch außerhalb des Happy Path (siehe UNABGEBILDET cancel).
    prozessfrei: true,
    modell: 'stock_picking',
    uebergang: { von: ['draft', 'waiting', 'confirmed', 'assigned'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/lager/:id', '/lager'],
  },

  'lager.transfer_retoure': {
    label: 'Retoure anlegen',
    bereich: 'lager',
    beschreibung: 'Legt zu einem erledigten Transfer die Rückführung an (Orte getauscht).',
    bindung: 'beleg',
    // Korrektur/RMA: Rückführung eines erledigten Transfers, kein Vorwärts-Schritt.
    prozessfrei: true,
    modell: 'stock_picking',
    uebergang: { von: ['done'], nach: ['done'] },
    schema: z.object({}),
    revalidate: ['/lager', '/lager/:ergebnis'],
  },

  'lager.transfer_details': {
    label: 'Verantwortlichen/Priorität setzen',
    bereich: 'lager',
    beschreibung: 'Setzt Verantwortlichen und Priorität eines Transfers.',
    bindung: 'beleg',
    modell: 'stock_picking',
    prozessfrei: true,
    schema: z.object({
      user_id: z.string().optional(),
      priority: z.boolean().default(false),
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      priority: fd.get('priority') === 'on',
    }),
    revalidate: ['/lager/:id'],
  },

  // --- Inventur ------------------------------------------------------------

  'lager.zaehlung_erfassen': {
    label: 'Zählung erfassen',
    bereich: 'lager',
    beschreibung: 'Erfasst eine Inventurzählung (Buchbestand wird festgehalten).',
    bindung: 'frei',
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      counted_qty: z.number().nonnegative('Bitte eine gültige Menge erfassen'),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      counted_qty: Number(fd.get('counted_qty') ?? NaN),
    }),
    revalidate: ['/lager/inventur'],
  },

  'lager.zaehlung_buchen': {
    label: 'Differenz buchen',
    bereich: 'lager',
    beschreibung: 'Wendet eine Zählung an: bucht die Differenz gegen den Inventur-Ort.',
    bindung: 'beleg',
    modell: 'inventory_count',
    schema: z.object({}),
    revalidate: ['/lager/inventur', '/lager/bestand'],
  },

  'lager.zaehlung_loeschen': {
    label: 'Zählung löschen',
    bereich: 'lager',
    beschreibung: 'Löscht eine noch nicht angewandte Zählung.',
    bindung: 'beleg',
    modell: 'inventory_count',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager/inventur'],
  },

  'lager.ausschuss_buchen': {
    label: 'Ausschuss buchen',
    bereich: 'lager',
    beschreibung: 'Bucht Ausschuss vom Hauptlager auf den Ausschuss-Ort.',
    bindung: 'frei',
    // Bestandskorrektur in einem Zug — für einen Assistenten zu klein.
    prozessfrei: true,
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
      reason: z.string().max(300).optional(),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
      reason: String(fd.get('reason') ?? '').trim() || undefined,
    }),
    revalidate: ['/lager/bestand'],
  },

  // --- Meldebestände -------------------------------------------------------

  'lager.meldebestand_anlegen': {
    label: 'Meldebestand anlegen',
    bereich: 'lager',
    ki: true,
    beschreibung: 'Legt eine Nachbestellregel an (min/max, Losgröße, Route).',
    bindung: 'frei',
    schema: z
      .object({
        variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
        min_qty: z.number().nonnegative(),
        max_qty: z.number().nonnegative(),
        qty_multiple: z.number().positive().default(1),
        route: z.enum(['buy', 'manufacture']).optional(),
      })
      .refine((p) => p.max_qty >= p.min_qty, {
        message: 'Der Maximalbestand darf den Mindestbestand nicht unterschreiten',
        path: ['max_qty'],
      }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      min_qty: Number(fd.get('min_qty') ?? 0),
      max_qty: Number(fd.get('max_qty') ?? 0),
      qty_multiple: Number(fd.get('qty_multiple') ?? 1) || 1,
      route: String(fd.get('route') ?? '') || undefined,
    }),
    revalidate: ['/lager/beschaffung'],
  },

  'lager.meldebestand_loeschen': {
    label: 'Meldebestand löschen',
    bereich: 'lager',
    beschreibung: 'Entfernt eine Nachbestellregel.',
    bindung: 'beleg',
    modell: 'stock_orderpoint',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager/beschaffung'],
  },

  'lager.meldebestand_schlummern': {
    label: 'Schlummern',
    bereich: 'lager',
    beschreibung: 'Schaltet einen Beschaffungsvorschlag für einige Tage stumm.',
    bindung: 'beleg',
    modell: 'stock_orderpoint',
    prozessfrei: true,
    schema: z.object({ tage: z.number().int().positive().max(365) }),
    revalidate: ['/lager/beschaffung'],
  },

  'lager.meldebestand_wecken': {
    label: 'Schlummern beenden',
    bereich: 'lager',
    beschreibung: 'Beendet das Schlummern einer Nachbestellregel.',
    bindung: 'beleg',
    modell: 'stock_orderpoint',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager/beschaffung'],
  },

  'lager.beschaffung_ausfuehren': {
    label: 'Beschaffen',
    bereich: 'lager',
    beschreibung:
      'Führt einen Beschaffungsvorschlag aus: Position in eine Entwurfs-Bestellung ' +
      'aufnehmen oder einen Fertigungsauftrag anlegen und bestätigen.',
    bindung: 'beleg',
    // Alternativer EINSTIEG in Einkauf/Fertigung: erzeugt deren Startbelege.
    prozessfrei: true,
    modell: 'stock_orderpoint',
    schema: z.object({}),
    revalidate: ['/lager/beschaffung', '/einkauf', '/fertigung'],
  },

  // --- Bewertung -----------------------------------------------------------

  'lager.eroeffnungsbewertung': {
    label: 'Eröffnungsbewertung',
    bereich: 'lager',
    beschreibung:
      'Bewertet Altbestand aus der Zeit vor der Wertschicht zum hinterlegten Einstandspreis.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager/bewertung', '/auswertungen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
