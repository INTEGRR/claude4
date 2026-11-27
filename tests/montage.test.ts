import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  type MontageZeile,
  listeAusText,
  montageBaum,
  montageBuendel,
  montagePfad,
  nameTeil,
} from '../src/modules/fertigung/montage-logik.ts'

/**
 * Montage-Übersicht (0141, Entscheidungslog 2026-11-27): offene
 * Fertigungsmengen als Baum — HE/MX aus dem Produktnamen, dann Plate, dann
 * Switch.
 */

const E = { nameTeile: ['HE', 'MX'], attribute: ['Mounting Plate', 'Switches'] }
const z = (produkt: string, plate: string, sw: string, offen: number, keycaps = 'Standard'): MontageZeile => ({
  produkt, offen, werte: { 'Mounting Plate': plate, Switches: sw, Keycaps: keycaps },
})

const ZEILEN = [
  z('NATIVE 1800 HE (QWERTZ) Plague Black', 'FR4', 'Gateron - Jade Max', 6),
  z('NATIVE 1800 HE (QWERTZ) Emerald Green', 'FR4', 'Gateron - Jade Max', 4, 'Frosted Obsidian'),
  z('NATIVE 1800 HE (QWERTZ) Founders Edition', 'PC', 'Gateron - Jade Gaming', 3),
  z('NATIVE 1800 MX (QWERTZ) Plague Black', 'FR4', 'Gateron Pro 3 - Linear Yellow', 5),
  z('NATIVE 1800 MX (QWERTZ) Plague Black', 'PC', 'Cherry MX2A - Silent Red', 2),
  z('Switch-Tester', '', '', 1),
  z('NATIVE 1800 MX (QWERTZ) Emerald Green', 'FR4', 'Gateron Pro 3 - Linear Yellow', 0),
]

describe('Montage-Übersicht: Gruppierung', () => {
  test('Stichwort im Produktnamen: nur als eigenes Wort, sonst „Sonstige"', () => {
    assert.equal(nameTeil('NATIVE 1800 HE (QWERTZ) Plague Black', E.nameTeile), 'HE')
    assert.equal(nameTeil('NATIVE 1800 MX (QWERTZ) Emerald Green', E.nameTeile), 'MX')
    assert.equal(nameTeil('Switch-Tester mit Schema', E.nameTeile), 'Sonstige', '„he" in „Schema" zählt nicht')
    assert.equal(nameTeil('Board Hall Effect weiß', ['Hall Effect', 'MX']), 'Hall Effect', 'mehrere Wörter')
  })

  test('Pfad: Name, dann Attribute in der eingestellten Reihenfolge; fehlender Wert = „—"', () => {
    assert.deepEqual(montagePfad(ZEILEN[0], E), ['HE', 'FR4', 'Gateron - Jade Max'])
    assert.deepEqual(montagePfad({ produkt: 'Sonderbau MX', werte: {}, offen: 1 }, E), ['MX', '—', '—'])
    assert.deepEqual(montagePfad(ZEILEN[0], { nameTeile: [], attribute: [] }), ['NATIVE 1800 HE (QWERTZ) Plague Black'])
  })

  test('Baum: wie viele HE und MX, je Plate, je Switch — Farben und Keycaps zählen zusammen', () => {
    const { gesamt, knoten } = montageBaum(ZEILEN, E)
    assert.equal(gesamt, 21)
    assert.deepEqual(knoten.map((k) => [k.label, k.offen]), [['HE', 13], ['MX', 7], ['Sonstige', 1]])
    const he = knoten[0]
    assert.deepEqual(he.kinder.map((k) => [k.label, k.offen]), [['FR4', 10], ['PC', 3]])
    assert.deepEqual(he.kinder[0].kinder.map((k) => [k.label, k.offen]), [['Gateron - Jade Max', 10]])
    assert.equal(he.kinder[0].kinder[0].schluessel, 'HE › FR4 › Gateron - Jade Max')
    const mx = knoten[1]
    assert.deepEqual(mx.kinder.map((k) => [k.label, k.offen]), [['FR4', 5], ['PC', 2]], 'größte Gruppe zuerst')
  })

  test('die Namens-Ebene hält die eingestellte Reihenfolge, auch wenn MX größer ist', () => {
    const { knoten } = montageBaum([z('X MX', 'FR4', 'A', 9), z('X HE', 'FR4', 'B', 1)], E)
    assert.deepEqual(knoten.map((k) => k.label), ['HE', 'MX'])
  })

  test('Bündel: die größten Kombinationen zuerst', () => {
    const b = montageBuendel(montageBaum(ZEILEN, E).knoten, 3)
    assert.deepEqual(b.map((x) => [x.offen, x.pfad.join(' · ')]), [
      [10, 'HE · FR4 · Gateron - Jade Max'],
      [5, 'MX · FR4 · Gateron Pro 3 - Linear Yellow'],
      [3, 'HE · PC · Gateron - Jade Gaming'],
    ])
  })

  test('Eingabe der Einstellung: Komma-Liste ohne Leeres und Doppeltes', () => {
    assert.deepEqual(listeAusText(' HE, MX ,, HE '), ['HE', 'MX'])
    assert.deepEqual(listeAusText(''), [])
  })
})
