import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { azyklik, entwurfPruefen, erreichbarkeit, xorRegeln } from '../src/modules/prozesse/entwurf-pruefen.ts'

/**
 * BUG/00015: Ein von der KI umgebauter Verkaufsprozess ließ sich nicht
 * aktivieren — der XOR-Schritt „Fertigung nötig?" hatte ZWEI bedingungslose
 * Kanten. Der Entwurf war klaglos entstanden; der Fehler kam erst beim
 * Aktivieren, wo niemand mehr etwas ändern konnte.
 *
 * Diese Regeln prüfen jetzt schon den Entwurf. Sie sind pur — dieselben
 * Regeln stehen hart in prozess_version_aktivieren (SQL) und bleiben dort
 * die letzte Instanz.
 */

const SCHRITTE = [
  { code: 'start', art: 'start' },
  { code: 'pruefen', art: 'aktion' },
  { code: 'weiche', art: 'xor' },
  { code: 'fertigen', art: 'aktion' },
  { code: 'liefern', art: 'aktion' },
  { code: 'ende', art: 'ende' },
]

const GERADE = [
  { von: 'start', nach: 'pruefen' },
  { von: 'pruefen', nach: 'weiche' },
  { von: 'weiche', nach: 'fertigen', bedingung: { feld: 'fertigung_noetig', op: '=', wert: true } },
  { von: 'weiche', nach: 'liefern' },
  { von: 'fertigen', nach: 'liefern' },
  { von: 'liefern', nach: 'ende' },
]

describe('XOR-Regeln', () => {
  test('eine bedingte Kante plus Standardweg zuletzt ist in Ordnung', () => {
    assert.equal(xorRegeln(SCHRITTE, GERADE), null)
    assert.equal(entwurfPruefen(SCHRITTE, GERADE), null)
  })

  test('zwei bedingungslose Kanten werden abgelehnt — genau BUG/00015', () => {
    const kaputt = GERADE.map((u) =>
      u.von === 'weiche' && u.nach === 'fertigen' ? { von: u.von, nach: u.nach } : u,
    )
    const fehler = xorRegeln(SCHRITTE, kaputt)
    assert.ok(fehler, 'zwei Default-Kanten müssen auffallen')
    assert.match(fehler, /weiche/)
    assert.match(fehler, /höchstens eine bedingungslos/)
  })

  test('der Standardweg muss die letzte Kante sein', () => {
    const vertauscht = [
      ...GERADE.filter((u) => u.von !== 'weiche'),
      { von: 'weiche', nach: 'liefern' },
      { von: 'weiche', nach: 'fertigen', bedingung: { feld: 'x', op: '=', wert: 1 } },
    ]
    // Reihenfolge zählt: erst die bedingungslose, dann die bedingte.
    const sortiert = [
      { von: 'start', nach: 'pruefen' },
      { von: 'pruefen', nach: 'weiche' },
      { von: 'weiche', nach: 'liefern' },
      { von: 'weiche', nach: 'fertigen', bedingung: { feld: 'x', op: '=', wert: 1 } },
      { von: 'fertigen', nach: 'liefern' },
      { von: 'liefern', nach: 'ende' },
    ]
    assert.equal(vertauscht.length, sortiert.length)
    const fehler = xorRegeln(SCHRITTE, sortiert)
    assert.ok(fehler)
    assert.match(fehler, /LETZTE/)
  })

  test('ein XOR mit genau einem Ausgang braucht keine Bedingung', () => {
    const einer = [
      { von: 'start', nach: 'weiche' },
      { von: 'weiche', nach: 'ende' },
    ]
    assert.equal(
      xorRegeln([{ code: 'start', art: 'start' }, { code: 'weiche', art: 'xor' }, { code: 'ende', art: 'ende' }], einer),
      null,
    )
  })
})

describe('Erreichbarkeit und Schleifen', () => {
  test('ein Schritt ohne Weg vom Start fällt auf', () => {
    const ohneKante = GERADE.filter((u) => u.nach !== 'fertigen')
    const fehler = erreichbarkeit(SCHRITTE, ohneKante)
    assert.ok(fehler)
    assert.match(fehler, /fertigen/)
  })

  test('eine Schleife fällt auf und wird benannt', () => {
    const schleife = [...GERADE, { von: 'liefern', nach: 'pruefen' }]
    const fehler = azyklik(SCHRITTE, schleife)
    assert.ok(fehler)
    assert.match(fehler, /Schleife/)
    for (const code of ['pruefen', 'weiche', 'liefern']) assert.match(fehler, new RegExp(code))
  })

  test('der gerade Prozess hat weder Sackgasse noch Schleife', () => {
    assert.equal(erreichbarkeit(SCHRITTE, GERADE), null)
    assert.equal(azyklik(SCHRITTE, GERADE), null)
  })
})
