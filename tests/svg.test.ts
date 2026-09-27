/**
 * svgMitGroesse: bwip-js liefert SVGs nur mit viewBox — ohne feste Größe
 * schrumpfte der QR-Code der 2FA-Einrichtung auf 0 px (2026-09-27).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { svgMitGroesse } from '../src/modules/shared/svg.ts'

describe('svgMitGroesse', () => {
  const bwip = '<svg viewBox="0 0 360 360" xmlns="http://www.w3.org/2000/svg">\n<path d="M0 0L8 0" />\n</svg>'

  test('setzt Breite, Höhe und scharfe Kanten, viewBox und Inhalt bleiben', () => {
    const aus = svgMitGroesse(bwip, 224)
    assert.match(aus, /^<svg viewBox="0 0 360 360" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="224" height="224" shape-rendering="crispEdges">/)
    assert.ok(aus.includes('<path d="M0 0L8 0" />'))
    assert.equal(aus.match(/<svg\b/g)?.length, 1)
  })

  test('ersetzt vorhandene Angaben statt sie zu verdoppeln', () => {
    const aus = svgMitGroesse('<svg width="10" height="20" viewBox="0 0 1 1"><g/></svg>', 100, 50)
    assert.equal(aus, '<svg viewBox="0 0 1 1" width="100" height="50" shape-rendering="crispEdges"><g/></svg>')
  })

  test('nur das Wurzel-Element wird angefasst', () => {
    const aus = svgMitGroesse('<svg viewBox="0 0 2 2"><svg width="1" height="1"/></svg>', 64)
    assert.ok(aus.includes('<svg width="1" height="1"/>'), 'inneres svg unverändert')
  })
})
