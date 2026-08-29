/**
 * Die Kombi-Aktionen (Auftrag/Bestellung mit Positionen) über den echten
 * Produktionspfad — der Nachweis, dass die Komposition aus auftragAnlegen/
 * bestellungAnlegen + positionHinzufuegen die volle Fachlogik mitbringt:
 * Lieferadresse, Einheit, Listenpreis, Staffelpreis und Steuersatz
 * (Entscheidungslog 2026-08-27).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_kombi_check'
const ADMIN = { name: 'kombi-test', role: 'admin' as const }

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)

  // Stammdaten über dieselben Registry-Aktionen, die auch die KI nutzt.
  await aktionAusfuehrenGeprueft(
    'kontakte.partner_anlegen',
    {
      parameter: {
        name: 'Tastatur Emporium',
        is_company: true,
        street: 'Tastenweg',
        house_number: '1',
        zip: '01234',
        city: 'Klackhausen',
      },
    },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft(
    'kontakte.partner_anlegen',
    { parameter: { name: 'Schalterwerk', is_company: true, is_customer: false, is_vendor: true } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft(
    'produkte.produkt_anlegen',
    { parameter: { name: 'Kombi Keyboard', sku: 'KOMBI-KB', verkaufspreis: 199 } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft(
    'produkte.produkt_anlegen',
    {
      parameter: {
        name: 'Kombi Schalter',
        sku: 'KOMBI-SW',
        verkaufbar: false,
        einkaufbar: true,
        einstandspreis: 0.5,
      },
    },
    ADMIN,
  )
})
after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Kombi-Aktionen: Kopf + Positionen in einem Zug', () => {
  test('Verkauf: Lieferadresse, Einheit und Listenpreis kommen aus der Komposition', async () => {
    const ergebnis = await aktionAusfuehrenGeprueft(
      'verkauf.auftrag_mit_positionen',
      {
        parameter: {
          kunde: 'Tastatur Emporium',
          positionen: [{ produkt: 'kombi-kb', menge: 2 }],
          hinweis: 'Telefonisch aufgenommen',
        },
      },
      ADMIN,
    )
    assert.match(ergebnis.text ?? '', /Angebot S\d+ für Tastatur Emporium/)

    const [auftrag] = await h.sql<
      { id: string; state: string; ship_name: string; ship_city: string; note: string }[]
    >`select id, state, ship_name, ship_city, note from sales_orders`
    assert.equal(auftrag.state, 'draft', 'bewusst unbestätigt')
    assert.equal(auftrag.ship_name, 'Tastatur Emporium', 'Lieferadresse aus dem Kontakt')
    assert.equal(auftrag.ship_city, 'Klackhausen')
    assert.equal(auftrag.note, 'Telefonisch aufgenommen')

    const [zeile] = await h.sql<
      { qty: number; price_unit: number; uom_id: string; name: string }[]
    >`select qty, price_unit, uom_id, name from sales_order_lines where order_id = ${auftrag.id}`
    assert.equal(Number(zeile.qty), 2)
    assert.equal(Number(zeile.price_unit), 199, 'Listenpreis, kein Nullpreis')
    assert.ok(zeile.uom_id, 'die Einheit kommt vom Produkt')
    assert.match(zeile.name, /Kombi Keyboard/)
  })

  test('Einkauf: Staffelpreis und Steuersatz kommen aus der Lieferantenpreisliste', async () => {
    const [lieferant] = await h.sql<{ id: string }[]>`
      select id from partners where name = 'Schalterwerk'`
    const [schalter] = await h.sql<{ template_id: string }[]>`
      select template_id from product_variants where sku = 'KOMBI-SW'`
    await h.sql`
      insert into vendor_prices (vendor_id, template_id, min_qty, price)
      values (${lieferant.id}, ${schalter.template_id}, 0, 0.60),
             (${lieferant.id}, ${schalter.template_id}, 100, 0.40)`

    const ergebnis = await aktionAusfuehrenGeprueft(
      'einkauf.bestellung_mit_positionen',
      {
        parameter: {
          lieferant: 'Schalterwerk',
          positionen: [{ produkt: 'KOMBI-SW', menge: 200 }],
        },
      },
      ADMIN,
    )
    assert.match(ergebnis.text ?? '', /Bestellung P\d+ bei Schalterwerk/)

    const [zeile] = await h.sql<{ price_unit: number; tax_rate: number }[]>`
      select l.price_unit, l.tax_rate from purchase_order_lines l
      join purchase_orders o on o.id = l.order_id
      where o.vendor_id = ${lieferant.id}`
    assert.equal(Number(zeile.price_unit), 0.4, 'Staffelpreis ab 100 Stück greift')
    assert.equal(Number(zeile.tax_rate), 19, 'Steuersatz wird gesetzt')
  })

  test('Fast-Atomarität: unbekanntes Produkt oder falsche Rolle → gar kein Beleg', async () => {
    // Der Lieferant ist kein Kunde — der Rollenfilter des Resolvers greift.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'verkauf.auftrag_mit_positionen',
        { parameter: { kunde: 'Schalterwerk', positionen: [{ produkt: 'KOMBI-KB', menge: 1 }] } },
        ADMIN,
      ),
      /Kunde „Schalterwerk" nicht gefunden/,
    )

    const [vorher] = await h.sql<{ n: number }[]>`select count(*)::int as n from purchase_orders`
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.bestellung_mit_positionen',
        {
          parameter: {
            lieferant: 'Schalterwerk',
            positionen: [
              { produkt: 'KOMBI-SW', menge: 10 },
              { produkt: 'GIBTS-NICHT-999', menge: 1 },
            ],
          },
        },
        ADMIN,
      ),
      /nicht gefunden/,
    )
    const [nachher] = await h.sql<{ n: number }[]>`select count(*)::int as n from purchase_orders`
    assert.equal(nachher.n, vorher.n, 'die Kennungen werden VOR dem Kopf-Insert aufgelöst')
  })
})
