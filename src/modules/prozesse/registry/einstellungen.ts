import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Verwaltungsaktionen der Prozesse selbst — das Chamäleon-Stellwerk:
 * eine Firma passt ihre Abläufe zur Laufzeit an, ohne Code anzufassen.
 */
export const EINSTELLUNGEN = {
  'einstellungen.prozessschritt_schalten': {
    label: 'Prozessschritt an/aus',
    bereich: 'einstellungen',
    beschreibung:
      'Schaltet einen OPTIONALEN Prozessschritt für diese Firma ab oder wieder an. ' +
      'Der Override bindet an den Schritt-Code und überlebt damit Versionswechsel; ' +
      'Nachfolger rücken im Ablauf automatisch nach.',
    bindung: 'frei',
    nurAdmin: true,
    prozessfrei: true,
    schema: z.object({
      prozess_code: z.string().min(1),
      schritt_code: z.string().min(1),
      aktiv: z.boolean(),
    }),
    zusammenfassung: (p) =>
      `${p.prozess_code}/${p.schritt_code} → ${p.aktiv ? 'aktiv' : 'abgeschaltet'}`,
    formdata: (fd) => ({
      prozess_code: String(fd.get('prozess_code') ?? ''),
      schritt_code: String(fd.get('schritt_code') ?? ''),
      aktiv: fd.get('aktiv') === 'on' || fd.get('aktiv') === 'true',
    }),
    revalidate: ['/prozesse', '/prozesse/:ergebnis'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
