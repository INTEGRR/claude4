/**
 * Kommissionieren (Migration 0091) gegen die echte Datenbank und über den
 * Torwächter: Sperre gegen zwei Sammler, harte Mengenprüfung, unvollständig
 * mit Vermerk, danach der unveränderte Packtisch; Packzettel auf dem
 * A4-Drucker oder als Browser-Sammeldruck; und der abschaltbare Schritt.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_kommissionieren_check'
const ADMIN = { name: 'kommi-admin', role: 'admin' as const }
const ANNA = { name: 'kommi-anna', role: 'lager' as const }
const BERT = { name: 'kommi-bert', role: 'lager' as const }

let h: Harness
const v: Record<string, string> = {}
let lieferung = ''

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(sku: string, bestand: number): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g)
    values (${`Kommi ${sku}`}, ${stueck.id}, 300) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [variante] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${sku} where template_id = ${tpl.id} returning id`
  const [ort] = await h.sql<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`
  const [z] = await h.sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${ort.id}, ${variante.id}, ${bestand}, 0) returning id`
  await h.sql`select inventory_apply(${z.id}, 'test')`
  return variante.id
}

/** Versandbereite Lieferung: je Eintrag Variante und Menge. */
async function neueLieferung(positionen: [string, number][]): Promise<string> {
  const [kunde] = await h.sql<{ id: string }[]>`
    insert into partners (name, is_customer, street, house_number, zip, city, country_code)
    values ('Kommi Kunde', true, 'Lagerweg', '2', '10115', 'Berlin', 'DE') returning id`
  const auftrag = (
    await aktionAusfuehrenGeprueft('verkauf.auftrag_anlegen', { parameter: { partner_id: kunde.id } }, ADMIN)
  ).recordId!
  for (const [variantId, qty] of positionen) {
    await aktionAusfuehrenGeprueft(
      'verkauf.position_hinzufuegen',
      { recordId: auftrag, parameter: { variant_id: variantId, qty, price_unit: 10 } },
      ADMIN,
    )
  }
  await aktionAusfuehrenGeprueft('verkauf.bestaetigen', { recordId: auftrag }, ADMIN)
  const [p] = await h.sql<{ id: string; state: string }[]>`
    select id, state from stock_pickings where origin_model = 'sales_order' and origin_id = ${auftrag}`
  assert.equal(p.state, 'assigned')
  return p.id
}

const kopf = async (id: string) =>
  (
    await h.sql<
      {
        kommissioniert_am: string | null
        kommissioniert_von: string | null
        kommissionierung_von: string | null
        packzettel_gedruckt_am: string | null
        state: string
      }[]
    >`
      select kommissioniert_am, kommissioniert_von, kommissionierung_von, packzettel_gedruckt_am, state::text
      from stock_pickings where id = ${id}`
  )[0]

const gesammeltJeVariante = async (id: string) =>
  Object.fromEntries(
    (
      await h.sql<{ variant_id: string; menge: number }[]>`
        select variant_id, sum(qty_kommissioniert)::float as menge from stock_moves
        where picking_id = ${id} group by variant_id`
    ).map((r) => [r.variant_id, r.menge]),
  )

