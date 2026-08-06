import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ALL_ROLES, canAccess, canWrite } from '../src/modules/auth/permissions.ts'
import { closeDb, db } from './helpers.ts'

after(closeDb)

describe('Rollen: Bereichsmatrix', () => {
  test('admin darf überall arbeiten', () => {
    for (const area of ['verkauf', 'einkauf', 'lager', 'einstellungen', 'ki'] as const) {
      assert.equal(canWrite('admin', area), true, area)
    }
  })

  test('mitarbeiter darf alles außer Verwaltung', () => {
    assert.equal(canWrite('mitarbeiter', 'verkauf'), true)
    assert.equal(canWrite('mitarbeiter', 'auswertungen'), true)
    assert.equal(canWrite('mitarbeiter', 'ki'), true)
    assert.equal(canAccess('mitarbeiter', 'integrationen'), false)
    assert.equal(canAccess('mitarbeiter', 'einstellungen'), false)
  })

  test('lager sieht nur eigene Bereiche, Produkte nur lesend', () => {
    assert.equal(canWrite('lager', 'lager'), true)
    assert.equal(canWrite('lager', 'versand'), true)
    assert.equal(canWrite('lager', 'reparatur'), true)
    assert.equal(canWrite('lager', 'scanner'), true)
    assert.equal(canAccess('lager', 'produkte'), true)
    assert.equal(canWrite('lager', 'produkte'), false)
    assert.equal(canAccess('lager', 'einkauf'), false)
    assert.equal(canAccess('lager', 'verkauf'), false)
    assert.equal(canAccess('lager', 'fertigung'), false)
    assert.equal(canAccess('lager', 'auswertungen'), false)
    assert.equal(canAccess('lager', 'ki'), false)
    assert.equal(canAccess('lager', 'einstellungen'), false)
  })

  test('fertigung sieht nur eigene Bereiche', () => {
    assert.equal(canWrite('fertigung', 'fertigung'), true)
    assert.equal(canWrite('fertigung', 'reparatur'), true)
    assert.equal(canWrite('fertigung', 'scanner'), true)
    assert.equal(canWrite('fertigung', 'produkte'), false)
    assert.equal(canAccess('fertigung', 'versand'), false)
    assert.equal(canAccess('fertigung', 'lager'), false)
    assert.equal(canAccess('fertigung', 'verkauf'), false)
  })

  test('die Rollenwerte existieren im Datenbank-Enum', async () => {
    const rows = await db()<{ value: string }[]>`
      select unnest(enum_range(null::user_role))::text as value`
    const enumValues = rows.map((r) => r.value)
    for (const role of ALL_ROLES) {
      assert.ok(enumValues.includes(role), `Enum-Wert ${role} fehlt`)
    }
  })
})
