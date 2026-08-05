import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import {
  assertLedgerConsistent,
  closeDb,
  expectError,
  freeToUse,
  locationId,
  makeProduct,
  onHand,
  operationTypeId,
  stockUp,
  uomStueck,
  withRollback,
} from './helpers.ts'

after(closeDb)

/** Legt einen Transfer mit einer Position an. */
async function makePicking(
  t: TransactionSql,
  kind: 'receipt' | 'delivery' | 'internal',
  variantId: string,
  qty: number,
): Promise<{ pickingId: string; moveId: string }> {
  const opType = await operationTypeId(t, kind)
  const [ot] = await t<{ sequence_code: string; default_src_id: string; default_dest_id: string }[]>`
    select sequence_code, default_src_id, default_dest_id from operation_types where id = ${opType}`
  const [picking] = await t<{ id: string }[]>`
    insert into stock_pickings (number, operation_type_id)
    values (next_sequence(${ot.sequence_code}), ${opType})
    returning id`
  const [move] = await t<{ id: string }[]>`
    insert into stock_moves (picking_id, variant_id, uom_id, qty, src_location_id, dest_location_id)
    values (${picking.id}, ${variantId}, ${await uomStueck(t)}, ${qty},
            ${ot.default_src_id}, ${ot.default_dest_id})
    returning id`
  return { pickingId: picking.id, moveId: move.id }
}

describe('Lager: Bewegungs-Ledger', () => {
  test('Wareneingang erhöht den Bestand', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Schalter')
      const { pickingId } = await makePicking(t, 'receipt', variant, 100)

      await t`select picking_confirm(${pickingId})`
      assert.equal(await onHand(t, variant), 0, 'vor Validierung noch kein Bestand')

      await t`select picking_validate(${pickingId})`
      assert.equal(await onHand(t, variant), 100)

      const [p] = await t<{ state: string }[]>`select state from stock_pickings where id = ${pickingId}`
      assert.equal(p.state, 'done')
      await assertLedgerConsistent(t)
    })
  })

  test('Warenausgang reserviert und bucht aus', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Gehäuse')
      await stockUp(t, variant, 10)

      const { pickingId } = await makePicking(t, 'delivery', variant, 4)
      await t`select picking_confirm(${pickingId})`

      // Reservierung mindert die frei verfügbare Menge, nicht den Bestand.
      assert.equal(await onHand(t, variant), 10)
      assert.equal(await freeToUse(t, variant), 6)

      const [p] = await t<{ state: string }[]>`select state from stock_pickings where id = ${pickingId}`
      assert.equal(p.state, 'assigned', 'voll reserviert => Bereit')

      await t`select picking_validate(${pickingId})`
      assert.equal(await onHand(t, variant), 6)
      assert.equal(await freeToUse(t, variant), 6)
      await assertLedgerConsistent(t)
    })
  })

  test('ohne Bestand bleibt der Transfer unvollständig reserviert', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Stabilisator')
      await stockUp(t, variant, 3)

      const { pickingId, moveId } = await makePicking(t, 'delivery', variant, 5)
      await t`select picking_confirm(${pickingId})`

      const [m] = await t<{ reserved_qty: number; state: string }[]>`
        select reserved_qty, state from stock_moves where id = ${moveId}`
      assert.equal(Number(m.reserved_qty), 3, 'nur der vorhandene Bestand wird reserviert')
      assert.equal(m.state, 'confirmed')

      const [p] = await t<{ state: string }[]>`select state from stock_pickings where id = ${pickingId}`
      assert.equal(p.state, 'confirmed', 'nicht bereit')
    })
  })

  test('Teilvalidierung erzeugt einen Rückstand', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Kabel')
      const { pickingId, moveId } = await makePicking(t, 'receipt', variant, 10)
      await t`select picking_confirm(${pickingId})`

      const [res] = await t<{ picking_validate: string | null }[]>`
        select picking_validate(${pickingId}, ${t.json({ [moveId]: 6 })}, true)`
      assert.ok(res.picking_validate, 'Rückstand wurde angelegt')

      assert.equal(await onHand(t, variant), 6)

      const [bo] = await t<{ qty: number; state: string }[]>`
        select m.qty, m.state from stock_moves m where m.picking_id = ${res.picking_validate}`
      assert.equal(Number(bo.qty), 4, 'Restmenge im Rückstand')

      await t`select picking_validate(${res.picking_validate})`
      assert.equal(await onHand(t, variant), 10)
      await assertLedgerConsistent(t)
    })
  })

  test('Teilvalidierung ohne Rückstand gibt die Restmenge auf', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Feder')
      const { pickingId, moveId } = await makePicking(t, 'receipt', variant, 10)
      await t`select picking_confirm(${pickingId})`

      const [res] = await t<{ picking_validate: string | null }[]>`
        select picking_validate(${pickingId}, ${t.json({ [moveId]: 6 })}, false)`
      assert.equal(res.picking_validate, null, 'kein Rückstand')
      assert.equal(await onHand(t, variant), 6)
      await assertLedgerConsistent(t)
    })
  })

  test('Storno gibt Reservierungen frei', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Keycap-Set')
      await stockUp(t, variant, 20)

      const { pickingId } = await makePicking(t, 'delivery', variant, 8)
      await t`select picking_confirm(${pickingId})`
      assert.equal(await freeToUse(t, variant), 12)

      await t`select picking_cancel(${pickingId})`
      assert.equal(await freeToUse(t, variant), 20, 'Reservierung freigegeben')
      assert.equal(await onHand(t, variant), 20)
      await assertLedgerConsistent(t)
    })
  })

  test('erledigte Transfers lassen sich nicht stornieren', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Platine')
      const { pickingId } = await makePicking(t, 'receipt', variant, 5)
      await t`select picking_confirm(${pickingId})`
      await t`select picking_validate(${pickingId})`

      await expectError(t, (sp) => sp`select picking_cancel(${pickingId})`, /Retoure/)
    })
  })

  test('Retoure dreht die Bewegung um', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Tastatur fertig')
      await stockUp(t, variant, 5)

      const { pickingId } = await makePicking(t, 'delivery', variant, 2)
      await t`select picking_confirm(${pickingId})`
      await t`select picking_validate(${pickingId})`
      assert.equal(await onHand(t, variant), 3)

      const [ret] = await t<{ picking_return: string }[]>`select picking_return(${pickingId})`
      await t`select picking_validate(${ret.picking_return})`

      assert.equal(await onHand(t, variant), 5, 'Ware ist zurück im Lager')
      await assertLedgerConsistent(t)
    })
  })
})

