'use server'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'

/**
 * Merkt sich, welche Navigationsgruppen der angemeldete Benutzer geöffnet
 * hat (0095). Rahmenaktion wie „Backup-Codes erneuern": Oberfläche der
 * eigenen Sitzung, kein Beleg, kein Bereich — deshalb nicht in der Registry
 * (Liste RAHMEN_AKTIONEN in tests/prozess-registry.test.ts).
 */
export async function navigationMerken(offen: string[]): Promise<void> {
  const user = await requireUser()
  const saubere = [...new Set((Array.isArray(offen) ? offen : []).filter((g) => typeof g === 'string' && g.length <= 60))].slice(0, 40)
  await sql`update users set nav_offen = ${saubere}::text[] where id = ${user.id}`
}
