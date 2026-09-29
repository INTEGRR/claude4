import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen der Auswertungen. Seit Migration 0088 rechnen die Kennzahlen
 * live — die frühere Aktion „Kennzahlen aktualisieren" ist entfallen.
 */
export const AUSWERTUNGEN = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