describe('Lager: Inventur und Ausschuss', () => {
  test('Inventur bucht die Differenz gegen den Inventurdifferenz-Ort', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Schrauben')
      await stockUp(t, variant, 50)
      const loc = await locationId(t, 'WH/Stock')

      const [count] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
        values (${loc}, ${variant}, 47, 50) returning id`
      await t`select inventory_apply(${count.id}, 'tester')`

      assert.equal(await onHand(t, variant), 47)

      // Die Korrektur ist eine Buchung Lager -> Inventurdifferenz über die Fehlmenge.
      // (Das Differenzkonto ist ein Gegenkonto und darf negativ werden - es trägt
      // auch den Anfangsbestand, der über dieselbe Mechanik eingebucht wurde.)
      const [corr] = await t<{ qty_done: number; src: string; dest: string }[]>`
        select m.qty_done, src.full_path as src, dst.full_path as dest
        from inventory_counts c
        join stock_moves m on m.id = c.move_id
        join stock_locations src on src.id = m.src_location_id
        join stock_locations dst on dst.id = m.dest_location_id
        where c.id = ${count.id}`
      assert.equal(Number(corr.qty_done), 3, 'Fehlmenge wird gebucht')
      assert.equal(corr.src, 'WH/Stock')
      assert.equal(corr.dest, 'Virtuell/Inventurdifferenz')
      await assertLedgerConsistent(t)
    })
  })

  test('Inventur meldet zwischenzeitliche Bestandsänderungen', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Dämmung')
      await stockUp(t, variant, 10)
      const loc = await locationId(t, 'WH/Stock')

      const [count] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
        values (${loc}, ${variant}, 9, 10) returning id`

      // Zwischen Zählung und Buchung kommt Ware herein.
      const { pickingId } = await makePicking(t, 'receipt', variant, 5)
      await t`select picking_confirm(${pickingId})`
      await t`select picking_validate(${pickingId})`

      await expectError(t, (sp) => sp`select inventory_apply(${count.id})`, /geändert/)
    })
  })

  test('Ausschuss bucht in den Ausschuss-Ort', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Schaumstoff')
      await stockUp(t, variant, 12)
      const loc = await locationId(t, 'WH/Stock')

      await t`select scrap(${variant}, 2, ${loc}, 'beschädigt')`

      assert.equal(await onHand(t, variant), 10)
      const [s] = await t<{ qty: number }[]>`
        select coalesce(sum(q.on_hand), 0) as qty from stock_quants q
        join stock_locations l on l.id = q.location_id
        where q.variant_id = ${variant} and l.is_scrap`
      assert.equal(Number(s.qty), 2)
      await assertLedgerConsistent(t)
    })
  })
})

describe('Maßeinheiten', () => {
  test('rechnet innerhalb einer Kategorie um', async () => {
    await withRollback(async (t) => {
      const [row] = await t<{ qty: number }[]>`
        select uom_convert(2,
          (select id from uoms where name = 'Dutzend'),
          (select id from uoms where name = 'Stück')) as qty`
      assert.equal(Number(row.qty), 24)
    })
  })

  test('verweigert die Umrechnung über Kategoriegrenzen', async () => {
    await withRollback(async (t) => {
      await expectError(
        t,
        (sp) => sp`select uom_convert(1,
          (select id from uoms where name = 'Stück'),
          (select id from uoms where name = 'kg'))`,
        /Kategorien/,
      )
    })
  })
})
