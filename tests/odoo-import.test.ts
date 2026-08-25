import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  attributAnzeige,
  bestellGid,
  billBezahlt,
  billState,
  billingStatus,
  bomTyp,
  bomVerbrauch,
  faelligkeitsTyp,
  firmenwert,
  htmlZuText,
  invoiceStatus,
  istShopifyRef,
  kgZuGramm,
  kostenAuswahl,
  kundenGid,
  moState,
  nameTeilen,
  nummernMaximum,
  repairState,
  saleState,
  uebersetzung,
  uomRatio,
  variantenSchluessel,
} from '../src/modules/migration/odoo/mapper.ts'

/**
 * Die Mapper sind der Vertrag zwischen dem Odoo-Dump und den
 * KRNL-Schreibwegen — jede Umformung hier ist mit echten Werten aus dem
 * ANVIL-Dump belegt (Stichproben vom 2026-08-24).
 */
describe('Odoo-Übernahme: Übersetzungen und Skalare', () => {
  it('zieht Deutsch vor Englisch und fällt sauber zurück', () => {
    assert.equal(uebersetzung({ de_DE: 'Dutzende', en_US: 'Dozens' }), 'Dutzende')
    // Die Odoo-Einheit „g" trägt nur en_US — echter Dump-Fall.
    assert.equal(uebersetzung({ en_US: 'g' }), 'g')
    assert.equal(uebersetzung('Rohtext'), 'Rohtext')
    assert.equal(uebersetzung(null, 'Ersatz'), 'Ersatz')
    assert.equal(uebersetzung({}, 'Ersatz'), 'Ersatz')
  })

  it('rechnet Odoo-factor in KRNL-ratio um — auch über abweichende Referenzen', () => {
    // Dutzend: factor 0,0833… bei Referenz Stück (KRNL-ratio 1) → 12, ohne Float-Müll.
    assert.equal(uomRatio(0.08333333333333333, 1), 12)
    assert.equal(uomRatio(0.01, 1), 100) // Hunderte
    // Gramm: Odoo-Referenz ist kg, KRNL-Referenz ist g (kg hat KRNL-ratio 1000).
    assert.equal(uomRatio(1000, 1000), 1)
    assert.equal(uomRatio(1, 1000), 1000) // Odoo-kg selbst
    assert.throws(() => uomRatio(0, 1), /factor/)
  })

  it('baut Shopify-GIDs aus den nackten Odoo-Zahlen', () => {
    assert.equal(kundenGid('8460497289480'), 'gid://shopify/Customer/8460497289480')
    assert.equal(bestellGid(6579140624648), 'gid://shopify/Order/6579140624648')
    assert.equal(istShopifyRef('6579140624648'), true)
    assert.equal(istShopifyRef('S00013'), false)
    assert.equal(istShopifyRef(''), false)
  })

  it('wandelt kg in Gramm und behandelt Null als „kein Gewicht"', () => {
    assert.equal(kgZuGramm(1.234), 1234)
    assert.equal(kgZuGramm(0.0005), 1)
    assert.equal(kgZuGramm(0), null)
    assert.equal(kgZuGramm(null), null)
  })

  it('strippt Odoo-HTML zu schlichtem Text', () => {
    assert.equal(htmlZuText('<p>Bitte <b>vorab</b> anrufen</p>'), 'Bitte vorab anrufen')
    assert.equal(htmlZuText('<p>Zeile 1</p><p>Zeile 2 &amp; 3</p>'), 'Zeile 1\nZeile 2 & 3')
    assert.equal(htmlZuText('<p><br></p>'), null)
    assert.equal(htmlZuText(null), null)
  })

  it('liest firmenabhängige jsonb-Werte ({"1": 25.0})', () => {
    assert.equal(firmenwert({ '1': 25.0 }), 25)
    assert.equal(firmenwert(3), 3)
    assert.equal(firmenwert({}), null)
    assert.equal(firmenwert(null), null)
  })

  it('trennt Vor- und Nachnamen anhand des Studio-Feldes', () => {
    assert.deepEqual(nameTeilen('Robert Dahlke', 'Robert'), {
      vorname: 'Robert',
      nachname: 'Dahlke',
    })
    // Name beginnt nicht mit dem Vornamen (Odoo führt nur den Nachnamen).
    assert.deepEqual(nameTeilen('Dahlke', 'Robert'), { vorname: 'Robert', nachname: 'Dahlke' })
    // Firmenkontakt ohne Vornamen bleibt unangetastet.
    assert.deepEqual(nameTeilen('FLYERALARM GmbH', null), { vorname: null, nachname: null })
  })
})

