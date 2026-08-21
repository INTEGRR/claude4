/**
 * Test-Infrastruktur: jeder Test läuft in einer eigenen Transaktion, die am
 * Ende zurückgerollt wird. Dadurch sind die Tests voneinander unabhängig,
 * ohne die Datenbank zwischen den Tests neu aufbauen zu müssen.
 */
import '../scripts/env.ts'
import postgres from 'postgres'
import type { Sql, TransactionSql } from 'postgres'

const ROLLBACK = Symbol('rollback')

let client: Sql | undefined

export function db(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
    client = postgres(url, {
      max: 4,
      // Dieselben Optionen wie src/db/client.ts — sonst laufen die Tests mit
      // anderer Treiber-Semantik als die Produktion und ein Fehler rutscht
      // gruen durch. prepare:false wegen Enum-Migrationen ("cache lookup
      // failed for type"), transform wegen undefined-Parametern.
      prepare: false,
      transform: { undefined: null },
      types: {
        numeric: {
          to: 0,
          from: [1700],
          serialize: (x: number | string) => String(x),
          parse: (x: string) => Number(x),
        },
      },
    })
  }
  return client
}

export async function closeDb(): Promise<void> {
  await client?.end()
  client = undefined
}

/** Führt `fn` in einer Transaktion aus und rollt sie danach zurück. */
export async function withRollback<T>(fn: (t: TransactionSql) => Promise<T>): Promise<T> {
  let result: T
  try {
    await db().begin(async (t) => {
      result = await fn(t as TransactionSql)
      throw ROLLBACK
    })
  } catch (err) {
    if (err !== ROLLBACK) throw err
  }
  return result!
}

/**
 * Erwartet, dass `fn` einen Datenbankfehler auslöst, und hält die umgebende
 * Transaktion am Leben. Ohne Savepoint würde Postgres die gesamte Transaktion
 * abbrechen und alle folgenden Anweisungen des Tests scheitern lassen.
 */
export async function expectError(
  t: TransactionSql,
  fn: (sp: TransactionSql) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let message: string | undefined
  try {
    await t.savepoint(async (sp) => {
      await fn(sp as unknown as TransactionSql)
    })
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  if (message === undefined) {
    throw new Error(`Erwarteter Fehler (${pattern}) ist nicht aufgetreten`)
  }
  if (!pattern.test(message)) {
    throw new Error(`Fehlermeldung passt nicht zu ${pattern}: ${message}`)
  }
}

// --- Fixtures --------------------------------------------------------------

export async function uomStueck(t: TransactionSql): Promise<string> {
  const [row] = await t<{ id: string }[]>`select id from uoms where name = 'Stück'`
  return row.id
}

export async function locationId(t: TransactionSql, fullPath: string): Promise<string> {
  const [row] = await t<{ id: string }[]>`
    select id from stock_locations where full_path = ${fullPath}`
  if (!row) throw new Error(`Lagerort ${fullPath} nicht gefunden`)
  return row.id
}

export async function operationTypeId(t: TransactionSql, kind: string): Promise<string> {
  const [row] = await t<{ id: string }[]>`
    select id from operation_types where kind = ${kind}::picking_kind limit 1`
  return row.id
}

/** Legt ein einfaches Produkt ohne Varianten an und liefert die Varianten-ID. */
/**
 * Ein Benutzer, auf den sich der Test verlassen kann. Vorher holten mehrere
 * Tests einfach `select id from users limit 1` — das ging gut, solange lokal
 * geseedet war, und brach in der CI gegen eine frisch migrierte Datenbank mit
 * „Cannot read properties of undefined". Ein Test bringt seine Voraussetzungen
 * selbst mit.
 */
export async function makeUser(
  t: TransactionSql,
  name = 'Testnutzer',
): Promise<{ id: string; name: string }> {
  const [vorhanden] = await t<{ id: string; name: string }[]>`
    select id, name from users where name = ${name}`
  if (vorhanden) return vorhanden
  const [neu] = await t<{ id: string; name: string }[]>`
    insert into users (email, name, password_hash, role)
    values (${`${name.toLowerCase().replace(/\s+/g, '.')}@test.local`}, ${name}, 'x:y', 'admin')
    returning id, name`
  return neu
}

export async function makeProduct(
  t: TransactionSql,
  name: string,
  opts: { sku?: string; weightG?: number } = {},
): Promise<string> {
  const uom = await uomStueck(t)
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${name}, ${uom}, ${opts.weightG ?? 100})
    returning id`
  await t`select generate_variants(${tpl.id})`
  const [variant] = await t<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} and active limit 1`
  if (opts.sku) {
    await t`update product_variants set sku = ${opts.sku} where id = ${variant.id}`
  }
  return variant.id
}

/** Bucht Anfangsbestand über eine Inventurkorrektur (der saubere Weg). */
export async function stockUp(
  t: TransactionSql,
  variantId: string,
  qty: number,
  location?: string,
): Promise<void> {
  const loc = location ?? (await locationId(t, 'WH/Stock'))
  const [current] = await t<{ on_hand: number }[]>`
    select coalesce(on_hand, 0) as on_hand from stock_quants
    where location_id = ${loc} and variant_id = ${variantId}`
  const [count] = await t<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${loc}, ${variantId}, ${qty}, ${current?.on_hand ?? 0})
    returning id`
  await t`select inventory_apply(${count.id}, 'test')`
}

export async function onHand(
  t: TransactionSql,
  variantId: string,
  location?: string,
): Promise<number> {
  const [row] = await t<{ qty: number }[]>`
    select on_hand_qty(${variantId}, ${location ?? null}) as qty`
  return Number(row.qty)
}

export async function freeToUse(t: TransactionSql, variantId: string): Promise<number> {
  const [row] = await t<{ qty: number }[]>`select free_to_use(${variantId}) as qty`
  return Number(row.qty)
}

/**
 * Die zentrale Invariante: der Bestand jeder Variante an jedem Ort muss exakt
 * der Summe aller erledigten Bewegungen dorthin/von dort entsprechen.
 * Nimmt bewusst `Sql` (Basistyp): auch der Prozesstest-Harness prüft sie —
 * dort ohne Transaktion, weil die Läufe echte Commits brauchen.
 */
export async function assertLedgerConsistent(t: Sql | TransactionSql): Promise<void> {
  const rows = await t<{ location_id: string; variant_id: string; quant: number; ledger: number }[]>`
    with ledger as (
      select dest_location_id as location_id, variant_id, sum(qty_done) as qty
      from stock_moves where state = 'done' group by 1, 2
      union all
      select src_location_id, variant_id, -sum(qty_done)
      from stock_moves where state = 'done' group by 1, 2
    ), summed as (
      select location_id, variant_id, sum(qty) as qty from ledger group by 1, 2
    )
    select coalesce(q.location_id, s.location_id) as location_id,
           coalesce(q.variant_id, s.variant_id) as variant_id,
           coalesce(q.on_hand, 0) as quant,
           coalesce(s.qty, 0) as ledger
    from stock_quants q
    full outer join summed s
      on s.location_id = q.location_id and s.variant_id = q.variant_id
    where abs(coalesce(q.on_hand, 0) - coalesce(s.qty, 0)) > 0.0001`

  if (rows.length > 0) {
    throw new Error(
      'Ledger-Invariante verletzt:\n' +
        rows
          .map((r) => `  Ort ${r.location_id} / Variante ${r.variant_id}: Bestand ${r.quant}, Bewegungen ${r.ledger}`)
          .join('\n'),
    )
  }
}
