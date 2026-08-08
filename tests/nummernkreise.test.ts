import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { closeDb, db, withRollback } from './helpers.ts'

after(closeDb)

function eigenerClient() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  return postgres(url, { max: 1, prepare: false })
}

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Nummernkreise', () => {
  test('vergibt aufsteigende Nummern mit Präfix und Auffüllung', async () => {
    const [a] = await db()<{ next_sequence: string }[]>`select next_sequence('delivery')`
    const [b] = await db()<{ next_sequence: string }[]>`select next_sequence('delivery')`
    assert.match(a.next_sequence, /^WH\/OUT\/\d{5}$/)
    const zahl = (s: string) => Number(s.replace(/\D/g, ''))
    assert.equal(zahl(b.next_sequence), zahl(a.next_sequence) + 1)
  })

  test('meldet unbekannte Nummernkreise', async () => {
    await assert.rejects(
      () => db()`select next_sequence('gibtsnicht')` as unknown as Promise<unknown>,
      /Unbekannter Nummernkreis/,
    )
  })

  test('sequence_state zeigt die nächste Nummer', async () => {
    const vorher = await db()<{ code: string; next_number: number }[]>`
      select code, next_number from sequence_state() where code = 'internal'`
    await db()`select next_sequence('internal')`
    const nachher = await db()<{ code: string; next_number: number }[]>`
      select code, next_number from sequence_state() where code = 'internal'`
    assert.equal(Number(nachher[0].next_number), Number(vorher[0].next_number) + 1)
  })

  test('ein neuer Nummernkreis bekommt seine Sequenz automatisch', async () => {
    await withRollback(async (t) => {
      await t`insert into sequences (code, prefix, padding, next_number)
              values ('probe_kreis', 'PR/', 4, 7)`
      const [erste] = await t<{ next_sequence: string }[]>`select next_sequence('probe_kreis')`
      assert.equal(erste.next_sequence, 'PR/0007')
    })
  })

  /**
   * Der eigentliche Grund für Migration 0026: zwei Vorgänge, die dieselben
   * zwei Nummernkreise in unterschiedlicher Reihenfolge ziehen, dürfen sich
   * nicht gegenseitig blockieren. Mit der alten Zeilensperre („select … for
   * update") endete genau das in einem Deadlock (40P01).
   */
  test('verklemmen sich nicht, wenn zwei Vorgänge sie über Kreuz ziehen', async () => {
    const eins = eigenerClient()
    const zwei = eigenerClient()
    try {
      const links = eins.begin(async (t) => {
        await t`select next_sequence('delivery')`
        await warte(250)
        await t`select next_sequence('receipt')`
      })
      const rechts = zwei.begin(async (t) => {
        await t`select next_sequence('receipt')`
        await warte(250)
        await t`select next_sequence('delivery')`
      })
      await Promise.all([links, rechts])
    } finally {
      await eins.end()
      await zwei.end()
    }
  })
})
