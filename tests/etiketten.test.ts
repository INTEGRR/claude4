/**
 * Etiketten (Fertigungs- und Artikel-Etikett, Entscheidungslog 2026-10-01):
 * der rechnende Teil ohne Datenbank. Die Barcodes werden aus den Balken
 * zurückgelesen, die ins PDF gehen — ein Code-128-Decoder mit der
 * Mustertabelle der Norm prüft Startzeichen, Prüfsumme (bekannte
 * Testvektoren) und Inhalt; dazu EAN-13-Prüfziffern, Formate, die
 * Flächenaufteilung je Etikettengröße und das gerenderte PDF.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import {
  CODE_MIN_MM,
  ETIKETT_STANDARD_MM,
  MAX_ETIKETTEN_JE_DRUCK,
  MODUL_MAX_MM,
  type Strichcode,
  ZEILENHOEHE,
  artikelCode,
  balkenPfad,
  codeMasse,
  ean13Gueltig,
  ean13Pruefziffer,
  etikettFormat,
  mmZuPt,
  positionenAlsParameter,
  positionenAusParameter,
  strichcode,
} from '../src/modules/druck/etikett-layout.ts'
import {
  type ArtikeletikettDaten,
  type FertigungsetikettDaten,
  artikeletikettPlan,
  artikeletikettenPdf,
  fertigungsetikettPlan,
  fertigungsetikettenPdf,
} from '../src/modules/druck/etikett-pdf.ts'
import { scanVarianten } from '../src/modules/shared/scan.ts'
import { aktionPruefen } from '../src/modules/prozesse/torwaechter.ts'

// --- Code-128-Decoder (unabhängig von bwip-js) -------------------------------

/** Balken/Lücken-Muster der Werte 0 … 105 (ISO/IEC 15417), Stopp separat. */
const MUSTER = `212222 222122 222221 121223 121322 131222 122213 122312 132212 221213
221312 231212 112232 122132 122231 113222 123122 123221 223211 221132
221231 213212 223112 312131 311222 321122 321221 312212 322112 322211
212123 212321 232121 111323 131123 131321 112313 132113 132311 211313
231113 231311 112133 112331 132131 113123 113321 133121 313121 211331
231131 213113 213311 213131 311123 311321 331121 312113 312311 332111
314111 221411 431111 111224 111422 121124 121421 141122 141221 112214
112412 122114 122411 142112 142211 241211 221114 413111 241112 134111
111242 121142 121241 114212 124112 124211 411212 421112 421211 212141
214121 412121 111143 111341 131141 114113 114311 411113 411311 113141
114131 311141 411131 211412 211214 211232`.split(/\s+/)
const STOPP = '2331112'
const WERT = new Map(MUSTER.map((m, i) => [m, i]))

/** Aus den Balken (wie sie ins PDF gehen) wieder Breiten: Balken, Lücke, Balken … */
function breiten(code: Strichcode): number[] {
  const aus: number[] = []
  code.balken.forEach((b, i) => {
    aus.push(b.breite)
    const naechster = code.balken[i + 1]
    if (naechster) aus.push(naechster.x - (b.x + b.breite))
  })
  return aus
}

function code128Werte(code: Strichcode): number[] {
  const sbs = breiten(code)
  assert.equal(sbs.slice(-7).join(''), STOPP, 'Stoppzeichen')
  const werte: number[] = []
  for (let i = 0; i < sbs.length - 7; i += 6) {
    const wert = WERT.get(sbs.slice(i, i + 6).join(''))
    assert.ok(wert !== undefined, `unbekanntes Muster an Stelle ${i}`)
    werte.push(wert)
  }
  return werte
}

/** Liest Text (Zeichensätze A/B/C mit Umschaltung) und prüft die Prüfsumme. */
function code128Lesen(code: Strichcode): string {
  const werte = code128Werte(code)
  const [start, ...rest] = werte
  const pruef = rest.pop()!
  const summe = rest.reduce((a, v, i) => a + v * (i + 1), start)
  assert.equal(summe % 103, pruef, 'Prüfsumme (mod 103)')
  let satz = start === 103 ? 'A' : start === 104 ? 'B' : 'C'
  let text = ''
  for (const v of rest) {
    if (satz === 'C') {
      if (v < 100) text += String(v).padStart(2, '0')
      else satz = v === 100 ? 'B' : 'A'
      continue
    }
    if (v === 99) satz = 'C'
    else if (satz === 'B' && v === 101) satz = 'A'
    else if (satz === 'A' && v === 100) satz = 'B'
    else if (satz === 'B') text += String.fromCharCode(v + 32)
    else text += String.fromCharCode(v < 64 ? v + 32 : v - 64)
  }
  return text
}

