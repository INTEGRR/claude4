import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { anlageLuecken } from '../src/modules/shared/anlage-luecken.ts'
import { teilAusKurzanlage } from '../src/modules/shared/teil-kurzanlage.ts'

/**
 * Anlegen-Helfer (Entscheidungslog 2026-11-27, Block A): der Hinweis auf
 * fehlende Route/Stückliste/Artikelnummern (A6) und die Teil-Kurzanlage (A4).
 */

const voll = { route_buy: false, route_manufacture: true, stuecklisten: 1, positionen: 12, ohne_sku: 0, varianten: 6 }

describe('Anlage-Lücken eines Verkaufsprodukts (A6)', () => {
  test('vollständig angelegt → kein Hinweis', () => {
    assert.deepEqual(anlageLuecken(voll), [])
    assert.deepEqual(anlageLuecken({ ...voll, route_buy: true, route_manufacture: false, stuecklisten: 0, positionen: 0 }), [])
  })

  test('ohne Route', () => {
    const l = anlageLuecken({ ...voll, route_manufacture: false, stuecklisten: 0, positionen: 0 })
    assert.deepEqual(l.map((x) => x.art), ['route'])
  })

  test('Fertigen ohne Stückliste — und nicht zusätzlich „keine Positionen"', () => {
    const l = anlageLuecken({ ...voll, stuecklisten: 0, positionen: 0 })
    assert.deepEqual(l.map((x) => x.art), ['stueckliste'])
  })

  test('Stückliste ohne Positionen', () => {
    assert.deepEqual(anlageLuecken({ ...voll, positionen: 0 }).map((x) => x.art), ['positionen'])
  })

  test('Artikelnummern: alle fehlen oder ein Teil', () => {
    assert.match(anlageLuecken({ ...voll, ohne_sku: 6 })[0].text, /Keine Variante/)
    assert.match(anlageLuecken({ ...voll, ohne_sku: 2 })[0].text, /2 von 6/)
  })

  test('frisch aus dem Shop importiert: alles auf einmal', () => {
    const l = anlageLuecken({ route_buy: false, route_manufacture: false, stuecklisten: 0, positionen: 0, ohne_sku: 144, varianten: 144 })
    assert.deepEqual(l.map((x) => x.art), ['route', 'sku'])
  })
})

describe('Teil-Kurzanlage (A4)', () => {
  test('Vorgabe: Kaufteil, einkaufbar, ohne Preis', () => {
    assert.deepEqual(teilAusKurzanlage({ name: 'Schraube' }), { einkaufbar: true, route: 'kaufen' })
  })

  test('Einheit und Preis mit Komma', () => {
    assert.deepEqual(teilAusKurzanlage({ einheit: 'm', kosten: ' 0,35 € ', beschaffung: 'kaufen' }), {
      einkaufbar: true,
      route: 'kaufen',
      einheit: 'm',
      einstandspreis: 0.35,
    })
  })

  test('Selbst fertigen ist nicht einkaufbar', () => {
    assert.deepEqual(teilAusKurzanlage({ beschaffung: 'fertigen' }), { einkaufbar: false, route: 'fertigen' })
  })

  test('kein Preis und negativer Preis werden abgelehnt', () => {
    assert.ok('fehler' in teilAusKurzanlage({ kosten: 'abc' }))
    assert.ok('fehler' in teilAusKurzanlage({ kosten: '-1' }))
  })
})
