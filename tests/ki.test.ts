import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ROWS, runReadOnlyQuery } from '../src/modules/ki/sql-tool.ts'
import { closeDb, db } from './helpers.ts'

after(closeDb)

describe('KI: SQL-Werkzeug (Schutzmechanismen)', () => {
  test('einfache Leseabfrage funktioniert', async () => {
    const result = await runReadOnlyQuery(db(), 'select 1 as eins')
    assert.equal(result.error, undefined)
    assert.equal(result.rows?.[0].eins, 1)
  })

  test('Schreibversuche scheitern an der Read-only-Transaktion', async () => {
    for (const query of [
      "insert into partners (name) values ('KI-Eindringling')",
      "update product_templates set list_price = 0",
      "delete from stock_moves",
      "create table ki_tmp (id int)",
    ]) {
      const result = await runReadOnlyQuery(db(), query)
      assert.ok(result.error, `sollte scheitern: ${query}`)
      assert.match(result.error!, /read-only|gesperrte/i)
    }
  })

  test('gesperrte Tabellen und Spalten werden abgewiesen', async () => {
    for (const query of [
      'select * from users',
      'select token from sessions',
      'select value from settings',
      'select password_hash from partners',
      'select * from integration_jobs',
    ]) {
      const result = await runReadOnlyQuery(db(), query)
      assert.ok(result.error, `sollte blockiert werden: ${query}`)
      assert.match(result.error!, /gesperrte Tabellen/)
    }
  })

  test('Ergebnisse werden auf die Zeilengrenze gekappt', async () => {
    const result = await runReadOnlyQuery(db(), `select generate_series(1, ${MAX_ROWS + 100}) as n`)
    assert.equal(result.error, undefined)
    assert.equal(result.rows?.length, MAX_ROWS)
    assert.equal(result.gekappt, true)
  })

  test('Syntaxfehler kommen als Fehlermeldung zurück, nicht als Absturz', async () => {
    const result = await runReadOnlyQuery(db(), 'select kaputt from')
    assert.ok(result.error)
  })
})