describe('Odoo-Übernahme: Zustands-Karten', () => {
  it('mappt die Belegzustände — Odoo-Nachbau heißt meist 1:1', () => {
    assert.equal(saleState('sale'), 'sale')
    assert.equal(saleState('cancel'), 'cancel')
    assert.equal(invoiceStatus('to invoice'), 'to_invoice') // Leerzeichen → Unterstrich!
    assert.equal(billingStatus('no'), 'nothing')
    assert.equal(billingStatus('invoiced'), 'fully_billed')
    assert.equal(moState('to_close'), 'to_close')
    assert.equal(repairState('draft'), 'new')
    assert.equal(repairState('done'), 'repaired')
    assert.equal(billState('posted'), 'posted')
    assert.equal(billBezahlt('in_payment'), true)
    assert.equal(billBezahlt('not_paid'), false)
    assert.equal(bomTyp('phantom'), 'kit')
    assert.equal(bomVerbrauch('warning'), 'warning')
    assert.equal(attributAnzeige('radio'), 'radio')
  })

  it('wirft bei unbekannten Werten, statt still zu raten', () => {
    assert.throws(() => saleState('locked'), /sale_state.*locked/)
    assert.throws(() => invoiceStatus(null), /invoice_status/)
    assert.throws(() => bomTyp('subcontract'), /bom_type/)
  })

  it('nähert die drei Odoo-Fälligkeitsanker auf die zwei von KRNL an', () => {
    assert.equal(faelligkeitsTyp('days_after'), 'days_after')
    assert.equal(faelligkeitsTyp('days_end_of_month_on_the'), 'days_after_end_of_month')
    assert.equal(faelligkeitsTyp('days_after_end_of_next_month'), 'days_after_end_of_month')
  })
})

describe('Odoo-Übernahme: Varianten-Matching und Kosten', () => {
  it('bildet reihenfolge- und schreibweisen-unabhängige Varianten-Schlüssel', () => {
    const a = variantenSchluessel([
      { attribut: 'Farbe', wert: 'Nexus White' },
      { attribut: 'Layout', wert: 'ISO-DE' },
    ])
    const b = variantenSchluessel([
      { attribut: 'layout', wert: 'iso-de' },
      { attribut: 'FARBE', wert: 'nexus white' },
    ])
    assert.equal(a, b)
    assert.notEqual(a, variantenSchluessel([{ attribut: 'Farbe', wert: 'Plague Black' }]))
    assert.equal(variantenSchluessel([]), '')
  })

  it('leitet Kosten über die Fallback-Kette her — Odoo pflegt sie lückenhaft', () => {
    assert.deepEqual(kostenAuswahl({ layer: 24.567, standardPreis: 25, lieferant: 20 }), {
      wert: 24.57,
      quelle: 'layer',
    })
    assert.deepEqual(kostenAuswahl({ layer: null, standardPreis: 25, lieferant: 20 }), {
      wert: 25,
      quelle: 'standardpreis',
    })
    assert.deepEqual(kostenAuswahl({ layer: 0, standardPreis: null, lieferant: 3 }), {
      wert: 3,
      quelle: 'lieferant',
    })
    assert.deepEqual(kostenAuswahl({ layer: null, standardPreis: null, lieferant: null }), {
      wert: 0,
      quelle: 'keine',
    })
  })
})

describe('Odoo-Übernahme: Belegnummern', () => {
  it('findet das Nummern-Maximum je Kreis für den Sequenz-Restart', () => {
    assert.equal(nummernMaximum(['S00013', 'S00830', 'P00007', null], 'S'), 830)
    assert.equal(nummernMaximum(['WH/OUT/00830', 'WH/OUT/01102', 'WH/IN/00099'], 'WH/OUT/'), 1102)
    // Das KRNL-eigene Format darf nicht auf fremde Kreise anspringen.
    assert.equal(nummernMaximum(['S00013'], 'P'), 0)
    assert.equal(nummernMaximum([], 'S'), 0)
  })
})
