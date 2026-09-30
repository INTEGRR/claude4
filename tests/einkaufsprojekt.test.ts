/**
 * Einkaufsprojekt (0097), pur: Zahlen und Staffeln aus Text, Staffelwahl,
 * Positionsblock der Anfrage (auch in umgeschriebenen Vorlagen), Summe und
 * bestes Angebot im Vergleich, EZB-XML und Kursumkehr.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  anfrageBetreff,
  anfrageBlock,
  anfrageBlockEinsetzen,
  angebotSumme,
  bestesAngebot,
  staffelFuer,
  staffelnLesen,
  staffelnText,
  zahlLesen,
} from '../src/modules/einkauf/einkaufsprojekt.ts'
import { eurJeEinheit, ezbFakeXml, ezbXmlLesen } from '../src/modules/einkauf/ezb.ts'

describe('Einkaufsprojekt: Zahlen und Staffeln', () => {
  test('zahlLesen: deutsch, englisch, Tausender bei Mengen', () => {
    assert.equal(zahlLesen('0,85'), 0.85)
    assert.equal(zahlLesen('0.85'), 0.85)
    assert.equal(zahlLesen('1.234,5'), 1234.5)
    assert.equal(zahlLesen('1,234.5'), 1234.5)
    assert.equal(zahlLesen('1.000', 'menge'), 1000)
    assert.equal(zahlLesen('1.000', 'preis'), 1)
    assert.equal(zahlLesen('2,000', 'menge'), 2000)
    assert.equal(zahlLesen('$ 3.20'), 3.2)
    assert.equal(zahlLesen('abc'), null)
  })

  test('staffelnLesen: Formate, Sortierung, Doppelte, Fehler', () => {
    const { staffeln, fehler } = staffelnLesen('ab 1.000 = 0,72\n500: 0,85\n2000 pcs → 0.65 USD\n\n# Kommentar\n500: 0,80\nsiehe PDF')
    assert.deepEqual(staffeln, [
      { ab_menge: 500, preis: 0.8 },
      { ab_menge: 1000, preis: 0.72 },
      { ab_menge: 2000, preis: 0.65 },
    ])
    assert.deepEqual(fehler, ['„siehe PDF" ist keine Staffel (Format „Menge: Preis")'])
    assert.deepEqual(staffelnLesen('4,20').staffeln, [{ ab_menge: 1, preis: 4.2 }], 'nur Preis = ab 1 Stück')
    assert.deepEqual(staffelnLesen('1 000: 0,5').staffeln, [{ ab_menge: 1000, preis: 0.5 }])
    assert.equal(staffelnText([{ ab_menge: 1000, preis: 0.72 }, { ab_menge: '500', preis: '0.85' }]), '1.000: 0,72\n500: 0,85')
  })

  test('staffelFuer: größte Staffel ≤ Menge, sonst die kleinste', () => {
    const s = [{ ab_menge: 300 }, { ab_menge: 1000 }, { ab_menge: 100 }]
    assert.equal(staffelFuer(s, 500)?.ab_menge, 300)
    assert.equal(staffelFuer(s, 1000)?.ab_menge, 1000)
    assert.equal(staffelFuer(s, 50)?.ab_menge, 100)
    assert.equal(staffelFuer([], 50), undefined)
  })
})

describe('Einkaufsprojekt: Anfrage-Text', () => {
  const projekt = { nummer: 'EP/00007', titel: 'Foam-Einlagen', zieltermin: '2026-11-30' }
  const positionen = [{ bezeichnung: 'Foam 60 %', menge: 1500, spezifikation: 'EVA\nschwarz' }]

  test('Block je Sprache: Referenz, Positionen mit Einheit, Termin — kein Zielpreis', () => {
    assert.equal(
      anfrageBlock('de', projekt, positionen),
      'Unsere Referenz: EP/00007 – Foam-Einlagen\n\n1. Foam 60 % (EVA; schwarz) – Menge: 1.500 Stück\n\nGewünschter Liefertermin: 30.11.2026',
    )
    assert.match(anfrageBlock('en', { ...projekt, zieltermin: null }, positionen), /Quantity: 1,500 pcs\n\nRequired delivery date: to be agreed$/)
    assert.match(anfrageBlock('zh', projekt, [{ bezeichnung: 'Foam', menge: 2, einheit: 'Dutzend' }]), /数量：2 打/)
    assert.equal(anfrageBetreff('en', projekt), 'Request for quotation EP/00007 – Foam-Einlagen')
  })

  test('Einsetzen: an die Stelle der leeren Stichpunkte, sonst nach der Anrede', () => {
    const vorlage = 'Guten Tag Frau Li,\n\nbitte um Angebot:\n\n- Artikel:\n- Menge(n):\n- Gewünschter Liefertermin:\n\nDanke'
    assert.equal(anfrageBlockEinsetzen(vorlage, 'BLOCK', 'de'), 'Guten Tag Frau Li,\n\nbitte um Angebot:\n\nBLOCK\n\nDanke')
    const eigen = 'Hello Lily,\n\nplease quote.\n\nThanks'
    assert.equal(anfrageBlockEinsetzen(eigen, 'BLOCK', 'en'), 'Hello Lily,\n\nplease quote.\n\nBLOCK\n\nThanks')
    assert.equal(anfrageBlockEinsetzen('Kurz', 'BLOCK', 'de'), 'Kurz\n\nBLOCK')
  })
})

describe('Einkaufsprojekt: Vergleich', () => {
  const zeile = (einstand: number | null, ziel: number | null, menge = 100, hinweise: string[] = []) => ({
    position_id: 'p',
    menge,
    einstand_eur: einstand,
    zielpreis_eur: ziel,
    hinweise,
  })

  test('Summe, Ziel und Abweichung; unvollständig ohne Preis oder Kurs', () => {
    assert.deepEqual(angebotSumme([zeile(2, 2.5), zeile(1, 1)]), {
      gesamt: 300,
      ziel: 350,
      abweichungPct: -14.3,
      vollstaendig: true,
      hinweise: [],
    })
    const ohneKurs = angebotSumme([zeile(null, 2, 100, ['kein_kurs'])])
    assert.equal(ohneKurs.gesamt, null)
    assert.equal(ohneKurs.vollstaendig, false)
    assert.equal(angebotSumme([zeile(2, null)]).abweichungPct, null, 'ohne Zielpreis keine Abweichung')
  })

  test('bestesAngebot: günstigstes vollständiges, verworfene zählen nicht', () => {
    const s = (gesamt: number | null) => ({ gesamt, ziel: null, abweichungPct: null, vollstaendig: gesamt !== null, hinweise: [] })
    assert.equal(
      bestesAngebot([
        { id: 'a', verworfen: false, summe: s(500) },
        { id: 'b', verworfen: true, summe: s(100) },
        { id: 'c', verworfen: false, summe: s(null) },
        { id: 'd', verworfen: false, summe: s(400) },
      ]),
      'd',
    )
    assert.equal(bestesAngebot([]), null)
  })
})

describe('EZB-Kurse', () => {
  test('XML lesen und umkehren (EUR je Fremdeinheit)', () => {
    const { datum, kurse } = ezbXmlLesen(ezbFakeXml('2026-09-29'))
    assert.equal(datum, '2026-09-29')
    assert.equal(kurse.USD, 1.08)
    assert.equal(kurse.CNY, 7.8)
    assert.equal(eurJeEinheit(1.08), 0.92592593)
    assert.equal(eurJeEinheit(7.8), 0.12820513)
  })

  test('echtes Format mit doppelten Anführungszeichen; Fehler statt leerer Kurse', () => {
    const xml = '<Cube><Cube time="2026-09-30"><Cube currency="USD" rate="1.1234"/></Cube></Cube>'
    assert.deepEqual(ezbXmlLesen(xml), { datum: '2026-09-30', kurse: { USD: 1.1234 } })
    assert.throws(() => ezbXmlLesen('<html>Wartung</html>'), /ohne Datum/)
    assert.throws(() => ezbXmlLesen('<Cube time="2026-09-30"></Cube>'), /ohne Kurse/)
  })
})
