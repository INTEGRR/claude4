/**
 * Arbeitsplätze mit Druckern (Migration 0087): jeder Druck kommt am Platz
 * des PCs heraus. Geprüft über die echten Wege — Torwächter mit dem
 * Arbeitsplatz im Kontext (wie serverAktion ihn aus dem Geräte-Cookie
 * liest), Einstellungs-Aktionen für Plätze, Drucker und Wege, und das
 * Abholen der Agenten mit Sperre.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import {
  auftraegeAbholen,
  druckerMeldetSich,
  stilleDrucker,
} from '../../src/modules/druck/abholen.ts'

const DATENBANK = 'erp_druckwege_check'
const ADMIN = { name: 'druckwege-test', role: 'admin' as const }

let h: Harness
const platz: Record<string, string> = {}
const drucker: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
  // Brücke an (Betreiber-Einstellung, nicht Env).
  await h.sql`
    insert into settings (key, value)
    values ('druckbruecke', ${h.sql.json({ modus: 'bruecke', token: 'druckwege-token' })})
    on conflict (key) do update set value = excluded.value`
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function platzAnlegen(code: string, name: string, art: string): Promise<string> {
  await aktionAusfuehrenGeprueft(
    'fertigung.arbeitsplatz_anlegen',
    { parameter: { code, name, art } },
    ADMIN,
  )
  const [w] = await h.sql<{ id: string }[]>`select id from work_centers where code = ${code}`
  return w.id
}

async function druckerAnlegen(p: Record<string, unknown>): Promise<string> {
  const r = await aktionAusfuehrenGeprueft('einstellungen.drucker_speichern', { parameter: p }, ADMIN)
  return r.recordId!
}

async function weg(platzId: string | null, druckart: string, druckerId: string | null) {
  await aktionAusfuehrenGeprueft(
    'einstellungen.druckweg_setzen',
    {
      parameter: {
        work_center_id: platzId ?? undefined,
        druckart,
        drucker_id: druckerId ?? undefined,
      },
    },
    ADMIN,
  )
}

/** Eine versandbereite Lieferung mit vollständiger Adresse. */
async function lieferung(sku: string): Promise<string> {
  const sql = h.sql
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${`Druckweg ${sku}`}, ${stueck.id}, 800) returning id`
  await sql`select generate_variants(${tpl.id})`
  const [variante] = await sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  const [ort] = await sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [zaehlung] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variante.id}, 5, 0) returning id`
  await sql`select inventory_apply(${zaehlung.id}, 'test')`

  const [kunde] = await sql<{ id: string }[]>`
    insert into partners (name, is_customer, street, house_number, zip, city, country_code)
    values (${`Kunde ${sku}`}, true, 'Hauptstraße', '1', '10115', 'Berlin', 'DE')
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
    select id, state from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftrag}`
  assert.equal(p.state, 'assigned', 'die Lieferung muss versandbereit sein')
  return p.id
}

async function fertigungsauftrag(sku: string): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture)
    values (${`Druckweg ${sku}`}, ${stueck.id}, true) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  // Ohne Stückliste kein Fertigungsauftrag — eine Komponente genügt.
  const [teilTpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id) values (${`Teil ${sku}`}, ${stueck.id}) returning id`
  await h.sql`select generate_variants(${teilTpl.id})`
  const [teil] = await h.sql<{ id: string }[]>`
    select id from product_variants where template_id = ${teilTpl.id}`
  const [bom] = await h.sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.id}, 1, ${stueck.id}) returning id`
  await h.sql`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, 10, ${teil.id}, 1, ${stueck.id})`
  const [{ mo }] = await h.sql<{ mo: string }[]>`
    select create_manufacturing_order(${v.id}, 1, null, null, 'test') as mo`
  return mo
}

async function offeneAuftraege(druckerId: string) {
  return h.sql<{ art: string; shipment_id: string | null; mo_id: string | null; arbeitsplatz_id: string | null }[]>`
    select art, shipment_id, mo_id, arbeitsplatz_id from druckauftraege
    where drucker_id = ${druckerId} and status = 'offen' order by created_at`
}

