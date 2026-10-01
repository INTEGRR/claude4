import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  INVENTAR_MUTATION,
  angeboteZuMelden,
  bestandsInput,
  deuteInventarPayload,
  fehlerJePosition,
  inBloecken,
  inventoryItemGid,
  zuUebertragen,
} from '../src/modules/integrationen/inventar-logik.ts'
import { closeDb, makeProduct, stockUp, withRollback } from './helpers.ts'

after(closeDb)

describe('Shopify-Bestandsabgleich: Zweitangebote (0106)', () => {
  const angebot = (frei: number, pushed: number | null, fehlerQty: number | null = null, gid: string | null = 'gid://shopify/InventoryItem/77') => ({
    angebot_id: 'a1',
    produkt: 'Black Week Editions',
    variant_id: 'v1',
    sku: 'KB-1',
    inventory_item_gid: gid,
    frei,
    pushed_qty: pushed,
    push_fehler_qty: fehlerQty,
  })

  test('ein Zweitangebot meldet wie eine Variante — an sein eigenes InventoryItem', () => {
    assert.equal(angeboteZuMelden([angebot(4, null)]).melden.length, 1, 'nie gemeldet → melden')
    assert.equal(angeboteZuMelden([angebot(4, 4)]).melden.length, 0, 'unverändert → nichts')
    assert.equal(angeboteZuMelden([angebot(4, null, null, null)]).ohneZuordnung.length, 1)
    const input = bestandsInput([angebot(4.7, null)], 'gid://shopify/Location/1') as {
      quantities: { inventoryItemId: string; quantity: number }[]
    }
    assert.deepEqual(input.quantities.map((q) => [q.inventoryItemId, q.quantity]), [['gid://shopify/InventoryItem/77', 4]])
  })

  test('eine abgelehnte Menge wird nicht bei jedem Abgleich wiederholt — erst eine neue', () => {
    assert.equal(angeboteZuMelden([angebot(4, 2, 4)]).melden.length, 0, 'dieselbe Menge schon abgelehnt')
    assert.equal(angeboteZuMelden([angebot(3, 2, 4)]).melden.length, 1, 'neue Menge → neuer Versuch')
  })

  test('userErrors treffen die genannte Position — ohne Index alle', () => {
    const je = fehlerJePosition(3, [
      { field: ['input', 'quantities', '1', 'inventoryItemId'], message: 'not stocked at location' },
    ])
    assert.deepEqual([...je.entries()], [[1, 'not stocked at location']])
    const alle = fehlerJePosition(2, [{ field: null, message: 'kaputt' }])
    assert.deepEqual([...alle.keys()], [0, 1])
    const doppelt = fehlerJePosition(2, [
      { field: ['input', 'quantities', '0'], message: 'a' },
      { field: ['input', 'quantities', '0', 'quantity'], message: 'b' },
    ])
    assert.deepEqual([...doppelt.entries()], [[0, 'a; b']])
    assert.equal(fehlerJePosition(2, [{ field: ['input', 'quantities', '9'], message: 'x' }]).size, 2, 'Index außerhalb → alle')
  })
})

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

  test('Mutation trägt die @idempotent-Direktive (Laufzeit-Pflicht seit 2026-04)', () => {
    // Zweite Prod-Regression derselben API-Umstellung: „The @idempotent
    // directive is required for this mutation but was not provided."
    assert.ok(INVENTAR_MUTATION.includes('inventorySetQuantities'))
    assert.ok(INVENTAR_MUTATION.includes('@idempotent(key: $idempotencyKey)'))
    assert.ok(INVENTAR_MUTATION.includes('$idempotencyKey: String!'))
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
