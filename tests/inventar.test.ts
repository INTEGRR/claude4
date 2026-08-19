import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestandsInput,
  deuteInventarPayload,
  inBloecken,
  inventoryItemGid,
  zuUebertragen,
} from '../src/modules/integrationen/inventar-logik.ts'
import { closeDb, makeProduct, stockUp, withRollback } from './helpers.ts'

after(closeDb)

describe('Shopify-Bestandsabgleich: Logik', () => {
  const variante = (frei: number, pushed: number | null, gid: string | null = 'gid://shopify/InventoryItem/1') => ({
    variant_id: 'v1',
    sku: 'T-1',
    inventory_item_gid: gid,
    frei,
    pushed_qty: pushed,
  })

  test('meldet, was sich geändert hat oder nie gemeldet wurde', () => {
    assert.equal(zuUebertragen([variante(5, null)]).melden.length, 1, 'nie gemeldet → melden')
    assert.equal(zuUebertragen([variante(5, 5)]).melden.length, 0, 'unverändert → nichts')
    assert.equal(zuUebertragen([variante(3, 5)]).melden.length, 1, 'geändert → melden')
  })

  test('rundet auf ganze Stücke ab — 4,6 verfügbar heißt 4 im Shop', () => {
    // 4,6 vs. gemeldet 4: ganzzahlig gleich, kein Aufruf nötig.
    assert.equal(zuUebertragen([variante(4.6, 4)]).melden.length, 0)
    // 3,9 vs. gemeldet 4: ganzzahlig verschieden.
    assert.equal(zuUebertragen([variante(3.9, 4)]).melden.length, 1)
  })

  test('trennt Varianten ohne InventoryItem ab, statt sie zu verlieren', () => {
    const r = zuUebertragen([variante(5, null, null)])
    assert.equal(r.melden.length, 0)
    assert.equal(r.ohneZuordnung.length, 1)
  })

  test('wandelt numerische IDs in GIDs, lässt GIDs unangetastet', () => {
    assert.equal(inventoryItemGid(42), 'gid://shopify/InventoryItem/42')
    assert.equal(inventoryItemGid('gid://shopify/InventoryItem/42'), 'gid://shopify/InventoryItem/42')
  })

  test('liest den inventory_levels/update-Payload', () => {
    assert.deepEqual(deuteInventarPayload({ inventory_item_id: 7, available: 12, location_id: 1 }), {
      inventoryItemGid: 'gid://shopify/InventoryItem/7',
      verfuegbar: 12,
    })
    assert.equal(deuteInventarPayload({ available: 12 }), null, 'ohne Item-ID')
    assert.equal(deuteInventarPayload({ inventory_item_id: 7 }), null, 'ohne Menge')
    assert.equal(
      deuteInventarPayload({ inventory_item_id: 7, available: 'viel' }),
      null,
      'Menge muss eine Zahl sein',
    )
  })

  test('zerlegt in Blöcke von höchstens n Einträgen', () => {
    assert.deepEqual(inBloecken([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
    assert.deepEqual(inBloecken([], 2), [])
  })

  test('Meldung trägt changeFromQuantity: null in JEDEM Eintrag (Pflicht seit 2026-07)', () => {
    // Regression: das weggelassene Feld hat in Prod jeden Bestandsabgleich
    // scheitern lassen („InventoryQuantityInput must include the following
    // argument: changeFromQuantity"). null = kein Vergleich, das ERP führt.
    const input = bestandsInput([variante(4.6, null)], 'gid://shopify/Location/1') as {
      name: string
      quantities: Record<string, unknown>[]
    }
    assert.equal(input.name, 'available')
    assert.equal(input.quantities.length, 1)
    const eintrag = input.quantities[0]
    assert.ok('changeFromQuantity' in eintrag, 'Feld muss explizit vorhanden sein')
    assert.equal(eintrag.changeFromQuantity, null)
    assert.equal(eintrag.quantity, 4, 'abgerundet auf ganze Stücke')
    assert.equal(eintrag.locationId, 'gid://shopify/Location/1')
  })
})

describe('Shopify-Bestandsabgleich: Abweichungssicht', () => {
  test('zeigt nur Varianten, bei denen der Shop etwas anderes glaubt', async () => {
    await withRollback(async (t) => {
      const variant = await makeProduct(t, 'Sync-Tastatur')
      await stockUp(t, variant, 8)
      await t`update product_variants
              set shopify_variant_id = 'gid://shopify/ProductVariant/9001',
                  shopify_inventory_item_gid = 'gid://shopify/InventoryItem/9001'
              where id = ${variant}`

      // Shop meldet 5, ERP hat 8 → Abweichung sichtbar.
      await t`insert into shopify_inventory_state (variant_id, shop_qty, shop_seen_at)
              values (${variant}, 5, now())`
      const drift = await t<{ erp_menge: number; shop_menge: number }[]>`
        select erp_menge, shop_menge from shopify_inventory_drift where variant_id = ${variant}`
      assert.equal(drift.length, 1)
      assert.equal(Number(drift[0].erp_menge), 8)
      assert.equal(Number(drift[0].shop_menge), 5)

      // Shop meldet 8 → keine Abweichung mehr.
      await t`update shopify_inventory_state set shop_qty = 8 where variant_id = ${variant}`
      const leer = await t`select 1 from shopify_inventory_drift where variant_id = ${variant}`
      assert.equal(leer.length, 0)
    })
  })
})
