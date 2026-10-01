/**
 * „Adresse prüfen" (Entscheidungslog 2026-10-01) durch den Torwächter gegen
 * die echte Datenbank und den DHL-Fake: DHL prüft die Sendung einer
 * Lieferung mit validate=true — derselbe Request wie beim Label, aber kein
 * Label, keine Buchung, nur ein Protokolleintrag. Beanstandungen kommen in
 * Klartext; lehnt DHL das Label selbst wegen der Adresse ab, ist auch diese
 * Meldung lesbar.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_adresse_check'
const ADMIN = { name: 'adress-test', role: 'admin' as const }
let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

/** Eine versandbereite Lieferung an die gegebene Adresse. */
async function lieferung(sku: string, adresse: { house: string; zip: string }): Promise<string> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${`Adresstest ${sku}`}, ${stueck.id}, 400) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variante.id}, 2, 0) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'test')`

  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, street, house_number, zip, city, country_code)
    values (${`Kunde ${sku}`}, true, 'Hauptstraße', ${adresse.house || null}, ${adresse.zip}, 'Berlin', 'DE')
    returning id`
  const angelegt = await aktionAusfuehrenGeprueft(
    'verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
  const auftrag = angelegt.recordId!
  await aktionAusfuehrenGeprueft(
    'verkauf.position_hinzufuegen',
    { recordId: auftrag, parameter: { variant_id: variante.id, qty: 1, price_unit: 10 } },
    ADMIN,
  )
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: auftrag }, ADMIN)
  const [p] = await sql<{ id: string; state: string }[]>`
    select id, state from stock_pickings where origin_model = 'sales_order' and origin_id = ${auftrag}`
  assert.equal(p.state, 'assigned', 'die Lieferung muss versandbereit sein')
  return p.id
}

const zustand = async (picking: string) =>
  (await h.sql<{ state: string }[]>`select state from stock_pickings where id = ${picking}`)[0].state
const sendungen = async (picking: string) =>
  (await h.sql<{ n: number }[]>`select count(*)::int as n from shipments where picking_id = ${picking}`)[0].n
const protokoll = async (picking: string) =>
  h.sql<{ kind: string; message: string }[]>`
    select kind, message from audit_log
    where model = 'stock_picking' and record_id = ${picking} order by id`

