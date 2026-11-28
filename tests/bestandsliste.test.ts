/**
 * Bestandsabgleich, vollständige Liste (Entscheidungslog 2026-11-28): wie
 * Shop-Stand und KRNL-Meldung zueinander stehen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { einordnen } from '../src/modules/integrationen/bestandsliste-logik.ts'

const z = (teil: Partial<Parameters<typeof einordnen>[0]>) =>
  einordnen({ status: 'ACTIVE', shopKaufbar: true, shop: 5, krnl: 5, mto: false, ohneBestand: false, ...teil })

test('Tastatur: kaufbar bleibt kaufbar — die feste Menge ist keine Bestandszahl', () => {
  assert.equal(z({ mto: true, shop: 98, krnl: 999 }), 'gleich')
  assert.equal(z({ mto: true, shopKaufbar: false, shop: 0, krnl: 0 }), 'gleich')
})

test('im Shop kaufbar, KRNL meldet 0: ginge aus dem Verkauf', () => {
  assert.equal(z({ shop: 7, krnl: 0 }), 'nur_shop')
  assert.equal(z({ mto: true, shop: 998, krnl: 0 }), 'nur_shop')
})

test('im Shop aus, KRNL meldet eine Menge: ginge in den Verkauf', () => {
  assert.equal(z({ shopKaufbar: false, shop: 0, krnl: 8800 }), 'nur_krnl')
})

test('Lagerartikel, beide kaufbar, andere Zahl: andere Menge', () => {
  assert.equal(z({ shop: 56, krnl: 350 }), 'menge')
  assert.equal(z({ shop: 56, krnl: 56 }), 'gleich')
})

test('Entwurf und archiviert sehen Kunden nicht — keine Abweichung', () => {
  assert.equal(z({ status: 'DRAFT', shop: 999, krnl: 0 }), 'unsichtbar')
  assert.equal(z({ status: 'ARCHIVED', shopKaufbar: false, shop: 0, krnl: 12 }), 'unsichtbar')
})

test('im Shop gelöscht (beim letzten Lesen nicht mehr dabei): keine Abweichung, auch mit alter Menge', () => {
  assert.equal(z({ status: 'FEHLT', shopKaufbar: false, shop: 998, krnl: 0 }), 'unsichtbar')
})

test('der Shop verkauft ohne Bestand weiter: eine 0 von KRNL nimmt das Angebot nicht aus dem Verkauf', () => {
  assert.equal(z({ ohneBestand: true, shop: -1, krnl: 0 }), 'gleich')
})
