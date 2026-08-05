import postgres from 'postgres'

/**
 * Eine einzige Verbindung pro Prozess. Next.js lädt Module im Dev-Modus mehrfach,
 * deshalb hängt der Pool am globalThis.
 */
const globalForDb = globalThis as unknown as { __erpSql?: postgres.Sql }

function createClient(): postgres.Sql {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  return postgres(url, {
    max: 10,
    // numeric als String lesen und selbst in Number wandeln wäre verlustfrei,
    // aber für Mengen/Preise in dieser Größenordnung ist Number exakt genug
    // und macht die Anwendung deutlich einfacher.
    types: {
      numeric: {
        to: 0,
        from: [1700],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
    transform: { undefined: null },
  })
}

export const sql: postgres.Sql = globalForDb.__erpSql ?? createClient()
if (process.env.NODE_ENV !== 'production') globalForDb.__erpSql = sql

/** Führt `fn` in einer Transaktion aus. */
export async function tx<T>(fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(fn as (t: postgres.TransactionSql) => Promise<T>) as Promise<T>
}
