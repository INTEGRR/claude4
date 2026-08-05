import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  assertLedgerConsistent,
  closeDb,
  expectError,
  freeToUse,
  makeProduct,
  onHand,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

let counter = 0

async function repairScenario(t: TransactionSql, opts: { warranty?: boolean } = {}) {
  const suffix = `R${++counter}`
  const uom = await uomStueck(t)

  const keyboard = await makeProduct(t, `Tastatur ${suffix}`)
  const switchPart = await makeProduct(t, `Ersatz-Switch ${suffix}`)
  const defectPart = await makeProduct(t, `Defekter Switch ${suffix}`)
  const cable = await makeProduct(t, `Kabel ${suffix}`)

  await stockUp(t, switchPart, 50)
  await stockUp(t, cable, 10)

  const [partner] = await t<{ id: string }[]>`
    insert into partners (name, is_customer, email) values (${`Kunde ${suffix}`}, true, 'k@example.com')
    returning id`

  const [repair] = await t<{ id: string }[]>`
    insert into repair_orders (number, partner_id, variant_id, qty, under_warranty)
    values (next_sequence('repair'), ${partner.id}, ${keyboard}, 1, ${opts.warranty ?? false})
    returning id`

  return { repairId: repair.id, partnerId: partner.id, keyboard, switchPart, defectPart, cable, uom }
}

async function addPart(
  t: TransactionSql,
  repairId: string,
  type: 'add' | 'remove' | 'recycle',
  variantId: string,
  qty: number,
  uom: string,
) {
  const [row] = await t<{ id: string }[]>`
    insert into repair_parts (repair_id, part_type, variant_id, qty, uom_id, price_unit)
    values (${repairId}, ${type}::repair_part_type, ${variantId}, ${qty}, ${uom}, 5)
    returning id`
  return row.id
}

describe('Reparatur', () => {
  test('Bestätigen reserviert die einzubauenden Teile', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t)
      await addPart(t, s.repairId, 'add', s.switchPart, 3, s.uom)

      assert.equal(await freeToUse(t, s.switchPart), 50)
      await t`select repair_confirm(${s.repairId}, 'tester')`

      assert.equal(await freeToUse(t, s.switchPart), 47, 'Teile sind reserviert')
      assert.equal(await onHand(t, s.switchPart), 50, 'Bestand noch unverändert')

      const [r] = await t<{ state: string }[]>`select state from repair_orders where id = ${s.repairId}`
      assert.equal(r.state, 'confirmed')
    })
  })

  test('Abschluss bucht alle Teilearten korrekt', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t)
      await addPart(t, s.repairId, 'add', s.switchPart, 3, s.uom)     // verbaut
      await addPart(t, s.repairId, 'remove', s.defectPart, 3, s.uom)  // Ausschuss
      await addPart(t, s.repairId, 'recycle', s.cable, 1, s.uom)      // zurück ins Lager

      await t`select repair_confirm(${s.repairId})`
      await t`select repair_start(${s.repairId})`
      await t`select repair_end(${s.repairId}, '{}'::jsonb, 'tester')`

      assert.equal(await onHand(t, s.switchPart), 47, 'Ersatzteile verbraucht')
      assert.equal(await onHand(t, s.cable), 11, 'wiederverwendetes Teil zurück im Lager')

      const [scrapped] = await t<{ qty: number }[]>`
        select coalesce(sum(q.on_hand), 0) as qty from stock_quants q
        join stock_locations l on l.id = q.location_id
        where q.variant_id = ${s.defectPart} and l.is_scrap`
      assert.equal(Number(scrapped.qty), 3, 'ausgebaute Teile liegen im Ausschuss')

      const [r] = await t<{ state: string }[]>`select state from repair_orders where id = ${s.repairId}`
      assert.equal(r.state, 'repaired')
      await assertLedgerConsistent(t)
    })
  })

  test('abweichende Ist-Menge wird übernommen', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t)
      const partId = await addPart(t, s.repairId, 'add', s.switchPart, 5, s.uom)

      await t`select repair_confirm(${s.repairId})`
      // Es wurden nur 2 statt 5 Switches gebraucht.
      await t`select repair_end(${s.repairId}, ${t.json({ [partId]: 2 })}, 'tester')`

      assert.equal(await onHand(t, s.switchPart), 48)
      assert.equal(await freeToUse(t, s.switchPart), 48, 'Restreservierung ist aufgelöst')
      await assertLedgerConsistent(t)
    })
  })

  test('Storno gibt reservierte Teile frei', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t)
      await addPart(t, s.repairId, 'add', s.switchPart, 4, s.uom)
      await t`select repair_confirm(${s.repairId})`
      assert.equal(await freeToUse(t, s.switchPart), 46)

      await t`select repair_cancel(${s.repairId}, 'tester')`
      assert.equal(await freeToUse(t, s.switchPart), 50)
      assert.equal(await onHand(t, s.switchPart), 50)
      await assertLedgerConsistent(t)
    })
  })

  test('abgeschlossene Reparaturen lassen sich nicht stornieren', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t)
      await addPart(t, s.repairId, 'add', s.switchPart, 1, s.uom)
      await t`select repair_confirm(${s.repairId})`
      await t`select repair_end(${s.repairId})`

      await expectError(t, (sp) => sp`select repair_cancel(${s.repairId})`, /Abgeschlossene/)
    })
  })

  test('kostenpflichtige Reparatur erzeugt ein Angebot mit den verbauten Teilen', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t, { warranty: false })
      await addPart(t, s.repairId, 'add', s.switchPart, 2, s.uom)
      await addPart(t, s.repairId, 'remove', s.defectPart, 2, s.uom)

      await t`select repair_confirm(${s.repairId})`
      await t`select repair_end(${s.repairId})`

      const [quote] = await t<{ repair_create_quotation: string }[]>`
        select repair_create_quotation(${s.repairId}, 'tester')`

      const lines = await t<{ variant_id: string; qty: number }[]>`
        select variant_id, qty from sales_order_lines where order_id = ${quote.repair_create_quotation}`
      assert.equal(lines.length, 1, 'nur eingebaute Teile werden berechnet')
      assert.equal(lines[0].variant_id, s.switchPart)
      assert.equal(Number(lines[0].qty), 2)

      const [r] = await t<{ sales_order_id: string }[]>`
        select sales_order_id from repair_orders where id = ${s.repairId}`
      assert.equal(r.sales_order_id, quote.repair_create_quotation)
    })
  })

  test('Garantiereparaturen werden nicht berechnet', async () => {
    await withRollback(async (t) => {
      const s = await repairScenario(t, { warranty: true })
      await addPart(t, s.repairId, 'add', s.switchPart, 1, s.uom)
      await t`select repair_confirm(${s.repairId})`
      await t`select repair_end(${s.repairId})`

      await expectError(
        t,
        (sp) => sp`select repair_create_quotation(${s.repairId})`,
        /Garantie/,
      )
    })
  })
})
