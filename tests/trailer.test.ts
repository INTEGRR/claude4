import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DAUER, ENDKARTE, KAPITEL, kapitelBei, masse, zeitText } from '../src/app/start/trailer-logik.ts'

/**
 * Startseiten-Trailer (src/app/start/trailer.tsx): Der Zeitplan steht an
 * drei Stellen — Szenen-`--t` in der Komponente, absolute Verzögerungen in
 * start.css, Kapitel in trailer-logik.ts. Der Wächter hält sie gleich,
 * damit Kapitelsprünge nicht neben der Szene landen.
 */

const TSX = readFileSync(new URL('../src/app/start/trailer.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/app/start/start.css', import.meta.url), 'utf8')

describe('Trailer: Zeitplan an allen Stellen gleich (Wächter)', () => {
  test('jede Kapitel-Zeit ist der Anfang einer Szene, und die Szenen schließen lückenlos an', () => {
    const szenen = [...TSX.matchAll(/'--t': '([\d.]+)s', '--e': '([\d.]+)s'/g)].map((m) => [Number(m[1]), Number(m[2])])
    assert.equal(szenen.length, KAPITEL.length + 1, 'Auftakt + eine Szene je Kapitel')
    assert.deepEqual(szenen.slice(1).map(([t]) => t), KAPITEL.map((k) => k.t))
    for (let i = 1; i < szenen.length; i++) assert.equal(szenen[i][0], szenen[i - 1][1], `Lücke vor Szene ${i}`)
    assert.equal(szenen.at(-1)?.[1], ENDKARTE, 'letzte Szene endet, wo die Endkarte beginnt')
  })

  test('die Uhr läuft genau DAUER Sekunden und endet nach der letzten Animation', () => {
    assert.match(CSS, new RegExp(`animation: tr-zeit ${DAUER}s linear both`))
    const letzte = Math.max(
      ...[...CSS.matchAll(/\.tr-laeuft \.tr-ende[^{]*\{ animation: [^;]*?([\d.]+)s ([\d.]+)s/g)].map((m) => Number(m[1]) + Number(m[2])),
    )
    assert.ok(letzte <= DAUER, `Endkarte animiert bis ${letzte}s, Uhr endet bei ${DAUER}s`)
  })

  test('der Faden startet beim ersten Kapitel und erreicht das letzte zu dessen Zeit', () => {
    const erste = KAPITEL[0].t
    const spanne = KAPITEL.at(-1)!.t - erste
    assert.match(CSS, new RegExp(`animation: tr-faden ${spanne}s linear ${erste}s both`))
    const stuetz = [...CSS.matchAll(/^\s*([\d.]+)% \{ width: (\d+)%?; \}/gm)].map((m) => [Number(m[1]), Number(m[2])])
    KAPITEL.forEach((k, i) => {
      const soll = ((k.t - erste) / spanne) * 100
      const punkt = stuetz.find(([, w]) => w === Math.round((i / (KAPITEL.length - 1)) * 100))
      assert.ok(punkt && Math.abs(punkt[0] - soll) < 0.01, `Stützstelle für ${k.name}: ${soll.toFixed(3)}%`)
    })
  })
})

describe('Trailer: Logik', () => {
  test('Kapitel zur Zeit', () => {
    assert.equal(kapitelBei(0), -1)
    assert.equal(kapitelBei(4), 0)
    assert.equal(kapitelBei(21), 3)
    assert.equal(kapitelBei(35), 5)
    assert.equal(kapitelBei(ENDKARTE), -1)
  })

  test('Zeitangabe', () => {
    assert.equal(zeitText(0), '0:00')
    assert.equal(zeitText(41.7), '0:41')
    assert.equal(zeitText(75), '1:15')
  })

  test('Desktop: quer, volle Breite', () => {
    const m = masse(1180, 900)
    assert.equal(m.format, 'quer')
    assert.equal(m.links, 0)
    assert.equal(m.hoehe, Math.round(1080 * (1180 / 1920)))
  })

  test('Telefon hoch: hochkant, höchstens 80 % der Fensterhöhe', () => {
    const m = masse(350, 760)
    assert.equal(m.format, 'hoch')
    assert.ok(m.hoehe <= 760 * 0.8)
    assert.ok(m.links >= 0)
  })

  test('Tablet hoch: hochkant, aber gedeckelt und mittig', () => {
    const m = masse(728, 1000)
    assert.equal(m.format, 'hoch')
    assert.equal(m.hoehe, 800)
    assert.ok(m.links > 0)
  })

  test('Telefon quer: 16:9 statt einer winzigen Hochkant-Bühne', () => {
    assert.equal(masse(804, 390).format, 'quer')
  })
})
