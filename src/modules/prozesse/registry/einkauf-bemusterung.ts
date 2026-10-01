import { z } from 'zod'
import { MUSTER_ERGEBNIS_NAMEN } from '../../einkauf/bemusterung.ts'
import { zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 4 (0107): Bemusterung — je Muster-Runde ein Beleg mit
 * eigenem Prozess `bemusterung`: anfordern → Eingang erfassen → freigeben
 * (Golden Sample) | nachbessern (die nächste Runde startet von selbst) |
 * ablehnen. Das Einkaufsprojekt führt die Runden als Teilprozess; mit
 * Musterpflicht wird ohne Golden Sample des gewählten Lieferanten nicht
 * bestellt (Trigger in der Datenbank).
 *
 * Bewerten ist bewusst NICHT `ki` — der Agent (Stufe 6) bereitet vor, über
 * die Freigabe der Serie entscheidet ein Mensch. Daten nachtragen
 * (Kosten, Tracking) ist Arbeit an der Runde und prozessfrei.
 */

const uuid = z.string().uuid()
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined
const zahl = (fd: FormData, feld: string, art: 'menge' | 'preis' = 'preis') => {
  const roh = String(fd.get(feld) ?? '').trim()
  if (!roh) return undefined
  return zahlLesen(roh, art) ?? Number.NaN
}

const musterFelder = {
  bezeichnung: z.string().trim().max(200).optional().describe('Was bemustert wird, z. B. „Farbmuster Pantone 7621C"'),
  revision: z.string().trim().max(40).optional().describe('Revision/Stand des Musters (A, B, 2 …)'),
  menge: z.number({ invalid_type_error: 'Bitte eine Menge angeben' }).positive('Die Menge muss größer als 0 sein').optional(),
  kosten: z.number({ invalid_type_error: 'Bitte einen Betrag angeben' }).nonnegative('Nicht negativ').optional()
    .describe('Musterkosten in der Währung der Runde'),
  waehrung: z.string().trim().toUpperCase().length(3, 'Währung als ISO-Code, z. B. USD').optional(),
  bestellt_am: datum.optional().describe('Angefordert am (ohne Angabe: heute)'),
  tracking: z.string().trim().max(300).optional().describe('Sendungsnummer oder Verfolgungslink'),
  notiz: z.string().trim().max(2000).optional(),
}

const musterAusFormular = (fd: FormData) => ({
  bezeichnung: leer(fd, 'bezeichnung'),
  revision: leer(fd, 'revision'),
  menge: zahl(fd, 'menge', 'menge'),
  kosten: zahl(fd, 'kosten'),
  waehrung: leer(fd, 'waehrung'),
  bestellt_am: leer(fd, 'bestellt_am'),
  tracking: leer(fd, 'tracking'),
  notiz: leer(fd, 'notiz'),
})

export const EINKAUF_BEMUSTERUNG = {
  'einkauf.muster_anfordern': {
    label: 'Muster anfordern',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Legt eine Muster-Runde zu einem Einkaufsprojekt und Lieferanten an (Runde 1, 2 … je Lieferant): ' +
      'Bezeichnung, Revision, Menge, Kosten und Währung (ohne Angabe aus dem Angebot), angefordert am, ' +
      'Tracking. Bewertet wird nach dem Eingang (Golden Sample, nachbessern, ablehnen).',
    bindung: 'frei',
    modell: 'bemusterung',
    uebergang: { von: [], nach: ['offen'] },
    schema: z.object({
      projekt_id: uuid.describe('Einkaufsprojekt'),
      partner_id: uuid,
      angebot_id: uuid.optional().describe('Angebot des Lieferanten (ohne Angabe: sein jüngstes im Projekt)'),
      ...musterFelder,
    }),
    zusammenfassung: (p) => `Muster anfordern${p.bezeichnung ? `: ${p.bezeichnung}` : ''}${p.revision ? ` (Rev. ${p.revision})` : ''}`,
    formdata: (fd) => ({
      projekt_id: String(fd.get('projekt_id') ?? ''),
      partner_id: String(fd.get('partner_id') ?? ''),
      angebot_id: leer(fd, 'angebot_id'),
      ...musterAusFormular(fd),
    }),
    revalidate: ['/einkauf/muster', '/einkauf/projekte'],
  },

  'einkauf.muster_erhalten': {
    label: 'Eingang erfassen',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Erfasst den Eingang eines Musters (Datum, ohne Angabe heute; optional Tracking und Notiz).',
    bindung: 'beleg',
    modell: 'bemusterung',
    schema: z.object({
      erhalten_am: datum.optional().describe('Eingegangen am (ohne Angabe: heute)'),
      tracking: musterFelder.tracking,
      notiz: musterFelder.notiz,
    }),
    zusammenfassung: (p) => `Muster eingegangen${p.erhalten_am ? ` am ${p.erhalten_am}` : ''}`,
    formdata: (fd) => ({ erhalten_am: leer(fd, 'erhalten_am'), tracking: leer(fd, 'tracking'), notiz: leer(fd, 'notiz') }),
    revalidate: ['/einkauf/muster/:id', '/einkauf/muster'],
  },

  'einkauf.muster_bewerten': {
    label: 'Muster bewerten',
    bereich: 'einkauf',
    beschreibung:
      'Bewertet eine Muster-Runde: freigeben (mit golden = Golden Sample, die Referenz für die Serie — ' +
      'ein neues ersetzt das alte desselben Lieferanten), nachbessern lassen (die nächste Runde wird ' +
      'angelegt) oder ablehnen. Nachbessern und Ablehnen brauchen einen Befund.',
    bindung: 'beleg',
    modell: 'bemusterung',
    uebergang: { von: ['offen'], nach: ['freigegeben', 'nachbessern', 'abgelehnt'] },
    schema: z
      .object({
        ergebnis: z.enum(MUSTER_ERGEBNIS_NAMEN),
        golden: z.boolean().default(true).describe('Als Golden Sample (Referenz für die Serie) freigeben'),
        note: z.number().int('Note als ganze Zahl').min(1).max(5).optional().describe('Note 1–5 (5 = einwandfrei)'),
        bewertung: z.string().trim().max(2000).optional().describe('Befund / Begründung (geht in die Rückmeldung)'),
        naechste_revision: z.string().trim().max(40).optional().describe('Revision der nächsten Runde (nur beim Nachbessern)'),
      })
      .refine((p) => p.ergebnis === 'freigeben' || Boolean(p.bewertung), {
        message: 'Bitte den Befund angeben — der Lieferant muss wissen, was nicht passt.',
        path: ['bewertung'],
      }),
    zusammenfassung: (p) => `Muster ${p.ergebnis === 'freigeben' ? (p.golden ? 'als Golden Sample freigeben' : 'freigeben') : p.ergebnis}`,
    formdata: (fd) => ({
      ergebnis: String(fd.get('ergebnis') ?? '') as never,
      golden: fd.has('golden_feld') ? fd.get('golden') === 'on' : undefined,
      note: zahl(fd, 'note', 'menge'),
      bewertung: leer(fd, 'bewertung'),
      naechste_revision: leer(fd, 'naechste_revision'),
    }),
    revalidate: ['/einkauf/muster/:id', '/einkauf/muster'],
  },

  'einkauf.muster_aendern': {
    label: 'Muster-Runde bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Trägt Daten einer Muster-Runde nach oder korrigiert sie: Bezeichnung, Revision, Menge, Kosten, ' +
      'Währung, angefordert am, eingegangen am, Tracking, Notiz.',
    bindung: 'beleg',
    modell: 'bemusterung',
    schema: z.object({ ...musterFelder, erhalten_am: datum.optional() }),
    zusammenfassung: () => 'Muster-Runde bearbeiten',
    formdata: (fd) => ({ ...musterAusFormular(fd), erhalten_am: leer(fd, 'erhalten_am') }),
    revalidate: ['/einkauf/muster/:id', '/einkauf/muster'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