describe('Kommissionieren', () => {
  test('Vorbereitung: zwei Artikel, eine Lieferung mit 2 + 1 Stück', async () => {
    v.a = await artikel('KOMMI-A', 10)
    v.b = await artikel('KOMMI-B', 10)
    lieferung = await neueLieferung([
      [v.a, 2],
      [v.b, 1],
    ])
  })

  test('Sperre: Anna beginnt, Bert wird mit Namen abgewiesen, Anna darf weiter', async () => {
    const r = await aktionAusfuehrenGeprueft('lager.kommissionierung_starten', { recordId: lieferung }, ANNA)
    assert.equal(r.link, `/kommissionieren/${lieferung}`)
    assert.equal((await kopf(lieferung)).kommissionierung_von, 'kommi-anna')
    await assert.rejects(
      aktionAusfuehrenGeprueft('lager.kommissionierung_starten', { recordId: lieferung }, BERT),
      /wird gerade von kommi-anna gesammelt/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.kommissionieren',
        { recordId: lieferung, parameter: { gesammelt: { [v.a]: 2, [v.b]: 1 } } },
        BERT,
      ),
      /kommi-anna/,
      'auch Melden ist für andere gesperrt',
    )
    await aktionAusfuehrenGeprueft('lager.kommissionierung_starten', { recordId: lieferung }, ANNA)

    // Der Arbeitsvorrat zeigt, wer sammelt; für Anna ist es ihre eigene nächste.
    const { sammelVorrat, naechsteFuer } = await import('../../src/modules/versand/kommissionieren.ts')
    const vorrat = await sammelVorrat()
    const zeile = vorrat.find((z) => z.pickingId === lieferung)!
    assert.equal(zeile.sammler, 'kommi-anna')
    assert.equal(zeile.positionen, 2)
    assert.equal(zeile.stueck, 3)
    assert.equal(naechsteFuer(vorrat, 'kommi-anna')?.pickingId, lieferung)
    assert.notEqual(naechsteFuer(vorrat, 'kommi-bert')?.pickingId, lieferung)
  })

  test('Fehlmenge, fremder Artikel und zu viel werden abgewiesen', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.kommissionieren',
        { recordId: lieferung, parameter: { gesammelt: { [v.a]: 1 } } },
        ANNA,
      ),
      /Noch nicht vollständig gesammelt: KOMMI-A \(1\/2\), KOMMI-B \(0\/1\)/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.kommissionieren',
        { recordId: lieferung, parameter: { gesammelt: { [v.a]: 2, [v.b]: 1, [crypto.randomUUID()]: 1 } } },
        ANNA,
      ),
      /gehören nicht zu dieser Lieferung/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.kommissionieren',
        { recordId: lieferung, parameter: { gesammelt: { [v.a]: 3, [v.b]: 1 } } },
        ANNA,
      ),
      /Mehr gesammelt als bestellt: KOMMI-A \(3\/2\)/,
    )
    assert.deepEqual(await gesammeltJeVariante(lieferung), { [v.a]: 0, [v.b]: 0 }, 'nichts geschrieben')
  })

  test('unvollständig mit Vermerk: Fortschritt gespeichert, keine Marke, Sperre frei, Fehlbestand im Verlauf', async () => {
    const r = await aktionAusfuehrenGeprueft(
      'lager.kommissionieren',
      {
        recordId: lieferung,
        parameter: { gesammelt: { [v.a]: 1 }, unvollstaendig: true, vermerk: 'Fach leer' },
      },
      ANNA,
    )
    assert.match(r.text ?? '', /Fortschritt gespeichert/)
    assert.deepEqual(await gesammeltJeVariante(lieferung), { [v.a]: 1, [v.b]: 0 })
    const k = await kopf(lieferung)
    assert.equal(k.kommissioniert_am, null)
    assert.equal(k.kommissionierung_von, null, 'Sperre freigegeben')
    assert.equal(k.state, 'assigned', 'Belegstatus bleibt die einzige Wahrheit')
    const [log] = await h.sql<{ kind: string; message: string }[]>`
      select kind::text, message from audit_log where model = 'stock_picking' and record_id = ${lieferung}
      order by created_at desc limit 1`
    assert.equal(log.kind, 'error')
    assert.match(log.message, /fehlt: KOMMI-A \(1\/2\), KOMMI-B \(0\/1\) \(Fach leer\)/)
  })

  test('vollständig: Marke und Mengen je Bewegung; der Packtisch schließt danach wie gewohnt ab', async () => {
    // Nach der Freigabe darf Bert übernehmen.
    await aktionAusfuehrenGeprueft('lager.kommissionierung_starten', { recordId: lieferung }, BERT)
    const r = await aktionAusfuehrenGeprueft(
      'lager.kommissionieren',
      { recordId: lieferung, parameter: { gesammelt: { [v.a]: 2, [v.b]: 1 }, vermerk: 'ohne Scan: KOMMI-B' } },
      BERT,
    )
    assert.match(r.text ?? '', /kommissioniert — Ware zum Packtisch/)
    const k = await kopf(lieferung)
    assert.ok(k.kommissioniert_am)
    assert.equal(k.kommissioniert_von, 'kommi-bert')
    const moves = await h.sql<{ qty: number; qty_kommissioniert: number; qty_done: number }[]>`
      select qty::float, qty_kommissioniert::float, qty_done::float from stock_moves where picking_id = ${lieferung}`
    for (const m of moves) {
      assert.equal(m.qty_kommissioniert, m.qty)
      assert.equal(m.qty_done, 0, 'Kommissionieren bucht nichts')
    }
    const [notiz] = await h.sql<{ message: string }[]>`
      select message from audit_log where model = 'stock_picking' and record_id = ${lieferung} and kind = 'note'
      order by created_at desc limit 1`
    assert.match(notiz.message, /ohne Scan: KOMMI-B/)

    // Packtisch unverändert: Kontrolle scannen, Label, Warenausgang.
    await aktionAusfuehrenGeprueft(
      'versand.packtisch_abschliessen',
      { recordId: lieferung, parameter: { gepackt: { 'KOMMI-A': 2, 'KOMMI-B': 1 } } },
      ANNA,
    )
    assert.equal((await kopf(lieferung)).state, 'done')
  })

  test('Packzettel: ohne Drucker Link auf den Sammeldruck, mit A4-Drucker ein Brückenauftrag je Lieferung', async () => {
    const l1 = await neueLieferung([[v.a, 1]])
    const l2 = await neueLieferung([[v.b, 1]])
    const ohne = await aktionAusfuehrenGeprueft(
      'versand.packzettel_drucken',
      { parameter: { ids: [l1, l2] } },
      ANNA,
    )
    assert.equal(ohne.link, `/versand/packzettel?ids=${l1},${l2}`)
    assert.ok((await kopf(l1)).packzettel_gedruckt_am)

    await h.sql`
      insert into settings (key, value)
      values ('druckbruecke', ${h.sql.json({ modus: 'bruecke', token: 'kommi-token' })})
      on conflict (key) do update set value = excluded.value`
    const drucker = (
      await aktionAusfuehrenGeprueft(
        'einstellungen.drucker_speichern',
        { parameter: { name: 'HP Lager', typ: 'a4' } },
        ADMIN,
      )
    ).recordId!
    await aktionAusfuehrenGeprueft(
      'einstellungen.druckweg_setzen',
      { parameter: { druckart: 'packzettel', drucker_id: drucker } },
      ADMIN,
    )
    const mit = await aktionAusfuehrenGeprueft(
      'versand.packzettel_drucken',
      { parameter: { ids: [l1, l2] } },
      ANNA,
    )
    assert.equal(mit.link, undefined, 'die Brücke druckt — kein Tab')
    assert.match(mit.text ?? '', /HP Lager/)
    const auftraege = await h.sql<{ art: string; picking_id: string }[]>`
      select art, picking_id from druckauftraege where drucker_id = ${drucker} and status = 'offen'
      order by created_at`
    assert.deepEqual(
      auftraege.map((a) => [a.art, a.picking_id]),
      [
        ['packzettel', l1],
        ['packzettel', l2],
      ],
    )
    const { packzettelDaten } = await import('../../src/modules/versand/packzettel-daten.ts')
    const [zettel] = await packzettelDaten([l1])
    assert.equal(zettel.zeilen.length, 1)
    assert.equal(zettel.zeilen[0].sku, 'KOMMI-A')
  })

  test('Schritt abgeschaltet: von der Verfügbarkeit geht es direkt zum Packtisch', async () => {
    const l = await neueLieferung([[v.b, 1]])
    const naechste = async () =>
      (
        await h.sql<{ code: string }[]>`
          select code from prozess_naechste_schritte('shopify_bestellung_versand', ${l})`
      ).map((s) => s.code)
    assert.ok((await naechste()).includes('kommissionieren'))
    assert.ok((await naechste()).includes('packtisch'))

    await aktionAusfuehrenGeprueft(
      'einstellungen.prozessschritt_schalten',
      { parameter: { prozess_code: 'shopify_bestellung_versand', schritt_code: 'kommissionieren', aktiv: false } },
      ADMIN,
    )
    const [{ aktiv }] = await h.sql<{ aktiv: boolean }[]>`
      select prozessschritt_aktiv('shopify_bestellung_versand', 'kommissionieren') as aktiv`
    assert.equal(aktiv, false)
    assert.ok(!(await naechste()).includes('kommissionieren'))
    assert.ok((await naechste()).includes('packtisch'))
  })
})
