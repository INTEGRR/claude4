import { sql } from '@/db/client'
import { benachrichtigungenSenden, type VersandBilanz } from './benachrichtigungen'
import { telegramConfigured, telegramSenden, telegramSicher } from './telegram'

/**
 * Verdrahtung der Outbox mit Telegram: vom Cron `jobs` (jede Minute) und —
 * für sofortige Zustellung — per `after()` aus den Anmelde-Aktionen. Die
 * Outbox bleibt die Wahrheit; hier wird nur gesendet.
 */

export async function benachrichtigungenVersenden(limit = 20): Promise<VersandBilanz> {
  const [firma] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  const prefix = `<b>KRNL${firma?.name ? ` · ${telegramSicher(firma.name)}` : ''}</b>\n`
  return benachrichtigungenSenden(sql, {
    senden: telegramSenden,
    konfiguriert: telegramConfigured(),
    prefix,
    limit,
  })
}

/** Für `after()` in Server Actions: nie werfen, der Cron holt den Rest. */
export async function nachAnfrageVersenden(): Promise<void> {
  try {
    await benachrichtigungenVersenden(5)
  } catch {
    // bewusst still — Zustellung ist Sache des Cron
  }
}
