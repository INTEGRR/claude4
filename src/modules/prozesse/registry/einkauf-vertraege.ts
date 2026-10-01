import { z } from 'zod'
import { zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import { VERTRAG_ART_NAMEN, VERTRAG_STATUS_NAMEN } from '../../einkauf/lieferantenvertraege.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 4 (0107): Lieferantenverträge — NDA, QSV, Rahmenvertrag,
 * Preisliste. Ein Register mit Laufzeit, Kündigungsfrist, Verlängerung und
 * Erinnerungsvorlauf; die Datei hängt als Dokument am Vertrag. Prozessfrei
 * (kein Ablauf, der Status ist die Wahrheit). Ablaufende Verträge erscheinen
 * als regelbasierte Wiedervorlage (Sicht einkauf_regel_wiedervorlagen).
 * Eine Preisliste erzeugt Lieferantenpreise mit der Gültigkeit des Vertrags.
 *
 * Nicht verwechseln mit den Fixkosten-Verträgen der Finanzen
 * (`vertraege`, finanzen.vertrag_*).
 */

const uuid = z.string().uuid()
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
const leer = (fd: FormData, feld: string) => String(fd.get(feld) ?? '').trim() || undefined
const optionalLeer = (fd: FormData, feld: string) => (fd.has(feld) ? String(fd.get(feld) ?? '').trim() : undefined)
const zahl = (fd: FormData, feld: string) => {
  const roh = String(fd.get(feld) ?? '').trim()
  if (!roh) return undefined
  return zahlLesen(roh, 'menge') ?? Number.NaN
}

const monate = z.number({ invalid_type_error: 'Bitte eine Zahl angeben' }).int('Monate als ganze Zahl')
const tage = z.number({ invalid_type_error: 'Bitte eine Zahl angeben' }).int('Tage als ganze Zahl')

const preisZeile = z.object({
  produkt: z.string().trim().min(1).describe('SKU, Barcode, Name oder ID des Artikels'),
  ab_menge: z.number().positive('Menge muss größer als 0 sein').default(1),
  preis: z.number().nonnegative('Preis nicht negativ'),
})

export const EINKAUF_VERTRAEGE = {
  'einkauf.lieferantenvertrag_anlegen': {
    label: 'Lieferantenvertrag anlegen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Legt einen Vertrag mit einem Lieferanten an: Art (NDA, QSV, Rahmenvertrag, Preisliste), Titel, ' +
      'gültig von/bis (ohne Ende = unbefristet), Kündigungsfrist in Monaten, automatische Verlängerung ' +
      'in Monaten, Erinnerung in Tagen vor dem Stichtag (Standard 30), Währung der Preise. Die ' +
      'Vertragsdatei wird danach als Dokument angehängt.',
    bindung: 'frei',
    modell: 'lieferantenvertrag',
    schema: z
      .object({
        partner_id: uuid,
        art: z.enum(VERTRAG_ART_NAMEN),
        titel: z.string().trim().min(1, 'Bitte einen Titel angeben').max(200),
        gueltig_von: datum.optional(),
        gueltig_bis: datum.optional().describe('Laufzeitende (leer = unbefristet)'),
        kuendigungsfrist_monate: monate.min(0).max(36).default(0).describe('Kündigungsfrist in Monaten vor dem Ende'),
        verlaengerung_monate: monate.min(1).max(120).optional().describe('Verlängert sich ohne Kündigung um … Monate'),
        erinnerung_tage: tage.min(0).max(365).default(30).describe('Erinnerung … Tage vor dem Kündigungsstichtag'),
        waehrung: z.string().trim().toUpperCase().length(3, 'Währung als ISO-Code, z. B. USD').optional(),
        notiz: z.string().trim().max(4000).optional(),
      })
      .refine((p) => !p.gueltig_von || !p.gueltig_bis || p.gueltig_bis >= p.gueltig_von, {
        message: 'Das Ende liegt vor dem Beginn.',
        path: ['gueltig_bis'],
      }),
    zusammenfassung: (p) => `Lieferantenvertrag „${p.titel}" (${p.art}) anlegen`,
    formdata: (fd) => ({
      partner_id: String(fd.get('partner_id') ?? ''),
      art: String(fd.get('art') ?? '') as never,
      titel: String(fd.get('titel') ?? ''),
      gueltig_von: leer(fd, 'gueltig_von'),
      gueltig_bis: leer(fd, 'gueltig_bis'),
      kuendigungsfrist_monate: zahl(fd, 'kuendigungsfrist_monate') ?? 0,
      verlaengerung_monate: zahl(fd, 'verlaengerung_monate'),
      erinnerung_tage: zahl(fd, 'erinnerung_tage') ?? 30,
      waehrung: leer(fd, 'waehrung'),
      notiz: leer(fd, 'notiz'),
    }),
    revalidate: ['/einkauf/vertraege'],
  },

  'einkauf.lieferantenvertrag_aendern': {
    label: 'Lieferantenvertrag bearbeiten',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Ändert einen Lieferantenvertrag (Titel, Art, Laufzeit, Fristen, Erinnerung, Währung, Notiz; leerer ' +
      'Text löscht Ende bzw. Verlängerung). Lieferantenpreise aus dem Vertrag übernehmen die neue Gültigkeit.',
    bindung: 'beleg',
    modell: 'lieferantenvertrag',
    schema: z.object({
      titel: z.string().trim().min(1).max(200).optional(),
      art: z.enum(VERTRAG_ART_NAMEN).optional(),
      gueltig_von: z.union([datum, z.literal('')]).optional(),
      gueltig_bis: z.union([datum, z.literal('')]).optional(),
      kuendigungsfrist_monate: monate.min(0).max(36).optional(),
      verlaengerung_monate: z.union([monate.min(1).max(120), z.literal('')]).optional(),
      erinnerung_tage: tage.min(0).max(365).optional(),
      waehrung: z.string().trim().toUpperCase().length(3).optional(),
      notiz: z.string().trim().max(4000).optional(),
    }),
    zusammenfassung: () => 'Lieferantenvertrag bearbeiten',
    formdata: (fd) => {
      const verlaengerung = optionalLeer(fd, 'verlaengerung_monate')
      return {
        titel: leer(fd, 'titel'),
        art: leer(fd, 'art') as never,
        gueltig_von: optionalLeer(fd, 'gueltig_von'),
        gueltig_bis: optionalLeer(fd, 'gueltig_bis'),
        kuendigungsfrist_monate: zahl(fd, 'kuendigungsfrist_monate'),
        verlaengerung_monate: verlaengerung === '' ? '' : zahl(fd, 'verlaengerung_monate'),
        erinnerung_tage: zahl(fd, 'erinnerung_tage'),
        waehrung: leer(fd, 'waehrung'),
        notiz: optionalLeer(fd, 'notiz'),
      }
    },
    revalidate: ['/einkauf/vertraege/:id', '/einkauf/vertraege'],
  },

  'einkauf.lieferantenvertrag_status_setzen': {
    label: 'Vertragsstatus setzen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Hält fest, dass ein Lieferantenvertrag gekündigt (zum Laufzeitende, Datum der Kündigung) oder ' +
      'beendet ist (endet zum Datum, Preise aus dem Vertrag gelten bis dahin) — oder wieder aktiv. ' +
      'Danach verschwindet die Wiedervorlage.',
    bindung: 'beleg',
    modell: 'lieferantenvertrag',
    schema: z.object({
      status: z.enum(VERTRAG_STATUS_NAMEN),
      datum: datum.optional().describe('Gekündigt am bzw. beendet zum (ohne Angabe: heute)'),
      notiz: z.string().trim().max(500).optional(),
    }),
    zusammenfassung: (p) => `Vertragsstatus: ${p.status}${p.datum ? ` (${p.datum})` : ''}`,
    formdata: (fd) => ({ status: String(fd.get('status') ?? '') as never, datum: leer(fd, 'datum'), notiz: leer(fd, 'notiz') }),
    revalidate: ['/einkauf/vertraege/:id', '/einkauf/vertraege'],
  },

  'einkauf.preisliste_uebernehmen': {
    label: 'Preisliste übernehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    ki: true,
    beschreibung:
      'Erzeugt aus einer Preisliste bzw. einem Rahmenvertrag Lieferantenpreise mit der Gültigkeit des ' +
      'Vertrags (von/bis) in seiner Währung — als Zeilen „Artikel / ab Menge: Preis" (text) oder ' +
      'strukturiert (preise). Ersetzt alle Preise, die schon aus diesem Vertrag stammen; unlesbare ' +
      'Zeilen oder unbekannte Artikel verhindern die Übernahme.',
    bindung: 'beleg',
    modell: 'lieferantenvertrag',
    schema: z
      .object({
        text: z.string().max(200_000).optional().describe('Eine Zeile je Preis: „SKU / ab Menge: Preis"'),
        preise: z.array(preisZeile).max(5000).default([]),
        lieferzeit_tage: tage.min(0).max(730).optional().describe('Lieferzeit in Tagen für alle Preise'),
      })
      .refine((p) => Boolean(p.text?.trim()) || p.preise.length > 0, {
        message: 'Bitte mindestens eine Preiszeile angeben.',
        path: ['text'],
      }),
    zusammenfassung: (p) => `Preisliste übernehmen (${p.preise.length || (p.text ?? '').split('\n').filter((zeile: string) => zeile.trim()).length} Zeilen)`,
    formdata: (fd) => ({ text: String(fd.get('text') ?? ''), lieferzeit_tage: zahl(fd, 'lieferzeit_tage') }),
    revalidate: ['/einkauf/vertraege/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
