import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, makeUser, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Nutzungsbericht light (Migration 0063): drei Kerngrößen je Monat für
 * Preisgespräche mit Pilotkunden. Geprüft wird die Fenstergröße, die
 * Zuordnung neuer Ereignisse zum aktuellen Monat und dass System-Akteure
 * ('demo', 'system', …) NICHT als aktive Nutzer zählen.
 */
describe('nutzungsbericht()', () => {
  type Zeile = {
    monat: string
    aktive_nutzer: number
    belege: number
    ki_fragen: number
    sprachsitzungen: number
  }

  test('liefert genau p_monate Zeilen, aufsteigend bis zum aktuellen Monat', async () => {
    await withRollback(async (t) => {
      const zeilen = await t<Zeile[]>`
        select monat::text as monat, aktive_nutzer, belege, ki_fragen, sprachsitzungen
        from nutzungsbericht(4)`
      assert.equal(zeilen.length, 4)
      const monate = zeilen.map((z) => z.monat)
      assert.deepEqual(monate, [...monate].sort())
      const [heute] = await t<{ monat: string }[]>`
        select date_trunc('month', now())::date::text as monat`
      assert.equal(zeilen.at(-1)!.monat, heute.monat)
      // Unsinnige Fenster fallen auf einen Monat zurück.
      const mini = await t<Zeile[]>`select * from nutzungsbericht(0)`
      assert.equal(mini.length, 1)
    })
  })

  test('zählt neue Belege, KI-Einträge und Sprachsitzungen im aktuellen Monat', async () => {
    await withRollback(async (t) => {
      const vorher = (await t<Zeile[]>`select * from nutzungsbericht(1)`)[0]

      const nutzer = await makeUser(t)
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Nutzungstest', true) returning id`
      await t`insert into sales_orders (number, partner_id)
              values (next_sequence('sale'), ${partner.id})`
      await t`select log_event('ki', gen_random_uuid(), 'note', 'Chat-Frage', ${nutzer.name})`
      await t`insert into sprachprotokolle (user_id, modell) values (${nutzer.id}, 'test')`

      const nachher = (await t<Zeile[]>`select * from nutzungsbericht(1)`)[0]
      assert.equal(nachher.belege, vorher.belege + 1)
      assert.equal(nachher.ki_fragen, vorher.ki_fragen + 1)
      assert.equal(nachher.sprachsitzungen, vorher.sprachsitzungen + 1)
      // Der Nutzer hat jetzt sicher gehandelt — mindestens er zählt als aktiv.
      assert.ok(nachher.aktive_nutzer >= 1)
    })
  })

  test('System-Akteure zählen nicht als aktive Nutzer', async () => {
    await withRollback(async (t) => {
      const vorher = (await t<Zeile[]>`select * from nutzungsbericht(1)`)[0]
      await t`select log_event('ki', gen_random_uuid(), 'note', 'Cron-Lauf', 'system')`
      const nachher = (await t<Zeile[]>`select * from nutzungsbericht(1)`)[0]
      // ki_fragen wächst (model='ki'), die Nutzerzahl nicht: 'system' ist
      // kein Konto — der Join auf users filtert ihn heraus.
      assert.equal(nachher.ki_fragen, vorher.ki_fragen + 1)
      assert.equal(nachher.aktive_nutzer, vorher.aktive_nutzer)
    })
  })
})
