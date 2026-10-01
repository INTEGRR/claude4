/**
 * Fertigungs- und Artikel-Etiketten (Druckarten aus 0087, Entscheidungslog
 * 2026-10-01): über die echten Wege — Torwächter mit dem Arbeitsplatz im
 * Kontext (wie serverAktion ihn aus dem Geräte-Cookie liest), Druckweg →
 * Druckauftrag mit Art und Zieldrucker, Abholen des Agenten und das PDF im
 * Format dieses Druckers; ohne Drucker der Link aufs PDF im Browser.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { auftraegeAbholen, auftragsPdf } from '../../src/modules/druck/abholen.ts'
import { artikeletiketten, fertigungsetiketten } from '../../src/modules/druck/etiketten.ts'
import { etikettFormat, positionenAusParameter } from '../../src/modules/druck/etikett-layout.ts'

const DATENBANK = 'erp_etiketten_check'
const ADMIN = { name: 'etiketten-test', role: 'admin' as const }

let h: Harness
const platz: Record<string, string> = {}
const drucker: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
  await h.sql`
    insert into settings (key, value)
    values ('druckbruecke', ${h.sql.json({ modus: 'bruecke', token: 'etiketten-token' })})
    on conflict (key) do update set value = excluded.value`
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function platzAnlegen(code: string, name: string, art: string): Promise<string> {
  await aktionAusfuehrenGeprueft('fertigung.arbeitsplatz_anlegen', { parameter: { code, name, art } }, ADMIN)
  const [w] = await h.sql<{ id: string }[]>`select id from work_centers where code = ${code}`
  return w.id
}

async function druckerAnlegen(p: Record<string, unknown>): Promise<string> {
  const r = await aktionAusfuehrenGeprueft('einstellungen.drucker_speichern', { parameter: p }, ADMIN)
  return r.recordId!
}

async function weg(platzId: string | null, druckart: string, druckerId: string) {
  await aktionAusfuehrenGeprueft(
    'einstellungen.druckweg_setzen',
    { parameter: { work_center_id: platzId ?? undefined, druckart, drucker_id: druckerId } },
    ADMIN,
  )
}

async function variante(name: string, codes: { sku?: string; barcode?: string }): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, route_manufacture)
    values (${name}, ${stueck.id}, true) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`
    update product_variants set sku = ${codes.sku ?? null}, barcode = ${codes.barcode ?? null}
    where template_id = ${tpl.id} returning id`
  return v.id
}

/** Ein bestätigter Fertigungsauftrag mit zwei Komponenten. */
async function fertigungsauftrag(sku: string): Promise<{ id: string; number: string }> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const v = await variante(`Etikett ${sku}`, { sku })
  const [tpl] = await h.sql<{ template_id: string }[]>`select template_id from product_variants where id = ${v}`
  const [bom] = await h.sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${tpl.template_id}, 1, ${stueck.id}) returning id`
  for (const [i, teil] of ['A', 'B'].entries()) {
    const t = await variante(`Teil ${sku}-${teil}`, { sku: `${sku}-${teil}` })
    await h.sql`
      insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
      values (${bom.id}, ${10 + i}, ${t}, 1, ${stueck.id})`
  }
  const angelegt = await aktionAusfuehrenGeprueft(
    'fertigung.auftrag_anlegen', { parameter: { variant_id: v, qty: 4 } }, ADMIN)
  await aktionAusfuehrenGeprueft('fertigung.bestaetigen', { recordId: angelegt.recordId }, ADMIN)
  const [mo] = await h.sql<{ number: string }[]>`
    select number from manufacturing_orders where id = ${angelegt.recordId!}`
  return { id: angelegt.recordId!, number: mo.number }
}

async function offen(druckerId: string) {
  return h.sql<{ art: string; mo_id: string | null; variant_id: string | null; anzahl: number; arbeitsplatz_id: string | null }[]>`
    select art, mo_id, variant_id, anzahl, arbeitsplatz_id from druckauftraege
    where drucker_id = ${druckerId} and status = 'offen' order by created_at`
}

const mm = (pt: number) => Math.round((pt / 72) * 25.4)

async function seiten(pdf: Buffer): Promise<{ anzahl: number; mm: [number, number] }> {
  const doc = await PDFDocument.load(pdf)
  const { width, height } = doc.getPage(0).getSize()
  return { anzahl: doc.getPageCount(), mm: [mm(width), mm(height)] }
}

describe('Etiketten über die Druckbrücke', () => {
  test('Einrichtung: Label-Ident in der Fertigung, Brother QL am Packtisch', async () => {
    platz.mont = await platzAnlegen('MONT1', 'Montagetisch 1', 'fertigung')
    platz.pack = await platzAnlegen('PACK1', 'Packtisch 1', 'versand')
    drucker.ident = await druckerAnlegen({
      name: 'Label-Ident Fertigung', work_center_id: platz.mont, typ: 'label', breite_mm: 100, hoehe_mm: 50,
    })
    drucker.ql = await druckerAnlegen({
      name: 'QL Packtisch 1', work_center_id: platz.pack, typ: 'label', breite_mm: 62, hoehe_mm: 29,
    })
    await weg(platz.mont, 'fertigungsetikett', drucker.ident)
    await weg(platz.pack, 'artikeletikett', drucker.ql)
  })

  test('Fertigungsetikett: Auftrag an den Etikettendrucker des Platzes, Doppelklick druckt nicht doppelt', async () => {
    const mo = await fertigungsauftrag('ET-MO1')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] }, arbeitsplatzId: platz.mont }, ADMIN)
    assert.equal(r.link, undefined, 'gedruckt — kein Browser-Tab')
    assert.match(r.text ?? '', /^1 Fertigungsetikett: Gedruckt auf Label-Ident Fertigung \(Montagetisch 1\)\./)

    const auftraege = await offen(drucker.ident)
    assert.deepEqual(
      auftraege.map((a) => [a.art, a.mo_id, a.anzahl, a.arbeitsplatz_id]),
      [['fertigungsetikett', mo.id, 1, platz.mont]],
    )

    const nochmal = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] }, arbeitsplatzId: platz.mont }, ADMIN)
    assert.match(nochmal.text ?? '', /schon in der Warteschlange/)
    assert.equal((await offen(drucker.ident)).length, 1)

    // Der Agent holt ab und bekommt das Etikett im Format SEINES Druckers.
    const [job] = await auftraegeAbholen({ druckerId: drucker.ident })
    assert.equal(job.art, 'fertigungsetikett')
    const { pdf, dateiname } = await auftragsPdf(job)
    assert.equal(dateiname, `etikett-${mo.number.replaceAll('/', '-')}.pdf`)
    assert.deepEqual(await seiten(pdf), { anzahl: 1, mm: [100, 50] })
  })

  test('Artikel-Etiketten per SKU (wie die KI spricht): EIN Auftrag je Variante mit Anzahl, Kopien als Seiten', async () => {
    const v = await variante('Anvil Native 1800', { sku: 'ET-AN-1800', barcode: '4006381333931' })
    const r = await aktionAusfuehrenGeprueft(
      'lager.artikeletikett_drucken',
      {
        parameter: { positionen: [{ variant_id: 'ET-AN-1800', anzahl: 2 }, { variant_id: v, anzahl: 1 }] },
        arbeitsplatzId: platz.pack,
      },
      { name: 'lager-test', role: 'lager' },
    )
    assert.equal(r.link, undefined)
    assert.match(r.text ?? '', /^3 Artikel-Etiketten: Gedruckt auf QL Packtisch 1 \(Packtisch 1\)\./)
    assert.deepEqual(
      (await offen(drucker.ql)).map((a) => [a.art, a.variant_id, a.anzahl]),
      [['artikeletikett', v, 3]],
      'gleiche Variante zusammengefasst',
    )

    const [job] = await auftraegeAbholen({ druckerId: drucker.ql })
    const { pdf, dateiname } = await auftragsPdf(job)
    assert.equal(dateiname, 'artikeletikett-ET-AN-1800-3x.pdf')
    assert.deepEqual(await seiten(pdf), { anzahl: 3, mm: [62, 29] }, 'drei Kopien im Format 62 × 29')
  })

  test('Ohne Drucker: kein Auftrag, der Link öffnet das PDF im Browser (Standardformat)', async () => {
    const v = await variante('Keycap-Set', { sku: 'ET-KC-001' })
    // Montagetisch hat keinen Weg für Artikel-Etiketten, und es gibt keinen Ersatz.
    const r = await aktionAusfuehrenGeprueft(
      'lager.artikeletikett_drucken',
      { parameter: { positionen: [{ variant_id: v, anzahl: 5 }] }, arbeitsplatzId: platz.mont },
      ADMIN,
    )
    assert.equal(r.link, `/api/etikett/artikel?pos=${v}:5`)
    assert.match(r.text ?? '', /kein Etikettendrucker für Artikel-Etiketten, PDF im Browser/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from druckauftraege where variant_id = ${v}`
    assert.equal(n, 0)
    // Dasselbe PDF, das die Route /api/etikett/artikel ausliefert.
    const pos = positionenAusParameter(new URL(r.link!, 'http://krnl').searchParams.get('pos'))
    assert.deepEqual(await seiten(await artikeletiketten(pos, etikettFormat(null, null))), { anzahl: 5, mm: [100, 50] })

    const mo = await fertigungsauftrag('ET-MO2')
    const f = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] }, arbeitsplatzId: platz.pack }, ADMIN)
    assert.equal(f.link, `/api/etikett/fertigung?ids=${mo.id}`)
    const [{ m }] = await h.sql<{ m: number }[]>`select count(*)::int as m from druckauftraege where mo_id = ${mo.id}`
    assert.equal(m, 0)
    assert.deepEqual(await seiten(await fertigungsetiketten([mo.id], etikettFormat(null, null))), { anzahl: 1, mm: [100, 50] })
  })

  test('Ersatzdrucker springt ein und sagt es; unbekannte Aufträge werden abgewiesen', async () => {
    await weg(null, 'fertigungsetikett', drucker.ident)
    const mo = await fertigungsauftrag('ET-MO3')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] }, arbeitsplatzId: platz.pack }, ADMIN)
    assert.match(r.text ?? '', /Ersatzdrucker, Packtisch 1 hat keinen Drucker für Fertigungsetikett/)
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'fertigung.etikett_drucken',
        { parameter: { ids: ['00000000-0000-4000-8000-000000000000'] } },
        ADMIN,
      ),
      /Keiner der Fertigungsaufträge/,
    )
  })

  test('Ohne Barcode und SKU kein Etikett; Rechte: Lager klebt Artikel-, Fertigung Fertigungsetiketten', async () => {
    const ohne = await variante('Namenlos', {})
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.artikeletikett_drucken', { parameter: { positionen: [{ variant_id: ohne, anzahl: 1 }] } }, ADMIN),
      /weder Barcode noch SKU/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.artikeletikett_drucken',
        { parameter: { positionen: [{ variant_id: 'ET-KC-001', anzahl: 1 }] } },
        { name: 'fertigung-test', role: 'fertigung' },
      ),
      /Berechtigung/,
    )
    const mo = await fertigungsauftrag('ET-MO4')
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'fertigung.etikett_drucken', { parameter: { ids: [mo.id] } }, { name: 'lager-test', role: 'lager' }),
      /Berechtigung/,
    )
    const ok = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] } }, { name: 'fertigung-test', role: 'fertigung' })
    assert.match(ok.text ?? '', /Gedruckt auf Label-Ident Fertigung/)
  })

  test('Brücke im Modus „PDF im Browser": trotz Druckweg kein Auftrag, sondern der Link', async () => {
    await h.sql`
      update settings set value = value || ${h.sql.json({ modus: 'pdf' })} where key = 'druckbruecke'`
    const mo = await fertigungsauftrag('ET-MO5')
    const r = await aktionAusfuehrenGeprueft(
      'fertigung.etikett_drucken', { parameter: { ids: [mo.id] }, arbeitsplatzId: platz.mont }, ADMIN)
    assert.match(r.link ?? '', /^\/api\/etikett\/fertigung\?ids=/)
  })
})
