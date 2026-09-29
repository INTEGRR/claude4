/**
 * Live-Reservierung (Migration 0086): Wird an einem internen Ort Ware frei,
 * reserviert die Datenbank sofort die wartenden Bewegungen — Lieferungen und
 * Komponenten von Fertigungsaufträgen, ältester Termin zuerst. Gefunden im
 * Parallelbetrieb (2026-09-29): Lieferungen, die bei Bestand 0 bestätigt
 * wurden, blieben nach einer Inventur auf „wartet" und erschienen nie im
 * Versand. Geprüft über die echten Buchungswege (Torwächter bzw. die
 * SQL-Funktionen, die jeder andere Weg auch ruft).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_live_reservierung_check'
const ADMIN = { name: 'reservierung-test', role: 'admin' as const }

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(
  sql: Sql,
  sku: string,
  optionen: { mto?: boolean; komponente?: string } = {},
): Promise<string> {
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture, route_mto)
    values (${`Reservierung ${sku}`}, ${stueck.id}, ${Boolean(optionen.komponente)}, ${Boolean(optionen.mto)})
    returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  if (optionen.komponente) {
    const [bom] = await sql<{ id: string }[]>`
      insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
    await sql`
      insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
      values (${bom.id}, 10, ${optionen.komponente}, 1, ${stueck.id})`
  }
  return variante.id
}

/** Bestand per Inventur setzen — direkt über die SQL-Funktion, ohne App-Code. */
async function zaehlen(sql: Sql, variantId: string, menge: number): Promise<void> {
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [buch] = await sql<{ on_hand: number }[]>`
    select coalesce(on_hand, 0)::float as on_hand from stock_quants
    where location_id = ${ort.id} and variant_id = ${variantId}`
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variantId}, ${menge}, ${buch?.on_hand ?? 0}) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'test')`
}

async function auftrag(sql: Sql, variantId: string, menge: number): Promise<string> {
  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer) values ('Reservierungs-Kunde', true) returning id`
  const angelegt = await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
  const id = angelegt.recordId!
  await aktionAusfuehrenGeprueft(
    'verkauf.position_hinzufuegen',
    { recordId: id, parameter: { variant_id: variantId, qty: menge, price_unit: 10 } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: id }, ADMIN)
  return id
}

async function lieferung(auftragId: string): Promise<string> {
  const [p] = await h.sql<{ state: string }[]>`
    select state from stock_pickings where origin_model = 'sales_order' and origin_id = ${auftragId}`
  return p.state
}

describe('Live-Reservierung', () => {
  let aelter: string
  let juenger: string

  test('Inventur über die App: die ältere Lieferung wird sofort versandbereit, die jüngere teilreserviert', async () => {
    const variante = await artikel(h.sql, 'LR-KC')
    aelter = await auftrag(h.sql, variante, 2)
    juenger = await auftrag(h.sql, variante, 2)
    assert.equal(await lieferung(aelter), 'confirmed', 'ohne Bestand wartet die Lieferung')
    assert.equal(await lieferung(juenger), 'confirmed')

    const zaehlung = await aktionAusfuehrenGeprueft(
      'lager.zaehlung_erfassen', { parameter: { variant_id: variante, counted_qty: 3 } }, ADMIN)
    await aktionAusfuehrenGeprueft('lager.zaehlung_buchen', { recordId: zaehlung.recordId }, ADMIN)

    assert.equal(await lieferung(aelter), 'assigned', 'die ältere Lieferung ist versandbereit')
    assert.equal(await lieferung(juenger), 'confirmed', 'für die jüngere reicht der Rest nicht')
    const [{ frei }] = await h.sql<{ frei: number }[]>`select free_to_use(${variante})::float as frei`
    assert.equal(Number(frei), 0, '2 an die ältere, 1 als Teilreservierung an die jüngere')
  })

  test('Storno gibt Ware frei — die wartende Lieferung bekommt sie sofort', async () => {
    await h.sql`select cancel_sales_order(${aelter}, 'test')`
    assert.equal(await lieferung(juenger), 'assigned')
  })

  test('Komponenten eines Fertigungsauftrags werden reserviert, sobald Ware da ist', async () => {
    const teil = await artikel(h.sql, 'LR-TEIL')
    const baugruppe = await artikel(h.sql, 'LR-BG', { komponente: teil })
    const [{ mo }] = await h.sql<{ mo: string }[]>`
      select create_manufacturing_order(${baugruppe}, 2, null, null, 'test') as mo`
    await h.sql`select mo_confirm(${mo}, 'test')`
    const komponente = async () => {
      const [m] = await h.sql<{ state: string; reserved_qty: number }[]>`
        select state, reserved_qty::float as reserved_qty from stock_moves
        where production_id = ${mo} and variant_id = ${teil}`
      return m
    }
    assert.equal((await komponente()).state, 'confirmed', 'ohne Teile wartet die Komponente')

    await zaehlen(h.sql, teil, 5)
    const m = await komponente()
    assert.equal(m.state, 'assigned')
    assert.equal(Number(m.reserved_qty), 2)
  })

  test('Fertigmeldung auf Auftrag: der eigene Auftrag hat Vorrang vor älteren Wartenden', async () => {
    const teil = await artikel(h.sql, 'LR-TEIL2')
    await zaehlen(h.sql, teil, 10)
    const tastatur = await artikel(h.sql, 'LR-MTO', { mto: true, komponente: teil })

    // B wartet länger, A ist jünger — gefertigt wird zuerst für A.
    const b = await auftrag(h.sql, tastatur, 1)
    const a = await auftrag(h.sql, tastatur, 1)
    const [{ mo }] = await h.sql<{ mo: string }[]>`
      select id as mo from manufacturing_orders where sales_order_id = ${a}`
    await h.sql`select mo_produce(${mo})`

    assert.equal(await lieferung(a), 'assigned', 'die Fertigmeldung bedient ihren Auftrag')
    assert.equal(await lieferung(b), 'confirmed', 'B wartet weiter auf seinen eigenen Fertigungsauftrag')
  })
})
