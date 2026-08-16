import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Ticket-/Bugtracker-Bereichs. Kleinster Katalog des Hauses —
 * und der erste, weil der Bug-Loop (Ticket → Prozesstest → Fix → Commit)
 * genau diese Aktionen adressieren muss.
 */
export const FEHLER = {
  'fehler.ticket_melden': {
    label: 'Fehler melden',
    bereich: 'fehler',
    beschreibung:
      'Legt ein Ticket an (Status offen). Kommt aus dem Slide-out am rechten ' +
      'Bildschirmrand; die Seite ist der Ort des Geschehens.',
    bindung: 'frei',
    modell: 'bug_report',
    uebergang: { von: [], nach: ['offen'] },
    schema: z.object({
      titel: z.string().min(1, 'Bitte kurz benennen, was schiefgeht.').max(200),
      beschreibung: z.string().max(4000).optional(),
      seite: z.string().max(300).optional(),
      schwere: z.enum(['kritisch', 'stoerend', 'kosmetisch']).default('stoerend'),
    }),
    zusammenfassung: (p) => `„${p.titel}" (${p.schwere})`,
    formdata: (fd) => ({
      titel: String(fd.get('titel') ?? '').trim(),
      beschreibung: String(fd.get('beschreibung') ?? '').trim() || undefined,
      seite: String(fd.get('seite') ?? '').trim() || undefined,
      schwere: String(fd.get('schwere') ?? 'stoerend'),
    }),
    revalidate: ['/tickets'],
  },

  'fehler.ticket_status': {
    label: 'Ticketstatus setzen',
    bereich: 'fehler',
    beschreibung:
      'Setzt den Status eines Tickets (behoben/verworfen/offen); beim Schließen ' +
      'mit Vermerk und Commit, der die Behebung belegt.',
    bindung: 'beleg',
    modell: 'bug_report',
    schema: z.object({
      status: z.enum(['offen', 'in_arbeit', 'behoben', 'verworfen']),
      aufloesung: z.string().max(2000).optional(),
      commit_sha: z.string().max(64).optional(),
    }),
    zusammenfassung: (p) => `Status → ${p.status}`,
    formdata: (fd) => ({
      status: String(fd.get('status') ?? ''),
      aufloesung: String(fd.get('aufloesung') ?? '').trim() || undefined,
      commit_sha: String(fd.get('commit_sha') ?? '').trim() || undefined,
    }),
    revalidate: ['/tickets', '/tickets/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
