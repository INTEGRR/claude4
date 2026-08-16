import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Integrations-Aktionen: die Klärliste. Unbekannte Shop-SKUs landen als
 * ungeklärte Zeilen (shopify_unmatched_lines) — das Auflösen ist genau die
 * Aktion, die der matching-Schritttyp der Prozesse referenzieren wird.
 */
export const INTEGRATIONEN = {
  'integrationen.klaerfall_aufloesen': {
    label: 'Klärfall auflösen',
    bereich: 'integrationen',
    nurAdmin: true,
    prozessfrei: true,
    beschreibung:
      'Ordnet eine unbekannte Shop-SKU einer Variante zu. Die Zuordnung wird dauerhaft an der ' +
      'Variante gespeichert (Shop-Varianten-ID, fehlende SKU), damit der nächste Import passt.',
    bindung: 'beleg',
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte eine Variante auswählen'),
    }),
    formdata: (fd) => ({ variant_id: String(fd.get('variant_id') ?? '') }),
    revalidate: ['/integrationen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
