import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type SammelPosition,
  fortschritt,
  naechsteOffene,
  sammelAbgleich,
  sammelReihenfolge,
  scanTreffer,
} from '../src/modules/versand/kommissionier-logik.ts'

/**
 * Führungslogik des Sammel-Screens (0091), pur: Laufreihenfolge, Scan-
 * Zuordnung gegen SKU/Barcode, nächste offene Position und der harte
 * Abgleich, den lager.kommissionieren serverseitig genauso rechnet.
 */

const pos = (variantId: string, name: string, soll: number, sku: string | null, barcode: string | null = null): SammelPosition => ({
  variantId,
  name,
  sku,
  barcode,
  soll,
  uom: 'Stück',
})

const POSITIONEN = sammelReihenfolge([
  pos('v-sw', 'Switch linear', 70, 'SW-1', '4006381333931'),
  pos('v-kc', 'Keycaps ISO-DE', 1, 'KC-DE'),
  pos('v-sr', 'Schrauben M2', 1, null),
  pos('v-äg', 'Ärmelschoner', 2, 'AE-1'),
])

describe('Kommissionier-Logik', () => {
  test('Laufreihenfolge nach Artikelname, deutsch sortiert', () => {
    assert.deepEqual(
      POSITIONEN.map((p) => p.name),
      ['Ärmelschoner', 'Keycaps ISO-DE', 'Schrauben M2', 'Switch linear'],
    )
  })

  test('Scan trifft SKU oder Barcode, ohne Groß/Klein und Leerraum', () => {
    assert.deepEqual(scanTreffer(POSITIONEN, {}, ' kc-de '), { art: 'treffer', variantId: 'v-kc' })
    assert.deepEqual(scanTreffer(POSITIONEN, {}, '4006381333931'), { art: 'treffer', variantId: 'v-sw' })
    assert.deepEqual(scanTreffer(POSITIONEN, { 'v-kc': 1 }, 'KC-DE'), { art: 'voll', variantId: 'v-kc' })
    assert.deepEqual(scanTreffer(POSITIONEN, {}, 'FREMD-1'), { art: 'fremd' })
    assert.deepEqual(scanTreffer(POSITIONEN, {}, '   '), { art: 'fremd' })
  })

  test('gleicher Code an zwei Positionen: zuerst die noch offene', () => {
    const doppelt = [pos('v1', 'A', 1, 'X'), pos('v2', 'B', 1, 'X')]
    assert.deepEqual(scanTreffer(doppelt, { v1: 1 }, 'x'), { art: 'treffer', variantId: 'v2' })
  })

  test('nächste offene Position überspringt Volle und als fehlend Markierte', () => {
    assert.equal(naechsteOffene(POSITIONEN, {})?.variantId, 'v-äg')
    assert.equal(naechsteOffene(POSITIONEN, { 'v-äg': 2 })?.variantId, 'v-kc')
    assert.equal(naechsteOffene(POSITIONEN, { 'v-äg': 2 }, new Set(['v-kc']))?.variantId, 'v-sr')
    assert.equal(naechsteOffene(POSITIONEN, { 'v-äg': 2, 'v-kc': 1, 'v-sr': 1, 'v-sw': 70 }), null)
  })

  test('Fortschritt zählt höchstens die Sollmenge', () => {
    assert.deepEqual(fortschritt(POSITIONEN, { 'v-äg': 5, 'v-sw': 10 }), { ist: 12, soll: 74 })
  })

  test('Abgleich: fehlend, zu viel, fremd — vollständig nur ohne alles', () => {
    const voll = { 'v-äg': 2, 'v-kc': 1, 'v-sr': 1, 'v-sw': 70 }
    assert.equal(sammelAbgleich(POSITIONEN, voll).vollstaendig, true)
    const teil = sammelAbgleich(POSITIONEN, { ...voll, 'v-sw': 69, 'v-sr': 0 })
    assert.deepEqual(teil.fehlend, ['Schrauben M2 (0/1)', 'SW-1 (69/70)'])
    assert.equal(teil.vollstaendig, false)
    const zuviel = sammelAbgleich(POSITIONEN, { ...voll, 'v-kc': 2 })
    assert.deepEqual(zuviel.zuViel, ['KC-DE (2/1)'])
    const fremd = sammelAbgleich(POSITIONEN, { ...voll, 'v-anderes': 1, 'v-null': 0 })
    assert.deepEqual(fremd.fremd, ['v-anderes'], 'Null-Mengen fremder Varianten stören nicht')
  })
})
