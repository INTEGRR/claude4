import { z } from 'zod'
import { zahlLesen } from '../../einkauf/einkaufsprojekt.ts'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Einkauf, Stufe 6 (0109): die menschliche Seite der Vorschläge des
 * Einkaufs-Agenten (`ki_vorschlaege`). Annehmen führt die vorgeschlagene
 * Registry-Aktion über den Torwächter aus — ALS der annehmende Mensch, mit
 * seinen Rechten, Schema- und Schrittprüfung wie bei jedem Klick; Ergebnis
 * oder Fehler stehen danach am Vorschlag. Verwerfen und Ändern sind Arbeit
 * am Vorschlag.
 *
 * Alle drei sind bewusst NICHT `ki`: der Agent nimmt nie selbst an (sonst
 * wäre der Vorschlag nur ein Umweg zum Selbstausführen). Prozessfrei wie
 * Mail-Threads — ein Vorschlag ist Arbeitsvorrat am Beleg, kein Ablauf.
 */

const ZAHL_MENGE = /menge|moq|tage|anzahl/

/**
 * „Ändern" kommt als generisches Formular: skalare Felder als `p:<feld>`
 * mit Typmarke `t:<feld>` (number|string|boolean), verschachtelte (Staffeln)
 * als JSON in `j:<feld>`. Leer = Feld weglassen. Pur, ohne Datenbank.
 */
export function parameterAusFormular(fd: FormData): { parameter: Record<string, unknown>; ungueltig: string[] } {
  const parameter: Record<string, unknown> = {}
  const ungueltig: string[] = []
  for (const [feld, wert] of fd.entries()) {
    if (typeof wert !== 'string') continue
    if (feld.startsWith('p:')) {
      const name = feld.slice(2)
      const roh = wert.trim()
      if (!roh) continue
      const typ = String(fd.get(`t:${name}`) ?? 'string')
      if (typ === 'number') parameter[name] = zahlLesen(roh, ZAHL_MENGE.test(name) ? 'menge' : 'preis') ?? Number.NaN
      else if (typ === 'boolean') parameter[name] = roh === 'true'
      else parameter[name] = roh
    } else if (feld.startsWith('j:')) {
      const name = feld.slice(2)
      const roh = wert.trim()
      if (!roh) continue
      try {
        parameter[name] = JSON.parse(roh)
      } catch {
        ungueltig.push(name)
      }
    }
  }
  return { parameter, ungueltig }
}

export const EINKAUF_KI = {
  'einkauf.vorschlag_annehmen': {
    label: 'KI-Vorschlag annehmen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Nimmt einen Vorschlag des Einkaufs-Agenten an und führt die vorgeschlagene Aktion aus — über den ' +
      'Torwächter und als der annehmende Mensch (Rechte, Schema und Schritt-Rechte wie bei jedem Klick). ' +
      'Ergebnis oder Fehler stehen danach am Vorschlag; ein gescheiterter lässt sich ändern und erneut annehmen.',
    bindung: 'beleg',
    modell: 'ki_vorschlag',
    uebergang: { von: ['offen', 'fehler'], nach: ['angenommen'] },
    schema: z.object({}),
    zusammenfassung: () => 'KI-Vorschlag annehmen',
    revalidate: ['/einkauf/cockpit', '/einkauf/entwuerfe'],
  },

  'einkauf.vorschlag_verwerfen': {
    label: 'KI-Vorschlag verwerfen',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung: 'Verwirft einen Vorschlag des Einkaufs-Agenten (optional mit Grund) — es wird nichts ausgeführt.',
    bindung: 'beleg',
    modell: 'ki_vorschlag',
    uebergang: { von: ['offen', 'fehler'], nach: ['verworfen'] },
    schema: z.object({ grund: z.string().trim().max(300).optional() }),
    zusammenfassung: (p) => `KI-Vorschlag verwerfen${p.grund ? `: ${p.grund}` : ''}`,
    formdata: (fd) => ({ grund: String(fd.get('grund') ?? '').trim() || undefined }),
    revalidate: ['/einkauf/cockpit'],
  },

  'einkauf.vorschlag_aendern': {
    label: 'KI-Vorschlag ändern',
    bereich: 'einkauf',
    prozessfrei: true,
    beschreibung:
      'Ändert die Parameter eines offenen oder gescheiterten Vorschlags vor dem Annehmen (z. B. Preis, Menge, ' +
      'Fälligkeit). Die Parameter werden gegen das Schema der vorgeschlagenen Aktion geprüft; ausgeführt wird ' +
      'erst mit „Annehmen".',
    bindung: 'beleg',
    modell: 'ki_vorschlag',
    schema: z
      .object({
        parameter: z.record(z.unknown()),
        ungueltig: z.array(z.string()).default([]),
      })
      .refine((p) => p.ungueltig.length === 0, (p) => ({ message: `Unlesbares JSON in: ${p.ungueltig.join(', ')}` })),
    zusammenfassung: () => 'KI-Vorschlag ändern',
    formdata: (fd) => parameterAusFormular(fd),
    revalidate: [],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