describe('Code 128 aus den Balken des Etiketts', () => {
  test('bekannter Testvektor „Wikipedia": Start B, Werte und Prüfzeichen 88', () => {
    const werte = code128Werte(strichcode('Wikipedia'))
    assert.deepEqual(werte, [104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88])
  })

  test('reine Ziffernfolge läuft in Zeichensatz C (Prüfzeichen 85 für 1234567890)', () => {
    assert.deepEqual(code128Werte(strichcode('1234567890')), [105, 12, 34, 56, 78, 90, 85])
  })

  test('MO-Nummern kommen unverändert zurück — Breite = 11 Module je Zeichen + 13 Stopp', () => {
    for (const nummer of ['MO/00012', 'WH/MO/00012', 'MO/12345', 'KC-001', 'AN-1800-W-GY']) {
      const code = strichcode(nummer)
      assert.equal(code128Lesen(code), nummer)
      assert.equal(code.module, (code128Werte(code).length) * 11 + 13)
      assert.equal(code.ruhezone, 10)
    }
  })

  test('das Scanfeld findet die Nummer auch vom Scanner mit US-Belegung (/ wird -)', () => {
    const gedruckt = code128Lesen(strichcode('MO/00012'))
    assert.ok(scanVarianten(gedruckt.replaceAll('/', '-')).includes('MO/00012'))
  })

  test('der Pfad zeichnet jeden Balken, links mit Ruhezone', () => {
    const code = strichcode('MO/00012')
    const masse = codeMasse(code, mmZuPt(90), 40)
    const pfad = balkenPfad(code, masse)
    assert.equal(pfad.match(/M/g)?.length, code.balken.length)
    assert.ok(pfad.startsWith(`M${Math.round(10 * masse.modulPt * 1000) / 1000} 0h`))
    assert.ok(masse.modulPt <= mmZuPt(MODUL_MAX_MM) + 1e-9, 'höchstens 0,4 mm je Modul')
    assert.ok(Math.abs(masse.breitePt - masse.modulPt * (code.module + 20)) < 1e-6)
  })

  test('ein langer Wert wird schmaler, bleibt aber samt Ruhezonen in der Breite', () => {
    const code = strichcode('WH/MO/00012-SEHR-LANGER-ZUSATZ')
    const masse = codeMasse(code, mmZuPt(50), 30)
    assert.ok(masse.breitePt <= mmZuPt(50) + 1e-6)
    assert.ok(masse.modulPt < mmZuPt(MODUL_MAX_MM))
  })
})

describe('Artikel-Code: EAN-13 oder Code 128', () => {
  test('EAN-13-Prüfziffern bekannter Codes', () => {
    assert.equal(ean13Pruefziffer('400638133393'), 1)
    assert.equal(ean13Pruefziffer('978020137962'), 4)
    assert.equal(ean13Pruefziffer('590123412345'), 7)
    assert.equal(ean13Gueltig('4006381333931'), true)
    assert.equal(ean13Gueltig('4006381333932'), false, 'falsche Prüfziffer')
    assert.equal(ean13Gueltig('400638133393'), false, 'zwölf Ziffern')
    assert.throws(() => ean13Pruefziffer('40063813339X'))
  })

  test('Wahl: gültige EAN als EAN-13, anderer Barcode als Code 128, sonst SKU, sonst nichts', () => {
    assert.deepEqual(artikelCode('4006381333931', 'AN-1'), { wert: '4006381333931', symbol: 'ean13' })
    assert.deepEqual(artikelCode('4006381333932', 'AN-1'), { wert: '4006381333932', symbol: 'code128' })
    assert.deepEqual(artikelCode(' X-77 ', 'AN-1'), { wert: 'X-77', symbol: 'code128' })
    assert.deepEqual(artikelCode(null, 'AN-1'), { wert: 'AN-1', symbol: 'code128' })
    assert.deepEqual(artikelCode('  ', ''), null)
  })

  test('EAN-13 hat 95 Module und 11 Module Ruhezone', () => {
    const code = strichcode('4006381333931', 'ean13')
    assert.equal(code.module, 95)
    assert.equal(code.ruhezone, 11)
    assert.throws(() => strichcode('4006381333932', 'ean13'), /EAN-13/)
  })
})