describe('Adresse prüfen', () => {
  test('gültige Adresse: „Adresse ok", nichts gebucht, nur ein Protokolleintrag', async () => {
    const p = await lieferung('AP-OK', { house: '1', zip: '10115' })
    const vorher = (await protokoll(p)).length
    const r = await aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: p }, ADMIN)
    assert.match(r.text ?? '', /^Adresse ok — DHL hat nichts zu beanstanden \(Kunde AP-OK, Hauptstraße 1, 10115 Berlin, DE\)\.$/)
    assert.deepEqual(r.daten, { ok: true, fehler: [], hinweise: [] })

    assert.equal(await zustand(p), 'assigned', 'keine Buchung')
    assert.equal(await sendungen(p), 0, 'kein Label, keine Sendung')
    const eintraege = (await protokoll(p)).slice(vorher)
    assert.deepEqual(eintraege.map((e) => e.kind), ['note'])
    assert.match(eintraege[0].message, /^Adresse bei DHL geprüft: Adresse ok/)
  })

  test('derselbe Request wie beim Label — nur ohne Label', async () => {
    const p = await lieferung('AP-GLEICH', { house: '7', zip: '20457' })
    await aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: p }, ADMIN)
    await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: p }, ADMIN)
    const [pruefung] = await h.sql<{ request: unknown; reference: string }[]>`
      select request, reference from api_transactions where kind = 'fake:address_validate'
      order by created_at desc limit 1`
    const [label] = await h.sql<{ request: unknown; reference: string }[]>`
      select request, reference from api_transactions where kind = 'fake:label_create'
      order by created_at desc limit 1`
    assert.equal(pruefung.reference, label.reference)
    assert.deepEqual(pruefung.request, label.request, 'Adresse, Produkt, Gewicht, Abrechnungsnummer, Format — alles gleich')
  })

  test('Hausnummer fehlt: Beanstandung in Klartext — das Label ginge trotzdem, mit Hinweis', async () => {
    const p = await lieferung('AP-HNR', { house: '', zip: '10115' })
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: p }, ADMIN),
      /^Error: DHL hat Hinweise zur Adresse: Hausnummer fehlt — so ist die Adresse nicht leitcodierbar — das Label ginge durch/,
    )
    const [eintrag] = (await protokoll(p)).slice(-1)
    assert.equal(eintrag.kind, 'error')
    assert.match(eintrag.message, /^Adresse bei DHL geprüft: DHL hat Hinweise zur Adresse: Hausnummer fehlt/)
    assert.equal(await sendungen(p), 0)

    // Das Label entsteht (DHL bucht trotz Hinweis) — der Hinweis steht lesbar an der Sendung.
    await aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: p }, ADMIN)
    const [sendung] = await h.sql<{ dhl_warnings: string[] }[]>`
      select dhl_warnings from shipments where picking_id = ${p}`
    assert.deepEqual(sendung.dhl_warnings, ['Hausnummer fehlt — so ist die Adresse nicht leitcodierbar'])
  })

  test('PLZ ungültig: Prüfung beanstandet, und auch die Label-Ablehnung ist lesbar', async () => {
    const p = await lieferung('AP-PLZ', { house: '3', zip: '1011' })
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: p }, ADMIN),
      /DHL beanstandet die Adresse: PLZ „1011" ist ungültig — in Deutschland hat die PLZ fünf Ziffern — so lehnt DHL das Label ab/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.label_erstellen', { recordId: p }, ADMIN),
      /^Error: DHL lehnt die Sendung ab: PLZ „1011" ist ungültig — in Deutschland hat die PLZ fünf Ziffern$/,
    )
    assert.equal(await zustand(p), 'assigned', 'abgelehnt heißt: nichts gebucht')
    assert.equal(await sendungen(p), 0)
    const [eintrag] = (await protokoll(p)).slice(-1)
    assert.match(eintrag.message, /^DHL-Label fehlgeschlagen: DHL lehnt die Sendung ab: PLZ „1011" ist ungültig/)
  })

  test('unvollständige Adresse: benennt, was fehlt — ohne DHL zu fragen', async () => {
    const p = await lieferung('AP-LEER', { house: '1', zip: '10115' })
    // Ort fehlt am Auftrag (eingefrorene Lieferadresse) und am Kontakt.
    await h.sql`update partners set city = null
                where id = (select partner_id from stock_pickings where id = ${p})`
    await h.sql`update sales_orders set ship_city = null
                where id = (select origin_id from stock_pickings where id = ${p})`
    const vorher = (await h.sql<{ n: number }[]>`
      select count(*)::int as n from api_transactions where kind = 'fake:address_validate'`)[0].n
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: p }, ADMIN),
      /Die Lieferadresse ist unvollständig — es fehlt: Ort/,
    )
    const nachher = (await h.sql<{ n: number }[]>`
      select count(*)::int as n from api_transactions where kind = 'fake:address_validate'`)[0].n
    assert.equal(nachher, vorher, 'kein DHL-Aufruf')
    const [eintrag] = (await protokoll(p)).slice(-1)
    assert.match(eintrag.message, /^Adresse prüfen: Die Lieferadresse ist unvollständig/)
  })

  test('nur für Lieferungen: eine fremde ID weist der Torwächter ab', async () => {
    const [kunde] = await h.sql<{ id: string }[]>`select id from partners limit 1`
    await assert.rejects(
      aktionAusfuehrenGeprueft('versand.adresse_pruefen', { recordId: kunde.id }, ADMIN),
      /arbeitet auf stock_picking/,
    )
  })
})
