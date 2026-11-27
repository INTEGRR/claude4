import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { artikelListe, jaNein, listeFiltern } from '../src/modules/integrationen/shop-artikel-liste.ts'

/**
 * Shop-Verfügbarkeit, Ansicht „Teile und Artikel" (Entscheidungslog
 * 2026-11-27): eine Liste aus Stücklistenteilen und Shop-Artikeln, mit den
 * Filtern „Stücklistenartikel" und „Shopartikel" und einer Suche.
 */

const teil = (id: string, name: string, sku: string, artikel: number) => ({
  id, name, sku, je: 1, frei: 100, nutzbar: 98, oosUnter: 2, zurueck: false, reicht: 98, artikel,
})
const shopArtikel = (id: string, name: string, sku: string) => ({
  id, templateId: `t-${id}`, name, sku, modus: null, artikelModus: 'auto' as const, frei: 50, oosUnter: null,
  zurueck: false, rueckhalt: 10, hoechstmenge: null, soll: 40, shopQty: 40, shopVerkaufbar: true,
})

const liste = artikelListe(
  [teil('a', 'ESD Sticker', 'ESD-001', 7), teil('b', 'Coiled Cable Black', 'CC-B-001', 6)],
  [shopArtikel('b', 'Coiled Cable Black', 'CC-B-001'), shopArtikel('c', 'Deskmat Größe L', 'DM-L-001')],
)

describe('Shop-Verfügbarkeit: eine Liste aus Teilen und Shop-Artikeln', () => {
  test('jeder Artikel einmal, nach Name; wer beides ist, trägt beides', () => {
    assert.deepEqual(liste.map((z) => z.name), ['Coiled Cable Black', 'Deskmat Größe L', 'ESD Sticker'])
    const kabel = liste[0]
    assert.equal(kabel.stuecklisten, 6)
    assert.equal(kabel.shop?.rueckhalt, 10)
    assert.equal(liste[1].stuecklisten, 0, 'nur Shop-Artikel')
    assert.equal(liste[1].nutzbar, null)
    assert.equal(liste[2].shop, null, 'nur Stücklistenteil')
  })

  test('Filter Stücklistenartikel und Shopartikel, einzeln und zusammen', () => {
    const namen = (f: Parameters<typeof listeFiltern>[1]) => listeFiltern(liste, f).map((z) => z.sku)
    assert.deepEqual(namen({ stueckliste: 'ja', shop: null, q: '' }), ['CC-B-001', 'ESD-001'])
    assert.deepEqual(namen({ stueckliste: 'nein', shop: null, q: '' }), ['DM-L-001'])
    assert.deepEqual(namen({ stueckliste: null, shop: 'ja', q: '' }), ['CC-B-001', 'DM-L-001'])
    assert.deepEqual(namen({ stueckliste: 'ja', shop: 'nein', q: '' }), ['ESD-001'])
    assert.deepEqual(namen({ stueckliste: 'ja', shop: 'ja', q: '' }), ['CC-B-001'])
    assert.deepEqual(namen({ stueckliste: 'nein', shop: 'nein', q: '' }), [])
  })

  test('Suche: jedes Wort in Name oder Artikelnummer, Groß/klein und Umlaute egal', () => {
    const treffer = (q: string) => listeFiltern(liste, { stueckliste: null, shop: null, q }).map((z) => z.sku)
    assert.deepEqual(treffer('cable black'), ['CC-B-001'])
    assert.deepEqual(treffer('esd-001'), ['ESD-001'])
    assert.deepEqual(treffer('grosse'), ['DM-L-001'])
    assert.deepEqual(treffer('gibtsnicht'), [])
  })

  test('Filterwert aus der Adresse: nur ja/nein zählt', () => {
    assert.equal(jaNein('ja'), 'ja')
    assert.equal(jaNein(['nein']), 'nein')
    assert.equal(jaNein('vielleicht'), null)
    assert.equal(jaNein(undefined), null)
  })
})