describe('Etikettenformat und Flächenaufteilung', () => {
  test('Maße des Druckers, sonst 100 × 50 mm', () => {
    assert.deepEqual(
      [etikettFormat('62', '29').breiteMm, etikettFormat('62', '29').hoeheMm],
      [62, 29],
    )
    for (const [b, h] of [[null, null], [62, null], [0, 50], [1000, 50], ['abc', 50]] as const) {
      const f = etikettFormat(b, h)
      assert.deepEqual([f.breiteMm, f.hoeheMm], [ETIKETT_STANDARD_MM.breite, ETIKETT_STANDARD_MM.hoehe])
    }
    assert.ok(Math.abs(etikettFormat(100, 50).breitePt - 283.465) < 0.01)
  })

  const MO: FertigungsetikettDaten = {
    number: 'MO/00012',
    produkt: 'Anvil Native 1800 (Farbe: Weiß, Schalter: Gateron Yellow Linear)',
    sku: 'AN-1800-W-GY',
    menge: 5,
    einheit: 'Stück',
    termin: '2026-10-03',
    auftrag: 'SO/00123',
    shopifyName: '#1234',
    kunde: 'Max Mustermann',
    komponenten: 20,
  }
  const ARTIKEL: ArtikeletikettDaten = {
    name: 'Anvil Native 1800',
    merkmale: 'Farbe: Weiß · Schalter: Gateron Yellow Linear',
    sku: 'AN-1800-W-GY',
    barcode: '4006381333931',
  }

  const FORMATE = [[100, 50], [62, 29], [57, 32], [50, 25], [103, 150]] as const

  test('Fertigungsetikett: alles passt in die Innenfläche, der Code wird nie zu flach', () => {
    for (const [b, h] of FORMATE) {
      const format = etikettFormat(b, h)
      const { layout: l } = fertigungsetikettPlan(MO, format)
      const zeilen = [
        l.schrift.nummer,
        l.nameZeilen * l.schrift.name,
        l.details ? l.schrift.text : 0,
        l.auftrag ? l.schrift.text : 0,
      ]
      const belegt =
        l.code.hoehePt +
        zeilen.reduce((a, z) => a + z * ZEILENHOEHE, 0) +
        zeilen.filter((z) => z > 0).length * l.luftPt
      assert.ok(belegt <= format.hoehePt - 2 * l.randPt + 0.01, `${b}×${h}: ${belegt} pt passen nicht`)
      assert.ok(l.code.breitePt <= l.innenBreitePt + 0.01, `${b}×${h}: Code zu breit`)
      if (h >= 29) assert.ok(l.code.hoehePt >= mmZuPt(CODE_MIN_MM) - 0.01, `${b}×${h}: Code zu flach`)
    }
    const gross = fertigungsetikettPlan(MO, etikettFormat(100, 50)).layout
    assert.deepEqual([gross.nameZeilen, gross.details, gross.auftrag], [2, true, true], '100 × 50 zeigt alles')
    const klein = fertigungsetikettPlan(MO, etikettFormat(50, 25)).layout
    assert.equal(klein.nameZeilen, 1, 'auf 50 × 25 wird zuerst der Name gekürzt')
  })

  test('Artikel-Etikett: passt, SKU-Zeile nur, wenn der Code nicht schon die SKU ist', () => {
    for (const [b, h] of FORMATE) {
      const format = etikettFormat(b, h)
      const plan = artikeletikettPlan(ARTIKEL, format)!
      const l = plan.layout
      const zeilen = [l.nameZeilen * l.schrift.name, l.merkmalZeilen * l.schrift.merkmale, l.schrift.klartext, l.sku ? l.schrift.sku : 0]
      const belegt =
        l.code.hoehePt +
        zeilen.reduce((a, z) => a + z * ZEILENHOEHE, 0) +
        zeilen.filter((z) => z > 0).length * l.luftPt
      assert.ok(belegt <= format.hoehePt - 2 * l.randPt + 0.01, `${b}×${h}: ${belegt} pt passen nicht`)
      if (h >= 29) assert.ok(l.code.hoehePt >= mmZuPt(CODE_MIN_MM) - 0.01, `${b}×${h}: Code zu flach`)
    }
    const mitEan = artikeletikettPlan(ARTIKEL, etikettFormat(100, 50))!
    assert.equal(mitEan.code.symbol, 'ean13')
    assert.equal(mitEan.layout.sku, true, 'EAN auf dem Code → SKU als Zeile')
    const nurSku = artikeletikettPlan({ ...ARTIKEL, barcode: null }, etikettFormat(100, 50))!
    assert.equal(nurSku.code.wert, 'AN-1800-W-GY')
    assert.equal(nurSku.layout.sku, false, 'die SKU steht schon unter dem Code')
    assert.equal(artikeletikettPlan({ ...ARTIKEL, barcode: null, sku: null }, etikettFormat(100, 50)), null)
  })

  test('PDF: eine Seite je Etikett bzw. Kopie, Seitengröße = Etikett', async () => {
    const mm = (pt: number) => (pt / 72) * 25.4
    const fertigung = await PDFDocument.load(
      await fertigungsetikettenPdf([MO, { ...MO, number: 'MO/00013', auftrag: null, kunde: null }], etikettFormat(62, 29)),
    )
    assert.equal(fertigung.getPageCount(), 2)
    const { width, height } = fertigung.getPage(0).getSize()
    assert.deepEqual([Math.round(mm(width)), Math.round(mm(height))], [62, 29])

    const artikel = await PDFDocument.load(
      await artikeletikettenPdf(
        [{ daten: ARTIKEL, anzahl: 3 }, { daten: { ...ARTIKEL, barcode: null, name: 'Keycaps' }, anzahl: 2 }],
        etikettFormat(null, null),
      ),
    )
    assert.equal(artikel.getPageCount(), 5, '3 + 2 Kopien')
    const seite = artikel.getPage(4).getSize()
    assert.deepEqual([Math.round(mm(seite.width)), Math.round(mm(seite.height))], [100, 50])

    await assert.rejects(
      artikeletikettenPdf([{ daten: { ...ARTIKEL, barcode: null, sku: null }, anzahl: 1 }], etikettFormat(100, 50)),
      /weder Barcode noch SKU/,
    )
  })
})