describe('Druckwege', () => {
  test('Einrichtung: Plätze mit Art, Drucker mit Format, Wege je Platz und Ersatz', async () => {
    platz.pack1 = await platzAnlegen('PACK1', 'Packtisch 1', 'versand')
    platz.pack2 = await platzAnlegen('PACK2', 'Packtisch 2', 'versand')
    platz.mont = await platzAnlegen('MONT1', 'Montagetisch 1', 'fertigung')
    const arten = await h.sql<{ code: string; art: string }[]>`
      select code, art from work_centers where code in ('PACK1', 'MONT1') order by code`
    assert.deepEqual(arten.map((a) => a.art), ['fertigung', 'versand'])

    await assert.rejects(
      druckerAnlegen({ name: 'ohne Maße', typ: 'label' }),
      /Breite und Höhe/,
      'Etikettendrucker ohne Maße werden abgewiesen',
    )
    drucker.ql1 = await druckerAnlegen({
      name: 'QL Packtisch 1', work_center_id: platz.pack1, druckername: 'Brother QL-1100',
      typ: 'label', breite_mm: 103, hoehe_mm: 150, dhl_format: '910-300-400',
    })
    drucker.ql2 = await druckerAnlegen({
      name: 'QL Packtisch 2', work_center_id: platz.pack2,
      typ: 'label', breite_mm: 103, hoehe_mm: 199, dhl_format: '910-300-600',
    })
    drucker.hp = await druckerAnlegen({ name: 'HP Werkstatt', work_center_id: platz.mont, typ: 'a4' })
    await assert.rejects(
      druckerAnlegen({ name: 'hp werkstatt', typ: 'a4' }),
      /schon einen Drucker/,
    )

    await weg(platz.pack1, 'versandlabel', drucker.ql1)
    await weg(platz.pack2, 'versandlabel', drucker.ql2)
    await weg(null, 'fertigungszettel', drucker.hp)
    // Setzen ist Überschreiben, nicht Anhängen.
    await weg(platz.pack2, 'versandlabel', drucker.ql2)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from arbeitsplatz_druckwege`
    assert.equal(n, 3)
  })

  test('Zwei Packtische: jedes Label landet am Drucker seines Tisches, im Format dieses Druckers', async () => {
    const l1 = await lieferung('DW-1')
    const l2 = await lieferung('DW-2')
    const r1 = await aktionAusfuehrenGeprueft(
      'versand.packtisch_abschliessen',
      { recordId: l1, parameter: { gepackt: { 'DW-1': 1 } }, arbeitsplatzId: platz.pack1 },
      ADMIN,
    )
    const r2 = await aktionAusfuehrenGeprueft(
      'versand.packtisch_abschliessen',
      { recordId: l2, parameter: { gepackt: { 'DW-2': 1 } }, arbeitsplatzId: platz.pack2 },
      ADMIN,
    )
    // Über die Brücke gedruckt: kein Link, sonst öffnete der Packtisch
    // zusätzlich einen Tab (Doppeldruck).
    assert.equal(r1.link, undefined)
    assert.match(r1.text ?? '', /Gedruckt auf QL Packtisch 1 \(Packtisch 1\)\./)
    assert.match(r2.text ?? '', /Gedruckt auf QL Packtisch 2 \(Packtisch 2\)\./)

    const [s1] = await h.sql<{ id: string; label_format: string }[]>`
      select id, label_format from shipments where picking_id = ${l1}`
    const [s2] = await h.sql<{ id: string; label_format: string }[]>`
      select id, label_format from shipments where picking_id = ${l2}`
    assert.equal(s1.label_format, '910-300-400', 'DHL-Format des Druckers an Packtisch 1')
    assert.equal(s2.label_format, '910-300-600', 'DHL-Format des Druckers an Packtisch 2')

    const a1 = await offeneAuftraege(drucker.ql1)
    const a2 = await offeneAuftraege(drucker.ql2)
    assert.deepEqual(a1.map((a) => a.shipment_id), [s1.id])
    assert.deepEqual(a2.map((a) => a.shipment_id), [s2.id])
    assert.equal(a1[0].arbeitsplatz_id, platz.pack1, 'der Auftrag hält fest, woher er kam')
  })

  test('Kein eigener Weg und kein Ersatz: das Label öffnet im Browser, im Standardformat', async () => {
    const l = await lieferung('DW-3')
    const r = await aktionAusfuehrenGeprueft(
      'versand.label_erstellen', { recordId: l, arbeitsplatzId: platz.mont }, ADMIN)
    assert.match(r.link ?? '', /^\/api\/label\//)
    const [s] = await h.sql<{ label_format: string }[]>`
      select label_format from shipments where picking_id = ${l}`
    assert.equal(s.label_format, '910-300-700')
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from druckauftraege d join shipments s on s.id = d.shipment_id
      where s.picking_id = ${l}`
    assert.equal(n, 0, 'nichts an der Brücke — und nichts an einem Alt-Ziel')
  })

  test('Fertigungszettel ohne eigenen Weg: der Ersatzdrucker springt ein und sagt es', async () => {
    const mo = await fertigungsauftrag('DW-MO')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.zettel_drucken', { parameter: { ids: [mo] }, arbeitsplatzId: platz.pack1 }, ADMIN)
    assert.equal(r.link, undefined)
    assert.match(
      r.text ?? '',
      /HP Werkstatt \(Montagetisch 1\) — Ersatzdrucker, Packtisch 1 hat keinen Drucker für Fertigungszettel/,
    )
    // Doppelklick druckt nicht doppelt; ohne Arbeitsplatz ebenfalls Ersatz.
    const ohne = await aktionAusfuehrenGeprueft(
      'fertigung.zettel_drucken', { parameter: { ids: [mo] } }, ADMIN)
    assert.match(ohne.text ?? '', /dieser PC hat keinen Arbeitsplatz/)
    const offen = await offeneAuftraege(drucker.hp)
    assert.equal(offen.filter((a) => a.mo_id === mo).length, 1)
  })

  test('Eine Arbeitsplatz-ID, die keine UUID ist, zählt wie kein Arbeitsplatz', async () => {
    const mo = await fertigungsauftrag('DW-MO2')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.zettel_drucken',
      { parameter: { ids: [mo] }, arbeitsplatzId: "x' or 1=1 --" },
      ADMIN,
    )
    assert.match(r.text ?? '', /dieser PC hat keinen Arbeitsplatz/)
  })

  test('Abholen mit Sperre: zwei Agenten zugleich — jeder Auftrag geht genau einmal raus', async () => {
    const vorher = (await offeneAuftraege(drucker.hp)).length
    assert.ok(vorher >= 2)
    const [a, b] = await Promise.all([
      auftraegeAbholen({ druckerId: drucker.hp }),
      auftraegeAbholen({ druckerId: drucker.hp }),
    ])
    const ids = [...a, ...b].map((j) => j.id)
    assert.equal(new Set(ids).size, ids.length, 'kein Auftrag doppelt')
    assert.equal(ids.length, vorher)
    assert.ok([...a, ...b].every((j) => j.drucker_typ === 'a4'))

    // Solange die Sperre läuft, kommt nichts nach …
    assert.equal((await auftraegeAbholen({ druckerId: drucker.hp })).length, 0)
    // … bleibt die Quittung aus, wird der Auftrag erneut angeboten.
    await h.sql`update druckauftraege set abgeholt_am = now() - interval '3 minutes'
      where drucker_id = ${drucker.hp}`
    assert.equal((await auftraegeAbholen({ druckerId: drucker.hp })).length, vorher)
  })

  test('Alt-Agent ohne Drucker-ID zieht nur Aufträge ohne Drucker', async () => {
    const alt = await auftraegeAbholen({ ziele: null })
    assert.equal(alt.length, 0, 'die Aufträge der Drucker bleiben bei ihren Agenten')
    const [s] = await h.sql<{ id: string }[]>`select id from shipments limit 1`
    await h.sql`insert into druckauftraege (art, shipment_id, ziel) values ('label', ${s.id}, 'labeldrucker')`
    assert.equal((await auftraegeAbholen({ ziele: ['zetteldrucker'] })).length, 0)
    const gezogen = await auftraegeAbholen({ ziele: ['labeldrucker'] })
    assert.equal(gezogen.length, 1)
    assert.equal((await auftraegeAbholen({ druckerId: drucker.ql1 })).length, 1, 'nur das eigene Label')
  })

  test('Dienste-Wächter: jeder aktive Drucker braucht seinen Agenten', async () => {
    const nie = await stilleDrucker(15)
    assert.deepEqual(
      nie.map((d) => d.name),
      ['HP Werkstatt', 'QL Packtisch 1', 'QL Packtisch 2'],
      'noch kein Agent hat sich gemeldet',
    )
    for (const id of Object.values(drucker)) assert.ok(await druckerMeldetSich(id))
    assert.equal((await stilleDrucker(15)).length, 0)
    await h.sql`update drucker set zuletzt_gesehen = now() - interval '20 minutes'
      where id = ${drucker.ql2}`
    assert.deepEqual((await stilleDrucker(15)).map((d) => d.name), ['QL Packtisch 2'])
    assert.equal(await druckerMeldetSich('00000000-0000-4000-8000-000000000000'), null)
  })

  test('Drucker aus: seine Wege fallen zurück; löschen storniert seine offenen Aufträge', async () => {
    await aktionAusfuehrenGeprueft('einstellungen.drucker_schalten', { recordId: drucker.hp }, ADMIN)
    const mo = await fertigungsauftrag('DW-MO3')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.zettel_drucken', { parameter: { ids: [mo] }, arbeitsplatzId: platz.mont }, ADMIN)
    assert.match(r.link ?? '', /^\/fertigung\/druck\?ids=/, 'ohne aktiven Drucker: Browser')

    const offen = (await offeneAuftraege(drucker.hp)).length
    assert.ok(offen > 0)
    const geloescht = await aktionAusfuehrenGeprueft(
      'einstellungen.drucker_loeschen', { recordId: drucker.hp }, ADMIN)
    assert.match(geloescht.text ?? '', /storniert/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from druckauftraege where status = 'offen' and drucker_id is null
        and art = 'zettel'`
    assert.equal(n, 0, 'kein verwaister Auftrag rutscht an einen Alt-Agenten')
    const [{ wege }] = await h.sql<{ wege: number }[]>`
      select count(*)::int as wege from arbeitsplatz_druckwege where druckart = 'fertigungszettel'`
    assert.equal(wege, 0)
  })
})
