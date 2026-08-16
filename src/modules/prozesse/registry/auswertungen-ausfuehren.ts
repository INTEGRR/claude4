import { sql } from '@/db/client'
import type { AktionsErgebnis } from './typen.ts'

/** Ausführung der Auswertungs-Aktionen. */

export async function kennzahlenAktualisieren(): Promise<AktionsErgebnis> {
  await sql`select refresh_analytics('manuell')`
  return { text: 'Kennzahlen neu berechnet.' }
}
