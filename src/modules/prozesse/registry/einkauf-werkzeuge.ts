import { z } from 'zod'
import { zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import { EIGENTUEMER_NAMEN, WERKZEUG_ART_NAMEN, WERKZEUG_STATUS_NAMEN } from '../../einkauf/werkzeuge.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 4 (0107): Werkzeuge und Formen beim Lieferanten (WZ/…).
 * Betriebsmittel, kein Ablauf — alle Aktionen sind prozessfrei, der Status
 * (in Auftrag, aktiv, gesperrt, ausgemustert) ist die einzige Wahrheit
 * (wie bei den Mail-Threads, 0093). Bestellt ein Einkaufsprojekt
 * Werkzeugkosten, entsteht der Datensatz beim Bestellen von selbst.
 */

const uuid = z.string().uuid()
const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined
/** Feld vorhanden → Text (auch leer, zum Löschen); fehlt → unverändert. */
const optionalLeer = (fd: FormData, feld: string) => (fd.has(feld) ? String(fd.get(feld) ?? '').trim() : undefined)
const zahl = (fd: FormData, feld: string, art: 'menge' | 'preis' = 'preis') => {
  const roh = String(fd.get(feld) ?? '').trim()
  if (!roh) return undefined
  return zahlLesen(roh, art) ?? Number.NaN
}

const betrag = z.number({ invalid_type_error: 'Bitte einen Betrag angeben' }).nonnegative('Nicht negativ')
const schuss = z.number({ invalid_type_error: 'Bitte eine ganze Zahl angeben' }).int('Schüsse als ganze Zahl')

export const EINKAUF_WERKZEUGE = {
  'einkauf.werkzeug_anlegen': {
    label: 'Werkzeug anlegen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt ein Werkzeug bzw. eine Form an (WZ/…): Bezeichnung, Art (Form, Stanz-/Schneidwerkzeug, ' +
      'Vorrichtung), Standort-Lieferant, Eigentümer (wir/Lieferant), Kosten und Währung, ' +
      'Werkzeugkosten-Zeile der Bestellung (dann kommen Lieferant, Kosten und Projekt daher), ' +
      'Einkaufsprojekt, Artikel (SKU/Name/ID), Schuss-Lebensdauer, Zählerstand, Status.',
    bindung: 'frei',
    modell: 'werkzeug',
    schema: z
      .object({
        bezeichnung: z.string().trim().min(1, 'Bitte eine Bezeichnung angeben').max(200),
        art: z.enum(WERKZEUG_ART_NAMEN).default('form'),
        partner_id: uuid.optional().describe('Lieferant, bei dem das Werkzeug steht'),
        eigentuemer: z.enum(EIGENTUEMER_NAMEN).default('wir'),
        kosten: betrag.optional(),
        waehrung: z.string().trim().toUpperCase().length(3, 'Währung als ISO-Code, z. B. CNY').optional(),
        purchase_order_line_id: uuid.optional().describe('Werkzeugkosten-Zeile einer Bestellung'),
        einkaufsprojekt_id: uuid.optional().describe('Einkaufsprojekt'),
        produkt: z.string().trim().min(1).optional().describe('Artikel, der damit gefertigt wird (SKU, Name oder ID)'),
        lebensdauer_schuss: schuss.positive('Die Lebensdauer muss größer als 0 sein').optional()
          .describe('Lebensdauer in Schuss (Herstellerangabe)'),
        schuss_zaehler: schuss.min(0, 'Nicht negativ').default(0).describe('Zählerstand bei Anlage'),
        status: z.enum(WERKZEUG_STATUS_NAMEN).default('in_auftrag'),
        notiz: z.string().trim().max(2000).optional(),
      })
      .refine((p) => p.partner_id || p.purchase_order_line_id, {
        message: 'Bitte den Lieferanten angeben, bei dem das Werkzeug steht.',
        path: ['partner_id'],
      }),
    zusammenfassung: (p) => `Werkzeug „${p.bezeichnung}" anlegen`,
    formdata: (fd) => ({
      bezeichnung: String(fd.get('bezeichnung') ?? ''),
      art: leer(fd, 'art') as never,
      partner_id: leer(fd, 'partner_id'),
      eigentuemer: leer(fd, 'eigentuemer') as never,
      kosten: zahl(fd, 'kosten'),
      waehrung: leer(fd, 'waehrung'),
      purchase_order_line_id: leer(fd, 'purchase_order_line_id'),
      einkaufsprojekt_id: leer(fd, 'einkaufsprojekt_id'),
      produkt: leer(fd, 'produkt'),
      lebensdauer_schuss: zahl(fd, 'lebensdauer_schuss', 'menge'),
      schuss_zaehler: zahl(fd, 'schuss_zaehler', 'menge') ?? 0,
      status: leer(fd, 'status') as never,
      notiz: leer(fd, 'notiz'),
    }),
    revalidate: ['/einkauf/werkzeuge'],
  },

  'einkauf.werkzeug_aendern': {
    label: 'Werkzeug bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ändert Stammdaten eines Werkzeugs: Bezeichnung, Art, Standort-Lieferant, Eigentümer, Kosten, ' +
      'Währung, Lebensdauer, Projekt, Artikel, Bestellzeile, Notiz (leerer Text löst Projekt, Artikel ' +
      'bzw. Bestellzeile). Status und Zähler haben eigene Aktionen.',
    bindung: 'beleg',
    modell: 'werkzeug',
    schema: z.object({
      bezeichnung: z.string().trim().min(1).max(200).optional(),
      art: z.enum(WERKZEUG_ART_NAMEN).optional(),
      partner_id: uuid.optional(),
      eigentuemer: z.enum(EIGENTUEMER_NAMEN).optional(),
      kosten: betrag.optional(),
      waehrung: z.string().trim().toUpperCase().length(3).optional(),
      lebensdauer_schuss: schuss.positive().optional(),
      einkaufsprojekt_id: z.union([uuid, z.literal('')]).optional(),
      produkt: z.string().trim().optional(),
      purchase_order_line_id: z.union([uuid, z.literal('')]).optional(),
      notiz: z.string().trim().max(2000).optional(),
    }),
    zusammenfassung: () => 'Werkzeug bearbeiten',
    formdata: (fd) => ({
      bezeichnung: leer(fd, 'bezeichnung'),
      art: leer(fd, 'art') as never,
      partner_id: leer(fd, 'partner_id'),
      eigentuemer: leer(fd, 'eigentuemer') as never,
      kosten: zahl(fd, 'kosten'),
      waehrung: leer(fd, 'waehrung'),
      lebensdauer_schuss: zahl(fd, 'lebensdauer_schuss', 'menge'),
      einkaufsprojekt_id: optionalLeer(fd, 'einkaufsprojekt_id'),
      // Leer = unverändert (der Name eines Artikels mit Varianten wäre mehrdeutig); lösen nur per JSON ('').
      produkt: leer(fd, 'produkt'),
      purchase_order_line_id: optionalLeer(fd, 'purchase_order_line_id'),
      notiz: optionalLeer(fd, 'notiz'),
    }),
    revalidate: ['/einkauf/werkzeuge/:id', '/einkauf/werkzeuge'],
  },

  'einkauf.werkzeug_status_setzen': {
    label: 'Werkzeug-Status setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Setzt den Status eines Werkzeugs: in Auftrag, aktiv (in Betrieb), gesperrt (mit Grund, z. B. ' +
      'Reparatur) oder ausgemustert (endgültig, mit Grund).',
    bindung: 'beleg',
    modell: 'werkzeug',
    schema: z
      .object({
        status: z.enum(WERKZEUG_STATUS_NAMEN),
        grund: z.string().trim().max(500).optional(),
      })
      .refine((p) => !['gesperrt', 'ausgemustert'].includes(p.status) || Boolean(p.grund), {
        message: 'Bitte einen Grund angeben.',
        path: ['grund'],
      }),
    zusammenfassung: (p) => `Werkzeug-Status: ${p.status}${p.grund ? ` (${p.grund})` : ''}`,
    formdata: (fd) => ({ status: String(fd.get('status') ?? '') as never, grund: leer(fd, 'grund') }),
    revalidate: ['/einkauf/werkzeuge/:id', '/einkauf/werkzeuge'],
  },

  'einkauf.werkzeug_schuss_buchen': {
    label: 'Schüsse buchen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Bucht Schüsse auf den Zähler eines Werkzeugs (z. B. laut Lieferant je Produktionslos); negative ' +
      'Anzahl korrigiert, nie unter 0. Ab 90 % der Lebensdauer erscheint eine Wiedervorlage.',
    bindung: 'beleg',
    modell: 'werkzeug',
    schema: z.object({
      anzahl: schuss.refine((n) => n !== 0, 'Bitte eine Anzahl ungleich 0 angeben.').describe('Schüsse (negativ = Korrektur)'),
      notiz: z.string().trim().max(500).optional().describe('z. B. Los, Bestellung oder Quelle der Angabe'),
    }),
    zusammenfassung: (p) => `${p.anzahl > 0 ? '+' : ''}${p.anzahl} Schuss buchen`,
    formdata: (fd) => ({ anzahl: zahl(fd, 'anzahl', 'menge'), notiz: leer(fd, 'notiz') }),
    revalidate: ['/einkauf/werkzeuge/:id', '/einkauf/werkzeuge'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
