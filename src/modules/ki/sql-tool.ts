import type { Sql, TransactionSql } from 'postgres'

/**
 * Das SQL-Werkzeug des KI-Agenten, bewusst ohne App-Abhängigkeiten:
 * Der Datenbank-Client kommt als Parameter, damit die Schutzmechanismen
 * (Sperrliste, Read-only, Zeilenkappung) direkt testbar sind.
 */

export const MAX_ROWS = 500

/** Tabellen/Spalten, die die KI nie sehen darf. */
const GESPERRT = /\b(users|sessions|settings|password_hash|integration_jobs|sprachprotokoll\w*)\b/i

export interface SqlErgebnis {
  rows?: Record<string, unknown>[]
  rowCount?: number
  gekappt?: boolean
  error?: string
}

/** Führt eine Abfrage schreibgeschützt mit Timeout und Zeilenkappung aus. */
export async function runReadOnlyQuery(client: Sql, query: string): Promise<SqlErgebnis> {
  if (GESPERRT.test(query)) {
    return {
      error:
        'Diese Abfrage berührt gesperrte Tabellen (Benutzer, Sitzungen, Einstellungen, Jobs). ' +
        'Bitte auf Fachdaten beschränken.',
    }
  }
  try {
    const rows = await client.begin('read only', async (tx: TransactionSql) => {
      await tx.unsafe("set local statement_timeout = '10s'")
      return (await tx.unsafe(query)) as unknown as Record<string, unknown>[]
    })
    const gekappt = rows.length > MAX_ROWS
    return {
      rows: gekappt ? rows.slice(0, MAX_ROWS) : rows,
      rowCount: Math.min(rows.length, MAX_ROWS),
      gekappt,
    }
  } catch (err) {
    return { error: (err instanceof Error ? err.message : String(err)).replace(/^error: /, '') }
  }
}
