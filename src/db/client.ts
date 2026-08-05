import postgres from 'postgres'

/**
 * Datenbankzugriff.
 *
 * Die Verbindung wird erst beim ersten Query aufgebaut, nicht beim Import:
 * Der Produktions-Build lädt alle Module, um Routen zu analysieren — dabei
 * darf eine fehlende DATABASE_URL nicht zum Abbruch führen.
 *
 * Next.js lädt Module im Dev-Modus mehrfach, deshalb hängt der Pool am
 * globalThis.
 */
const globalForDb = globalThis as unknown as { __erpSql?: postgres.Sql }

function createClient(): postgres.Sql {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')

  return postgres(url, {
    max: 10,
    // Ohne Prepared Statements, aus zwei Gründen:
    //  - Supabase/Supavisor im Transaction-Mode unterstützt sie nicht.
    //  - Nach Migrationen, die Enums neu anlegen, zeigen zwischengespeicherte
    //    Statements auf verschwundene Typ-OIDs ("cache lookup failed for type").
    prepare: false,
    // numeric als Number lesen: für Mengen und Preise in dieser Größenordnung
    // exakt genug und macht die Anwendung deutlich einfacher.
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

function client(): postgres.Sql {
  if (!globalForDb.__erpSql) globalForDb.__erpSql = createClient()
  return globalForDb.__erpSql
}

/**
 * `sql` verhält sich wie der postgres.js-Client, baut die Verbindung aber erst
 * beim ersten Zugriff auf.
 */
export const sql: postgres.Sql = new Proxy(function () {} as unknown as postgres.Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    return (client() as unknown as (...a: unknown[]) => unknown)(...args)
  },
  get(_target, property) {
    const value = Reflect.get(client(), property) as unknown
    return typeof value === 'function' ? value.bind(client()) : value
  },
  has(_target, property) {
    return Reflect.has(client(), property)
  },
})

/** Führt `fn` in einer Transaktion aus. */
export async function tx<T>(fn: (t: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return client().begin(fn as (t: postgres.TransactionSql) => Promise<T>) as Promise<T>
}
