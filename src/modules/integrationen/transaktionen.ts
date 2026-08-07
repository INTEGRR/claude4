import { sql } from '@/db/client'

/**
 * Transaktionslog für alle ausgehenden API-Aufrufe (Shopify, DHL, Mail).
 * Fire-and-forget: Das Protokoll darf nie den eigentlichen Ablauf brechen —
 * Fehler beim Schreiben werden verschluckt. Zugangsdaten (Header, Tokens,
 * Passwörter) werden hier nie übergeben; Payloads werden gekürzt.
 */

const MAX_PAYLOAD_CHARS = 20_000

export interface Transaktion {
  system: 'shopify' | 'dhl' | 'mail'
  kind: string
  reference?: string | null
  request?: unknown
  response?: unknown
  ok: boolean
  statusCode?: number | null
  error?: string | null
  durationMs?: number
  jobId?: string | null
}

/** Kürzt beliebige Payloads auf eine speicherbare JSON-Darstellung. */
export function truncatePayload(value: unknown): unknown {
  if (value === undefined || value === null) return null
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length <= MAX_PAYLOAD_CHARS) {
      return typeof value === 'string' ? { text: value } : value
    }
    return {
      gekuerzt: true,
      laenge: text.length,
      anfang: text.slice(0, MAX_PAYLOAD_CHARS),
    }
  } catch {
    return { fehler: 'Payload nicht serialisierbar' }
  }
}

/** Aufräumen (täglicher Housekeeping-Cron) — Logik in prune_monitor_data(). */
export async function pruneMonitorData(): Promise<Record<string, number>> {
  const [row] = await sql<{ prune_monitor_data: Record<string, number> }[]>`
    select prune_monitor_data()`
  return row.prune_monitor_data
}

export async function logTransaction(t: Transaktion): Promise<void> {
  try {
    await sql`
      insert into api_transactions
        (system, kind, reference, request, response, ok, status_code, error, duration_ms, job_id)
      values (
        ${t.system}, ${t.kind}, ${t.reference ?? null},
        ${sql.json(truncatePayload(t.request) as never)},
        ${sql.json(truncatePayload(t.response) as never)},
        ${t.ok}, ${t.statusCode ?? null},
        ${t.error?.slice(0, 2000) ?? null}, ${t.durationMs ?? null}, ${t.jobId ?? null})`
  } catch {
    // bewusst still — siehe Kopfkommentar
  }
}

/**
 * Für Aufrufer, die den Belegbezug erst nach dem Aufruf kennen: misst die
 * Dauer, protokolliert Erfolg wie Fehler und reicht das Ergebnis durch.
 */
export async function withTransaction<T>(
  meta: Omit<Transaktion, 'ok' | 'durationMs' | 'error' | 'response'>,
  fn: () => Promise<T>,
  describeResponse?: (result: T) => unknown,
): Promise<T> {
  const start = Date.now()
  try {
    const result = await fn()
    await logTransaction({
      ...meta,
      ok: true,
      durationMs: Date.now() - start,
      response: describeResponse ? describeResponse(result) : undefined,
    })
    return result
  } catch (err) {
    await logTransaction({
      ...meta,
      ok: false,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}
