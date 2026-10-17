import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'
import { plural } from '../../shared/format.ts'

/**
 * Retouren (0119, Entscheidungslog 2026-10-17): Rücksendung gelieferter
 * Shop-Ware als Prozess auf dem Beleg `retoure`. Bereich Versand, weil
 * Eingang und Prüfung am Lager passieren (Rolle Lager schreibt Versand).
 * Die Erstattung bleibt im Shopify-Admin — KRNL erkennt sie am Bestell-
 * Webhook und schließt die Retoure dann selbst ab.
 */

const PRUEFUNG = z.enum(['verkaufsfaehig', 'bware', 'defekt'])

export const VERSAND_RETOURE = {
  'versand.retoure_anlegen': {
    label: 'Retoure anlegen',
    bereich: 'versand',
    beschreibung:
      'Legt zu einem gelieferten Shop-Auftrag eine Retoure an (wie eine Anfrage aus dem Portal, z. B. nach ' +
      'Mail oder Telefon): Positionen mit Menge — höchstens die gelieferte Menge abzüglich offener Retouren — ' +
      'und Grund. Beleg = der Verkaufsauftrag; die Retoure steht danach auf „angefragt".',
    bindung: 'beleg',
    modell: 'sales_order',
    schema: z.object({
      positionen: z
        .array(
          z.object({
            zeile: z.string().uuid(),
            menge: z.number().positive(),
            grund: z.string().max(300).optional(),
          }),
        )
        .min(1, 'Bitte mindestens eine Position mit Menge angeben'),
      grund: z.string().max(1000).optional().describe('Anliegen des Kunden'),
      email: z.string().email().max(200).optional().describe('Antwortadresse, sonst die der Bestellung'),
    }),
    formdata: (fd) => {
      const positionen: { zeile: string; menge: number; grund?: string }[] = []
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith('menge_') || typeof value !== 'string' || value.trim() === '') continue
        const menge = Number(value.replace(',', '.'))
        if (!Number.isFinite(menge) || menge <= 0) continue
        const zeile = key.slice(6)
        const grund = String(fd.get(`grund_${zeile}`) ?? '').trim()
        positionen.push({ zeile, menge, ...(grund ? { grund } : {}) })
      }
      return {
        positionen,
        grund: String(fd.get('grund') ?? '').trim() || undefined,
        email: String(fd.get('email') ?? '').trim() || undefined,
      }
    },
    zusammenfassung: (p) => `Retoure über ${plural(p.positionen.length, 'Position', 'Positionen')}`,
    revalidate: ['/versand/retouren', '/verkauf/:id'],
  },

  'versand.retoure_genehmigen': {
    label: 'Genehmigen + Retourenlabel',
    bereich: 'versand',
    beschreibung:
      'Genehmigt die Retoure und mailt — wenn gewünscht und DHL konfiguriert — sofort das DHL-Retourenlabel ' +
      'mit der Retourennummer als Referenz an die Lieferadresse der Bestellung. Scheitert das Label, bleibt ' +
      'die Retoure genehmigt und das Label lässt sich am Beleg erneut senden.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['angefragt'], nach: ['genehmigt'] },
    schema: z.object({
      label_senden: z.boolean().default(true).describe('Retourenlabel sofort mailen (braucht DHL)'),
    }),
    formdata: (fd) => ({ label_senden: fd.get('label_senden') === 'on' || fd.get('label_senden') === 'true' }),
    zusammenfassung: (p) => `Genehmigen${p.label_senden ? ' + Retourenlabel' : ''}`,
    revalidate: ['/versand/retouren/:id', '/versand/retouren', '/lager/zulauf'],
  },

  'versand.retoure_ablehnen': {
    label: 'Ablehnen',
    bereich: 'versand',
    beschreibung:
      'Lehnt die Retoure mit Begründung ab (z. B. Frist abgelaufen, Sonderanfertigung) und schreibt dem ' +
      'Kunden auf Wunsch eine Mail mit der Begründung.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['angefragt'], nach: ['abgelehnt'] },
    schema: z.object({
      grund: z.string().trim().min(3, 'Bitte kurz begründen').max(1000),
      mail: z.boolean().default(true).describe('Begründung an den Kunden mailen'),
    }),
    formdata: (fd) => ({
      grund: String(fd.get('grund') ?? ''),
      mail: fd.get('mail') === 'on' || fd.get('mail') === 'true',
    }),
    revalidate: ['/versand/retouren/:id', '/versand/retouren'],
  },

  'versand.retoure_label_senden': {
    label: 'Retourenlabel senden',
    bereich: 'versand',
    beschreibung:
      'Erzeugt (erneut) das DHL-Retourenlabel zur genehmigten Retoure — Referenz die Retourennummer, Absender ' +
      'die Lieferadresse der Bestellung — und mailt es dem Kunden.',
    bindung: 'beleg',
    modell: 'retoure',
    // Werkzeug am genehmigten Beleg — der Zustand bleibt „genehmigt".
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/versand/retouren/:id', '/versand/retouren', '/lager/zulauf'],
  },

  'versand.retoure_eingang': {
    label: 'Ware eingegangen',
    bereich: 'versand',
    beschreibung:
      'Das Paket ist da (Scan der Retouren-Sendungsnummer oder der Retourennummer öffnet diesen Schritt). ' +
      'Noch keine Bestandsbuchung — gebucht wird mit der Prüfung.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['angefragt', 'genehmigt'], nach: ['eingegangen'] },
    schema: z.object({}),
    revalidate: ['/versand/retouren/:id', '/versand/retouren', '/lager/zulauf'],
  },

  'versand.retoure_pruefen': {
    label: 'Prüfen und zurückbuchen',
    bereich: 'versand',
    beschreibung:
      'Ergebnis je Position: verkaufsfähig (zurück ins Lager WH/Stock — sofort wieder verkaufbar und für ' +
      'wartende Lieferungen reserviert), B-Ware oder defekt (nach WH/B-Ware, nur markiert, zählt nirgends). ' +
      'Bucht den Rück-Transfer. Hat der Shop schon erstattet, ist die Retoure damit abgeschlossen.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['eingegangen'], nach: ['geprueft', 'abgeschlossen'] },
    schema: z.object({
      ergebnisse: z
        .array(z.object({ position: z.string().uuid(), pruefung: PRUEFUNG, notiz: z.string().max(500).optional() }))
        .min(1, 'Bitte jede Position prüfen'),
    }),
    formdata: (fd) => {
      const ergebnisse: { position: string; pruefung: string; notiz?: string }[] = []
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith('pruefung_') || typeof value !== 'string' || !value) continue
        const position = key.slice(9)
        const notiz = String(fd.get(`notiz_${position}`) ?? '').trim()
        ergebnisse.push({ position, pruefung: value, ...(notiz ? { notiz } : {}) })
      }
      return { ergebnisse }
    },
    zusammenfassung: (p) => {
      const n = (w: string) => p.ergebnisse.filter((e: { pruefung: string }) => e.pruefung === w).length
      return `Prüfung: ${n('verkaufsfaehig')} verkaufsfähig, ${n('bware')} B-Ware, ${n('defekt')} defekt`
    },
    revalidate: ['/versand/retouren/:id', '/versand/retouren', '/lager', '/fertigung'],
  },

  'versand.retoure_abschliessen': {
    label: 'Abschließen (Erstattung bestätigt)',
    bereich: 'versand',
    beschreibung:
      'Schließt eine geprüfte Retoure ab — normalerweise von selbst, sobald der Shop erstattet hat; von Hand ' +
      'nur mit Bestätigung, dass im Shopify-Admin erstattet wurde. Nicht begonnene Fertigung, deren Lieferung ' +
      'der verkaufsfähige Rückläufer jetzt deckt, entfällt; das Team Fertigung bekommt eine Aufgabe.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['geprueft'], nach: ['abgeschlossen'] },
    schema: z.object({
      erstattung_bestaetigt: z
        .boolean()
        .refine((v) => v, 'Bitte bestätigen, dass im Shop erstattet wurde'),
    }),
    formdata: (fd) => ({
      erstattung_bestaetigt: fd.get('erstattung_bestaetigt') === 'on' || fd.get('erstattung_bestaetigt') === 'true',
    }),
    revalidate: ['/versand/retouren/:id', '/versand/retouren', '/fertigung'],
  },

  'versand.retoure_stornieren': {
    label: 'Stornieren',
    bereich: 'versand',
    beschreibung: 'Der Kunde zieht die Retoure zurück, bevor Ware eingegangen ist.',
    bindung: 'beleg',
    modell: 'retoure',
    uebergang: { von: ['angefragt', 'genehmigt'], nach: ['storniert'] },
    schema: z.object({ grund: z.string().max(300).optional() }),
    formdata: (fd) => ({ grund: String(fd.get('grund') ?? '').trim() || undefined }),
    revalidate: ['/versand/retouren/:id', '/versand/retouren'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
