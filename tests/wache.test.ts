/**
 * Dienste-Wächter (0085): Störung erst beim zweiten Fehlschlag in Folge,
 * Entstörung beim ersten Erfolg, Meldungen mit natürlichem Schlüssel,
 * unkonfigurierte Dienste bleiben still, Zeitlimit zählt als Fehlschlag.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, withRollback } from './helpers.ts'
import {
  type Sonde,
  datenbankAusfallFaellig,
  dienstStatusLesen,
  gestoerteDienste,
  mitZeitlimit,
  wacheLaufen,
} from '../src/modules/integrationen/wache.ts'

after(closeDb)

const sonde = (dienst: Sonde['dienst'], ok: boolean, konfiguriert = true): Sonde => ({
  dienst,
  konfiguriert,
  pruefen: async () => {
    if (!ok) throw new Error(`${dienst} antwortet 503`)
  },
})

describe('Dienste-Wächter', () => {
  test('Störung erst beim zweiten Fehlschlag, Entstörung beim ersten Erfolg — je eine Meldung', async () => {
    await withRollback(async (t) => {
      await t`delete from dienst_status`
      const eins = await wacheLaufen(t, [sonde('dhl', false)])
      assert.equal(eins.gemeldet, 0, 'erster Aussetzer meldet nichts')
      let [d] = await dienstStatusLesen(t)
      assert.equal(d.status, 'unbekannt')
      assert.equal(d.fehlversuche, 1)
      assert.match(d.fehler!, /503/)

      const zwei = await wacheLaufen(t, [sonde('dhl', false)])
      assert.equal(zwei.gemeldet, 1, 'zweiter Fehlschlag → gestört + Meldung')
      ;[d] = await dienstStatusLesen(t)
      assert.equal(d.status, 'gestoert')
      assert.ok(d.seit)
      assert.deepEqual(await gestoerteDienste(t), ['dhl'])
      const [m] = await t<{ schluessel: string; text: string }[]>`
        select schluessel, text from benachrichtigungen where art = 'dienst' and schluessel like 'dienst:dhl:gestoert:%'`
      assert.match(m.schluessel, /^dienst:dhl:gestoert:/)
      assert.match(m.text, /DHL Parcel DE nicht erreichbar/)
      assert.match(m.text, /503/)

      const drei = await wacheLaufen(t, [sonde('dhl', false)])
      assert.equal(drei.gemeldet, 0, 'bleibt gestört, keine zweite Meldung')
      ;[d] = await dienstStatusLesen(t)
      assert.equal(d.fehlversuche, 3)
      const [n] = await t<{ n: number }[]>`select count(*)::int as n from benachrichtigungen where art = 'dienst'`
      assert.equal(n.n, 1)

      await t`update dienst_status set seit = now() - interval '23 minutes' where dienst = 'dhl'`
      const vier = await wacheLaufen(t, [sonde('dhl', true)])
      assert.equal(vier.gemeldet, 1, 'Erfolg nach Störung → Entstörungs-Meldung')
      ;[d] = await dienstStatusLesen(t)
      assert.equal(d.status, 'ok')
      assert.equal(d.fehlversuche, 0)
      assert.equal(d.fehler, null)
      assert.deepEqual(await gestoerteDienste(t), [])
      const [e] = await t<{ schluessel: string; text: string }[]>`
        select schluessel, text from benachrichtigungen where art = 'dienst' and schluessel like 'dienst:dhl:ok:%'`
      assert.match(e.schluessel, /^dienst:dhl:ok:/)
      assert.match(e.text, /wieder erreichbar<\/b> — Störung 23 min/)

      // Ein einzelner Aussetzer nach ok flattert nicht: Zustand bleibt ok.
      const fuenf = await wacheLaufen(t, [sonde('dhl', false)])
      assert.equal(fuenf.gemeldet, 0)
      ;[d] = await dienstStatusLesen(t)
      assert.equal(d.status, 'ok')
      assert.equal(d.fehlversuche, 1)
      await wacheLaufen(t, [sonde('dhl', true)])
      ;[d] = await dienstStatusLesen(t)
      assert.equal(d.fehlversuche, 0)
    })
  })

  test('unkonfigurierte Dienste sind unbekannt und melden nie; mehrere Sonden laufen parallel', async () => {
    await withRollback(async (t) => {
      await t`delete from dienst_status`
      const lauf = await wacheLaufen(t, [
        sonde('mail', false, false),
        sonde('shopify', true),
        sonde('ki', false),
      ])
      assert.equal(lauf.gemeldet, 0)
      const stand = Object.fromEntries((await dienstStatusLesen(t)).map((d) => [d.dienst, d.status]))
      assert.deepEqual(stand, { ki: 'unbekannt', mail: 'unbekannt', shopify: 'ok' })
      await wacheLaufen(t, [sonde('mail', false, false), sonde('ki', false)])
      const [mail] = await t<{ fehlversuche: number }[]>`select fehlversuche from dienst_status where dienst = 'mail'`
      assert.equal(mail.fehlversuche, 0, 'unkonfiguriert zählt keine Fehlschläge')
      assert.deepEqual(await gestoerteDienste(t), ['ki'])
    })
  })

  test('Zeitlimit: eine hängende Sonde zählt als Fehlschlag', async () => {
    await withRollback(async (t) => {
      await t`delete from dienst_status`
      const haengt: Sonde = { dienst: 'sprache', konfiguriert: true, pruefen: () => new Promise(() => {}) }
      const lauf = await wacheLaufen(t, [haengt], { zeitlimitMs: 50 })
      assert.equal(lauf.ergebnisse[0].fehler, 'keine Antwort in 0.05 s')
      await assert.rejects(() => mitZeitlimit(new Promise(() => {}), 20), /keine Antwort/)
      assert.equal(await mitZeitlimit(Promise.resolve(7), 20), 7)
    })
  })

  test('Datenbank-Ausfall: Direktversand nur im ersten Fünf-Minuten-Fenster jeder Viertelstunde', () => {
    assert.equal(datenbankAusfallFaellig(new Date('2026-09-25T10:02:00')), true)
    assert.equal(datenbankAusfallFaellig(new Date('2026-09-25T10:04:59')), true)
    assert.equal(datenbankAusfallFaellig(new Date('2026-09-25T10:07:00')), false)
    assert.equal(datenbankAusfallFaellig(new Date('2026-09-25T10:16:00')), true)
    assert.equal(datenbankAusfallFaellig(new Date('2026-09-25T10:44:00')), false)
  })
})
