/**
 * Inventur mit Mehrbestand erreicht wartende Lieferungen: Ein Auftrag wird
 * bei Bestand 0 bestätigt (Lieferung wartet auf Ware), danach bucht eine
 * Zählung Ware ein — die Lieferung muss sofort reserviert und versandbereit
 * sein. Vorher blieb sie auf „wartet" und tauchte nie im Versand auf
 * (gefunden im Parallelbetrieb, 2026-09-29).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_inventur_reservierung_check'
const ADMIN = { name: 'inventur-test', role: 'admin' as const }

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function lieferungZu(auftragId: string): Promise<{ id: string; state: string }> {
  const [lieferung] = await h.sql<{ id: string; state: string }[]>`
    select id, state from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftragId}`
  return lieferung
}

describe('Inventur reserviert wartende Lieferungen', () => {
  test('Auftrag bei Bestand 0, dann Zählung — die Lieferung wird versandbereit, die älteste zuerst', async () => {
    await aktionAusfuehrenGeprueft(
      'produkte.produkt_anlegen',
      { parameter: { name: 'Inventur-Keycaps', sku: 'INV-KC', verkaufbar: true } },
      ADMIN,
    )
    const [variante] = await h.sql<{ id: string }[]>`
      select id from product_variants where sku = 'INV-KC'`
    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Inventur-Kunde', true) returning id`

    // Zwei Aufträge über je 2 Stück, beide bei Bestand 0 bestätigt.
    const auftraege: string[] = []
    for (let i = 0; i < 2; i++) {
      const angelegt = await aktionAusfuehrenGeprueft(
        'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
      const id = angelegt.recordId!
      await aktionAusfuehrenGeprueft(
        'verkauf.position_hinzufuegen',
        { recordId: id, parameter: { variant_id: variante.id, qty: 2, price_unit: 10 } },
        ADMIN,
      )
      await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: id }, ADMIN)
      auftraege.push(id)
    }
    for (const id of auftraege) {
      assert.equal((await lieferungZu(id)).state, 'confirmed', 'ohne Bestand wartet die Lieferung')
    }

    // Zählung: 3 Stück — genug für die ältere Lieferung, nicht für beide.
    const zaehlung = await aktionAusfuehrenGeprueft(
      'lager.zaehlung_erfassen', { parameter: { variant_id: variante.id, counted_qty: 3 } }, ADMIN)
    const gebucht = await aktionAusfuehrenGeprueft(
      'lager.zaehlung_buchen', { recordId: zaehlung.recordId }, ADMIN)

    assert.equal((await lieferungZu(auftraege[0])).state, 'assigned', 'die ältere Lieferung ist versandbereit')
    assert.equal((await lieferungZu(auftraege[1])).state, 'confirmed', 'für die jüngere reicht der Rest nicht')
    assert.match(gebucht.text ?? '', /1 wartende Lieferung\(en\) jetzt versandbereit/)

    // Die Reservierung steht im Bestand: alle 3 Stück sind vergeben — 2 an
    // die ältere Lieferung, 1 als Teilreservierung an die jüngere.
    const [{ frei }] = await h.sql<{ frei: number }[]>`
      select free_to_use(pv.id)::float as frei from product_variants pv where pv.sku = 'INV-KC'`
    assert.equal(Number(frei), 0)
  })
})
