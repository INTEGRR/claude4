/**
 * Fehlermeldungen (Bugtracker im System): Nummernkreis, Vorgaben, Verlauf.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, withRollback } from './helpers.ts'

after(closeDb)

describe('Fehlermeldungen', () => {
  test('Meldung bekommt Nummer, Vorgaben und Verlauf', async () => {
    await withRollback(async (t) => {
      const [meldung] = await t<
        { id: string; number: string; status: string; schwere: string }[]
      >`
        insert into bug_reports (number, titel, gemeldet_von)
        values (next_sequence('bug'), 'Testfehler', 'Test')
        returning id, number, status, schwere`

      assert.match(meldung.number, /^BUG\/\d{5}$/)
      assert.equal(meldung.status, 'offen')
      assert.equal(meldung.schwere, 'stoerend')

      // Kommentare laufen über denselben Verlauf wie an jedem Datensatz.
      await t`select log_event('bug_report', ${meldung.id}::uuid, 'note', 'Kommentar', 'Test')`
      const [{ anzahl }] = await t<{ anzahl: number }[]>`
        select count(*)::int as anzahl from audit_log
        where model = 'bug_report' and record_id = ${meldung.id}`
      assert.equal(anzahl, 1)
    })
  })

  test('behoben setzt den Zeitstempel, wieder öffnen löscht ihn', async () => {
    await withRollback(async (t) => {
      const [meldung] = await t<{ id: string }[]>`
        insert into bug_reports (number, titel, gemeldet_von)
        values (next_sequence('bug'), 'Testfehler', 'Test')
        returning id`

      await t`
        update bug_reports set status = 'behoben', aufloesung = 'gefixt', behoben_am = now()
        where id = ${meldung.id}`
      const [zu] = await t<{ behoben_am: string | null }[]>`
        select behoben_am from bug_reports where id = ${meldung.id}`
      assert.ok(zu.behoben_am)

      await t`
        update bug_reports set status = 'offen', behoben_am = null where id = ${meldung.id}`
      const [wieder] = await t<{ status: string; behoben_am: string | null }[]>`
        select status, behoben_am from bug_reports where id = ${meldung.id}`
      assert.equal(wieder.status, 'offen')
      assert.equal(wieder.behoben_am, null)
    })
  })
})
