import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { datenTuev } from '../src/modules/lager/daten-tuev.ts'
import { closeDb, makeProduct, stockUp, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Der Daten-TÜV wird hier mit gezielter Korruption gefüttert: jede Prüfung
 * muss den Eingriff finden. Alle Vergleiche filtern auf die Test-SKU, damit
 * der Zustand der übrigen (Demo-)Daten das Ergebnis nicht beeinflusst.
 */
describe('Daten-TÜV: Invarianten der Kern-Ledger', () => {
  test('saubere Buchung erzeugt keinen Befund für die Testware', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'TÜV-Prüfling', { sku: 'TUEV-OK' })
      await stockUp(t, variant, 10)
      const r = await datenTuev(t)
      assert.ok(!r.befunde.some((b) => b.includes('TUEV-OK')), r.befunde.join(' | '))
    })
  })

  test('direkter Quant-Eingriff fällt als „Bestand = Ledger" auf', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'TÜV-Prüfling', { sku: 'TUEV-Q' })
      await stockUp(t, variant, 10)
      // Korruption: der Cache wird am Ledger vorbei verändert (genau das,
      // was eine schiefe Migration oder ein Hand-UPDATE anrichten würde).
      await t`update stock_quants set on_hand = on_hand + 7 where variant_id = ${variant}`
      const r = await datenTuev(t)
      assert.ok(
        r.befunde.some((b) => b.startsWith('Bestand = Ledger') && b.includes('TUEV-Q')),
        r.befunde.join(' | '),
      )
    })
  })

  test('verwaiste Reservierung fällt als Cache-Abweichung auf', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'TÜV-Prüfling', { sku: 'TUEV-R' })
      await stockUp(t, variant, 10)
      await t`update stock_quants set reserved = reserved + 3 where variant_id = ${variant}`
      const r = await datenTuev(t)
      assert.ok(
        r.befunde.some(
          (b) => b.startsWith('Reserviert = offene Move-Reservierungen') && b.includes('TUEV-R'),
        ),
        r.befunde.join(' | '),
      )
    })
  })

  test('Wertschicht ohne Bestandsbewegung fällt als Ledger-Bruch auf', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'TÜV-Prüfling', { sku: 'TUEV-W' })
      await stockUp(t, variant, 10)
      // Korruption: eine Schicht behauptet fünf Stück Zugang, den das
      // Bestands-Ledger nie gesehen hat.
      await t`insert into stock_valuation_layers
                (variant_id, layer_type, quantity, unit_cost, value)
              values (${variant}, 'receipt', 5, 1, 5)`
      const r = await datenTuev(t)
      assert.ok(
        r.befunde.some(
          (b) => b.startsWith('Bewertungsschichten = bewerteter Bestand') && b.includes('TUEV-W'),
        ),
        r.befunde.join(' | '),
      )
    })
  })

  test('negativer Bestand ist Warnung, nicht Befund-Klasse', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'TÜV-Prüfling', { sku: 'TUEV-N' })
      await stockUp(t, variant, 4)
      await t`update stock_quants set on_hand = -5 where variant_id = ${variant}`
      const r = await datenTuev(t)
      // Der Eingriff bricht auch das Ledger (Befund) — aber der negative
      // Bestand selbst wird als WARNUNG geführt, nicht als Korruption.
      assert.ok(
        r.warnungen.some(
          (w) => w.startsWith('Negativer Bestand an internen Orten') && w.includes('TUEV-N'),
        ),
        r.warnungen.join(' | '),
      )
      assert.ok(!r.befunde.some((b) => b.startsWith('Negativer Bestand')))
    })
  })
})
