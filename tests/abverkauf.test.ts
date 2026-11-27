/**
 * Abverkauf (0144): die Rechenlogik des Command Centers — Reichweite in
 * Tastaturen, Tempo, Prognose und die Reihenfolge des Rankings.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { type TeilRoh, abverkaufRang, anteile, dauerText, fensterAus, teilZeile } from '../src/modules/verkauf/abverkauf-logik.ts'

const teil = (name: string, x: Partial<TeilRoh>): TeilRoh => ({
  id: name, name, sku: null, je: 1, artikel: 1, frei: 0, nutzbar: 0, gesperrt: false, fehlt: 0, fenster: 0, m15: 0, m60: 0, ...x,
})

test('gerechnet wird in Tastaturen: Stück je Tastatur teilt Bestand und Nachfrage', () => {
  const z = teilZeile(teil('Switch', { je: 99, nutzbar: 99 * 12 + 50, fenster: 99 * 6, m15: 99 * 2, m60: 99 * 5 }))
  assert.deepEqual([z.reicht, z.verkauft, z.tempo, z.minuten], [12, 6, 8, 90])
  assert.equal(z.anteil, 12 / 18)
  assert.equal(z.zustand, 'ok')
})

test('Tempo: die letzten 15 Minuten zählen — ist dort Ruhe, die letzte Stunde', () => {
  assert.equal(teilZeile(teil('a', { nutzbar: 10, m15: 3, m60: 4 })).tempo, 12)
  assert.equal(teilZeile(teil('b', { nutzbar: 10, m15: 0, m60: 4 })).tempo, 4)
  assert.equal(teilZeile(teil('c', { nutzbar: 10 })).minuten, null, 'ohne Abverkauf keine Prognose')
})

test('Zustand: überverkauft vor leer, kritisch unter 15 Minuten, knapp unter einer Stunde', () => {
  const zustand = (x: Partial<TeilRoh>) => teilZeile(teil('x', x)).zustand
  assert.equal(zustand({ nutzbar: 2, m15: 3 }), 'kritisch') // 12/Std → 10 Min
  assert.equal(zustand({ nutzbar: 6, m15: 2 }), 'knapp') // 8/Std → 45 Min
  assert.equal(zustand({ nutzbar: 40, m15: 2 }), 'ok')
  assert.equal(zustand({ nutzbar: 0 }), 'leer')
  assert.equal(zustand({ nutzbar: 0, fehlt: 3 }), 'ueberverkauft')
  assert.equal(zustand({ nutzbar: 0, fehlt: 3, gesperrt: true }), 'gesperrt', 'von Hand gesperrt geht vor')
  // Lücke in Tastaturen, aufgerundet: 100 fehlende Switches sind zwei Tastaturen.
  assert.equal(teilZeile(teil('s', { je: 99, fehlt: 100 })).fehlt, 2)
})

test('Ranking: überverkauft, dann nach Minuten bis leer, dann nach Reichweite — Leeres und Gesperrtes ohne Platz', () => {
  const r = abverkaufRang([
    teil('viel da', { nutzbar: 500 }),
    teil('gesperrt', { nutzbar: 0, gesperrt: true, fenster: 9 }),
    teil('in 30 Min', { nutzbar: 4, m15: 2 }),
    teil('leer', { nutzbar: 0 }),
    teil('wenig, kein Tempo', { nutzbar: 3 }),
    teil('in 10 Min', { nutzbar: 2, m15: 3 }),
    teil('Lücke 1', { fehlt: 1 }),
    teil('Lücke 5', { fehlt: 5 }),
  ])
  assert.deepEqual(r.map((x) => x.name), [
    'Lücke 5', 'Lücke 1', 'in 10 Min', 'in 30 Min', 'wenig, kein Tempo', 'viel da', 'leer', 'gesperrt',
  ])
  assert.deepEqual(r.map((x) => x.rang), [1, 2, 3, 4, 5, 6, null, null])
})

test('Dauer in Worten und Balkenanteile', () => {
  assert.deepEqual([0.4, 12, 60, 130, 2000].map(dauerText), ['unter 1 Min', '12 Min', '1 Std', '2 Std 10 Min', 'über 1 Tag'])
  assert.deepEqual(anteile([{ menge: 4 }, { menge: 1 }, { menge: 0 }]).map((x) => x.anteil), [1, 0.25, 0])
  assert.deepEqual(anteile([]), [])
  assert.deepEqual(['15', '60', '180', 'heute', 'quatsch', null].map(fensterAus), ['15', '60', '180', 'heute', 'heute', 'heute'])
})
