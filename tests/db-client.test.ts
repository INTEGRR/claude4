import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { sql, tx } from '../src/db/client.ts'
import { transaktion } from '../src/db/transaktion.ts'
import { closeDb, db } from './helpers.ts'

/**
 * Datenbank-Client ohne Pipelining (2026-10-02): Bestellung P00003 hing in
 * Prod 300 s, weil postgres.js bei vollem Pool Abfragen auf eine laufende
 * Verbindung stapelt und Supavisor (Transaction-Mode) die gestapelte nie
 * beantwortet. Der Wächter hält die Einstellung und verbietet `.begin(`,
 * das ohne Pipelining UNSAFE_TRANSACTION wirft — Transaktionen laufen über
 * tx()/transaktion() auf einer reservierten Verbindung.
 */

after(async () => {
  await closeDb()
  await sql.end()
})

const SRC = path.join(import.meta.dirname, '..', 'src')

async function dateien(verzeichnis: string): Promise<string[]> {
  const eintraege = await readdir(verzeichnis, { withFileTypes: true, recursive: true })
  return eintraege
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

describe('Datenbank-Client: kein Pipelining (Supavisor)', () => {
  test('der App-Client stapelt keine Abfragen', () => {
    assert.equal((sql.options as unknown as { max_pipeline: number }).max_pipeline, 0)
  })

  test('niemand ruft .begin( auf — Transaktionen nur über tx()/transaktion()', async () => {
    const funde: string[] = []
    for (const datei of await dateien(SRC)) {
      if (datei.includes(`${path.sep}migrations${path.sep}`)) continue
      const zeilen = (await readFile(datei, 'utf8')).split('\n')
      zeilen.forEach((zeile, i) => {
        const code = zeile.trim()
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
        if (/\.begin\(/.test(code)) funde.push(`${path.relative(SRC, datei)}:${i + 1}`)
      })
    }
    assert.deepEqual(funde, [], `sql.begin wirft ohne Pipelining UNSAFE_TRANSACTION:\n${funde.join('\n')}`)
  })

  test('mehr parallele Abfragen als Verbindungen laufen alle durch', async () => {
    const ergebnisse = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? sql<{ n: number }[]>`select ${i}::int as n, pg_sleep(0.01)`
          : sql<{ n: number }[]>`select 1 as n, pg_sleep(0.01)`,
      ),
    )
    assert.equal(ergebnisse.length, 40)
    assert.equal(ergebnisse[2][0].n, 2)
  })

  test('parallele Transaktionen (mehr als der Pool) verklemmen nicht', async () => {
    const werte = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        tx(async (t) => {
          await t`select pg_sleep(0.01)`
          const [r] = await t<{ n: number }[]>`select ${i}::int as n`
          return r.n
        }),
      ),
    )
    assert.deepEqual(werte, Array.from({ length: 25 }, (_, i) => i))
  })
})

describe('transaktion(): Commit, Rollback, Savepoints', () => {
  const tabelle = `tx_probe_${process.pid}`

  test('Commit macht sichtbar, Fehler rollt zurück', async () => {
    try {
      await transaktion(db(), async (t) => {
        await t.unsafe(`create table ${tabelle} (n int)`)
        await t.unsafe(`insert into ${tabelle} values (1)`)
      })
      const [{ anzahl }] = await sql.unsafe(`select count(*)::int as anzahl from ${tabelle}`)
      assert.equal(anzahl, 1)

      await assert.rejects(
        transaktion(db(), async (t) => {
          await t.unsafe(`insert into ${tabelle} values (2)`)
          throw new Error('Absicht')
        }),
        /Absicht/,
      )
      const [{ danach }] = await sql.unsafe(`select count(*)::int as danach from ${tabelle}`)
      assert.equal(danach, 1, 'der Fehler muss die Einfügung zurückrollen')
    } finally {
      await sql.unsafe(`drop table if exists ${tabelle}`)
    }
  })

  test('Savepoint rollt nur seinen Teil zurück, auch verschachtelt', async () => {
    const anzahl = await transaktion(db(), async (t) => {
      await t`create temp table sp_probe (n int) on commit drop`
      await t`insert into sp_probe values (1)`
      await assert.rejects(
        t.savepoint(async (sp) => {
          await sp`insert into sp_probe values (2)`
          await sp`select 1 / 0`
        }),
        /division by zero/,
      )
      await t.savepoint(async (sp) => {
        await sp`insert into sp_probe values (3)`
        await sp.savepoint('innen', async (innen) => {
          await innen`insert into sp_probe values (4)`
        })
      })
      const [r] = await t<{ n: number }[]>`select count(*)::int as n from sp_probe`
      return r.n
    })
    assert.equal(anzahl, 3)
  })

  test('Lesemodus verweigert Schreiben', async () => {
    await assert.rejects(
      transaktion(db(), (t) => t`create temp table ro_probe (n int)`, 'read only'),
      /read-only/,
    )
  })

  test('liefert die RowList unverändert (count, Zeilen)', async () => {
    const zeilen = await tx(async (t) => t<{ x: number }[]>`select 1 as x union all select 2`)
    assert.equal(zeilen.count, 2)
    assert.deepEqual(
      zeilen.map((z) => z.x),
      [1, 2],
    )
  })

  test('nach einem Fehler ist die Verbindung wieder frei und sauber', async () => {
    await assert.rejects(tx(async (t) => t`select 1 / 0`), /division by zero/)
    const [{ status }] = await sql<{ status: string }[]>`select 'ok' as status`
    assert.equal(status, 'ok')
    // Keine offene Transaktion auf einer zurückgegebenen Verbindung:
    // SAVEPOINT geht nur in einem Transaktionsblock.
    const versuche = await Promise.allSettled(Array.from({ length: 10 }, () => sql`savepoint pruef`))
    for (const v of versuche) {
      assert.equal(v.status, 'rejected')
      assert.match(String((v as PromiseRejectedResult).reason), /transaction blocks/)
    }
  })
})
