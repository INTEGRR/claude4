/**
 * Offene Vorgänge je Prozess (Zähler in Navigation und „Heute"): offen ist,
 * wo der Prozess vom aktuellen Zustand aus noch eine Aktion anbietet.
 */
import './spur.ts'
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'

const DATENBANK = 'erp_offene_vorgaenge_check'
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

test('Reparaturanfrage: neu und Rückfrage zählen, angenommen und abgelehnt nicht', async () => {
  let n = 0
  for (const zustand of ['neu', 'neu', 'rueckfrage', 'angenommen', 'abgelehnt']) {
    await h.sql`
      insert into vorgaenge (number, prozess_code, state, quelle)
      values (${`VG/T${++n}`}, 'reparatur_anfrage', ${zustand}, 'shop')`
  }
  const { offeneVorgaenge } = await import('../../src/modules/prozesse/offene-vorgaenge.ts')
  const offen = await offeneVorgaenge()
  assert.equal(offen.get('reparatur_anfrage'), 3)
})
