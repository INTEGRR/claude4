import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/** Aktionen der Auswertungen. */
export const AUSWERTUNGEN = {
  'auswertungen.kennzahlen_aktualisieren': {
    label: 'Kennzahlen aktualisieren',
    bereich: 'auswertungen',
    ki: true,
    beschreibung:
      'Berechnet die Kennzahlen sofort neu — der Cron macht das ohnehin nachts.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/auswertungen/kennzahlen', '/auswertungen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