describe('Artikel-Etiketten: Positionen im Link und im Formular', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'

  test('Link hin und zurück, gleiche Varianten zusammengefasst, Grenzen greifen', () => {
    const text = positionenAlsParameter([{ variantId: A, anzahl: 3 }, { variantId: B, anzahl: 1 }])
    assert.equal(text, `${A}:3,${B}:1`)
    assert.deepEqual(positionenAusParameter(text), [{ variantId: A, anzahl: 3 }, { variantId: B, anzahl: 1 }])
    assert.deepEqual(positionenAusParameter(`${A}:2,${A.toUpperCase()}:5`), [{ variantId: A, anzahl: 7 }])
    assert.deepEqual(positionenAusParameter(`${A}:9999`), [{ variantId: A, anzahl: 500 }])
    assert.deepEqual(positionenAusParameter(`kaputt:3,${A}:0,${B}:-1,${B}`), [{ variantId: B, anzahl: 1 }])
    assert.deepEqual(positionenAusParameter(null), [])
    const viele = Array.from({ length: 6 }, (_, i) => `${A.slice(0, -1)}${i}:500`).join(',')
    const summe = positionenAusParameter(viele).reduce((a, p) => a + p.anzahl, 0)
    assert.equal(summe, MAX_ETIKETTEN_JE_DRUCK, 'insgesamt höchstens 2000 Seiten')
  })

  test('Formular: je Zeile variant_id + anzahl, 0 oder leer lässt die Zeile aus', () => {
    const fd = new FormData()
    for (const [id, anzahl] of [[A, '4'], [B, '0'], [B, '']]) {
      fd.append('variant_id', id)
      fd.append('anzahl', anzahl)
    }
    const { werte } = aktionPruefen('lager.artikeletikett_drucken', { formData: fd })
    assert.deepEqual(werte.positionen, [{ variant_id: A, anzahl: 4 }])

    const zuViel = new FormData()
    zuViel.append('variant_id', A)
    zuViel.append('anzahl', '501')
    assert.throws(() => aktionPruefen('lager.artikeletikett_drucken', { formData: zuViel }), /500/)
    const leer = new FormData()
    leer.append('variant_id', A)
    leer.append('anzahl', '0')
    assert.throws(() => aktionPruefen('lager.artikeletikett_drucken', { formData: leer }), /mindestens eine Variante/)
  })

  test('Fertigungsetikett nimmt die Auswahl der Liste (ids) an', () => {
    const fd = new FormData()
    fd.append('ids', A)
    fd.append('ids', B)
    const { werte } = aktionPruefen('fertigung.etikett_drucken', { formData: fd })
    assert.deepEqual(werte.ids, [A, B])
    assert.throws(() => aktionPruefen('fertigung.etikett_drucken', { parameter: { ids: ['MO/00012'] } }))
  })
})
