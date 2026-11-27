/**
 * Kontingent (0136): die Verteilung knapper Teile auf die Shop-Angebote.
 * Kern ist die Garantie „nie mehr versprochen, als Teile da sind" — hier
 * an festen Fällen und an 500 zufälligen Sortimenten bewiesen.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Abnehmer, kontingentVerletzungen, kontingentVerteilen } from '../src/modules/integrationen/kontingent-logik.ts'

const pool = (o: Record<string, number>) => new Map(Object.entries(o))
const a = (id: string, bedarf: Record<string, number>, deckel = 99, gewicht = 1): Abnehmer => ({
  id, deckel, gewicht, bedarf: Object.entries(bedarf).map(([komponente, je]) => ({ komponente, je })),
})
const summe = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0)

describe('kontingentVerteilen', () => {
  test('ein Teil, drei Tastaturen: die Summe ist genau der Bestand, nicht dreimal der Bestand', () => {
    const ab = [a('gelb', { gehaeuse: 1 }), a('braun', { gehaeuse: 1 }), a('blau', { gehaeuse: 1 })]
    const k = kontingentVerteilen(ab, pool({ gehaeuse: 70 }))
    assert.equal(summe(k), 70)
    assert.deepEqual([...k.values()].sort(), [23, 23, 24])
  })

  test('nach Gewicht: wer mehr Nachfrage erwartet, bekommt mehr', () => {
    const ab = [a('gelb', { gehaeuse: 1 }, 99, 6), a('braun', { gehaeuse: 1 }, 99, 3), a('blau', { gehaeuse: 1 }, 99, 1)]
    const k = kontingentVerteilen(ab, pool({ gehaeuse: 70 }))
    assert.deepEqual([k.get('gelb'), k.get('braun'), k.get('blau')], [42, 21, 7])
  })

  test('zwei Engpässe: Gehäuse geteilt, Switches je Sorte — keiner wird überzogen', () => {
    const ab = [
      a('gelb', { gehaeuse: 1, sw_gelb: 85 }),
      a('braun', { gehaeuse: 1, sw_braun: 85 }),
      a('blau', { gehaeuse: 1, sw_blau: 85 }),
    ]
    const p = pool({ gehaeuse: 70, sw_gelb: 2828, sw_braun: 903, sw_blau: 275 })
    const k = kontingentVerteilen(ab, p)
    // Blau reicht für 3, Braun für 10 — was sie nicht nutzen können, geht an Gelb (33 möglich).
    assert.deepEqual([k.get('blau'), k.get('braun'), k.get('gelb')], [3, 10, 33])
    assert.deepEqual(kontingentVerletzungen(ab, p, k), [])
  })

  test('Deckel: nie mehr als das Angebot allein bekäme; der Rest geht an die anderen', () => {
    const ab = [a('klein', { teil: 1 }, 5), a('gross', { teil: 1 }, 99)]
    const k = kontingentVerteilen(ab, pool({ teil: 40 }))
    assert.deepEqual([k.get('klein'), k.get('gross')], [5, 35])
  })

  test('Einzelverkauf und Tastatur teilen sich das Teil', () => {
    const ab = [a('plate-einzeln', { plate: 1 }, 10), a('tastatur', { plate: 1, gehaeuse: 1 })]
    const p = pool({ plate: 12, gehaeuse: 50 })
    const k = kontingentVerteilen(ab, p)
    assert.equal(k.get('plate-einzeln')! + k.get('tastatur')!, 12)
    assert.deepEqual(kontingentVerletzungen(ab, p, k), [])
  })

  test('Zweitangebot: dieselbe Ware in zwei Angeboten wird geteilt, nicht doppelt angeboten', () => {
    const ab = [a('deskmat', { matte: 1 }), a('deskmat-bundle', { matte: 1 })]
    const k = kontingentVerteilen(ab, pool({ matte: 9 }))
    assert.equal(summe(k), 9)
  })

  test('„immer verfügbar" (kein Bedarf) bekommt seinen Deckel und nimmt niemandem etwas', () => {
    const ab = [a('immer', {}, 99), a('tastatur', { gehaeuse: 1 })]
    const k = kontingentVerteilen(ab, pool({ gehaeuse: 4 }))
    assert.deepEqual([k.get('immer'), k.get('tastatur')], [99, 4])
  })

  test('nichts da, Deckel 0 oder Teil unbekannt: 0', () => {
    const ab = [a('leer', { gehaeuse: 1 }), a('aus', { teil: 1 }, 0), a('fremd', { unbekannt: 1 })]
    const k = kontingentVerteilen(ab, pool({ gehaeuse: 0, teil: 10 }))
    assert.deepEqual([k.get('leer'), k.get('aus'), k.get('fremd')], [0, 0, 0])
  })

  test('eigener Vorrat (fertige Tastatur) gehört dem Artikel und braucht keine Teile', () => {
    const ab: Abnehmer[] = [
      { ...a('fertig', { gehaeuse: 1 }, 5), eigen: { schluessel: 'v1', menge: 3 } },
      a('andere', { gehaeuse: 1 }, 99),
    ]
    const p = pool({ gehaeuse: 4 })
    const ausEigen = new Map<string, number>()
    const k = kontingentVerteilen(ab, p, ausEigen)
    assert.equal(k.get('fertig'), 5, '3 aus dem Regal, 2 gebaut')
    assert.equal(k.get('andere'), 2)
    assert.deepEqual(kontingentVerletzungen(ab, p, k, ausEigen), [])
  })

  test('das letzte Stück geht an genau ein Angebot', () => {
    const ab = [a('x', { teil: 1 }), a('y', { teil: 1 }), a('z', { teil: 1 })]
    assert.equal(summe(kontingentVerteilen(ab, pool({ teil: 1 }))), 1)
  })

  test('ganze Stücke auch bei 85 Switches je Tastatur: 100 Switches reichen für eine, nicht für zwei halbe', () => {
    const ab = [a('gelb-fr4', { sw: 85 }), a('gelb-pc', { sw: 85 })]
    assert.equal(summe(kontingentVerteilen(ab, pool({ sw: 100 }))), 1)
  })
})

describe('Garantie an zufälligen Sortimenten', () => {
  // Fester Zufall — der Test ist wiederholbar.
  let saat = 20261127
  const zufall = () => {
    saat = (saat * 1664525 + 1013904223) % 4294967296
    return saat / 4294967296
  }
  const ganz = (von: number, bis: number) => von + Math.floor(zufall() * (bis - von + 1))

  test('500 Sortimente: nie über einem Pool, nie über dem Deckel — und nichts bleibt liegen, das noch passte', () => {
    for (let lauf = 0; lauf < 500; lauf++) {
      const teile = Array.from({ length: ganz(1, 12) }, (_, i) => `t${i}`)
      const p = new Map(teile.map((t) => [t, zufall() < 0.15 ? 0 : ganz(0, 400)]))
      const ab: Abnehmer[] = Array.from({ length: ganz(1, 40) }, (_, i) => {
        const bedarf = teile.filter(() => zufall() < 0.35).map((komponente) => ({ komponente, je: [1, 1, 1, 2, 4, 85][ganz(0, 5)] }))
        return {
          id: `a${i}`, bedarf, deckel: zufall() < 0.1 ? 0 : ganz(1, 99),
          gewicht: [0.2, 1, 1, 1, 3, 25][ganz(0, 5)],
          eigen: zufall() < 0.1 ? { schluessel: `e${ganz(0, 3)}`, menge: ganz(0, 6) } : undefined,
        }
      })
      // Angebote mit demselben eigenen Vorrat tragen dieselbe Menge.
      const eigen = new Map<string, number>()
      for (const x of ab) {
        if (!x.eigen) continue
        if (!eigen.has(x.eigen.schluessel)) eigen.set(x.eigen.schluessel, x.eigen.menge)
        x.eigen.menge = eigen.get(x.eigen.schluessel)!
      }

      const ausEigen = new Map<string, number>()
      const k = kontingentVerteilen(ab, p, ausEigen)
      assert.deepEqual(kontingentVerletzungen(ab, p, k, ausEigen), [], `Lauf ${lauf}`)

      // Nichts verschenkt: kein Angebot mit Bedarf könnte noch ein Stück bekommen.
      const frei = new Map(p)
      for (const x of ab) {
        const ausTeilen = k.get(x.id)! - ausEigen.get(x.id)!
        for (const b of x.bedarf) frei.set(b.komponente, frei.get(b.komponente)! - ausTeilen * b.je)
      }
      for (const x of ab) {
        if (x.bedarf.length === 0 || k.get(x.id)! >= x.deckel) continue
        const passt = x.bedarf.every((b) => frei.get(b.komponente)! + 1e-6 >= b.je)
        assert.equal(passt, false, `Lauf ${lauf}: ${x.id} hätte noch ein Stück bekommen können — ${JSON.stringify({ x, k: k.get(x.id), frei: x.bedarf.map((b) => [b.komponente, frei.get(b.komponente)]), eigenImSpiel: ab.some((y) => y.eigen) })}`)
      }
    }
  })
})
