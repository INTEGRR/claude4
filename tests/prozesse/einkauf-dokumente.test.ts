/**
 * Einkauf, Stufe 1 (Migration 0092) gegen die echte Datenbank und die
 * Drive-Attrappe (GOOGLE_FAKE=1): Ablage einrichten ohne Doppel, Upload in
 * Stücken mit Prüfung der fertigen Datei, Verknüpfen/Lösen, Lieferantenakte
 * mit eindeutigen Maildomains, Dienstleistungs-Bestellung ohne Wareneingang
 * und Preise mit 6 Nachkommastellen.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_einkauf_dokumente_check'
const TINO = { name: 'tino', role: 'mitarbeiter' as const }
const ANDERE = { name: 'patrick', role: 'mitarbeiter' as const }
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }

let h: Harness
const ids: Record<string, string> = {}

before(async () => {
  process.env.GOOGLE_FAKE = '1'
  h = await harnessStart(DATENBANK)
  const { fakeDriveLeeren } = await import('../../src/modules/google/google-fake.ts')
  fakeDriveLeeren()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

async function artikel(name: string, typ: 'goods' | 'service'): Promise<string> {
  const [stueck] = await h.sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, type) values (${name}, ${stueck.id}, ${typ}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  const [v] = await h.sql<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id}`
  ids[`tpl:${name}`] = tpl.id
  return v.id
}

async function bestellung(positionen: [string, number, number?][]): Promise<string> {
  const po = (
    await aktionAusfuehrenGeprueft('einkauf.bestellung_anlegen', { parameter: { vendor_id: ids.lieferant } }, TINO)
  ).recordId!
  for (const [variant_id, qty, price_unit] of positionen) {
    await aktionAusfuehrenGeprueft(
      'einkauf.position_hinzufuegen',
      { recordId: po, parameter: { variant_id, qty, price_unit } },
      TINO,
    )
  }
  return po
}

/** Wie der Browser über /api/dokumente/stueck: Stücke an die Sitzung. */
async function stueckeSenden(sitzungId: string, inhalt: Buffer, stueck = 256 * 1024): Promise<string> {
  const [s] = await h.sql<{ session_uri: string; groesse: number }[]>`
    select session_uri, groesse::float as groesse from upload_sitzungen where id = ${sitzungId}`
  const { drive } = await import('../../src/modules/google/drive.ts')
  const api = await drive()
  let start = 0
  for (;;) {
    const r = await api.uploadStueck(s.session_uri, inhalt.subarray(start, start + stueck), start, s.groesse)
    if (r.fertig) return r.datei!.id
    start = r.weiterAb!
  }
}

describe('Einkauf Stufe 1: Ablage, Dokumente, Lieferantenakte', () => {
  test('Vorbereitung: Lieferant, Lagerteil, Dienstleistung', async () => {
    const [p] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company, country_code) values ('Shenzhen Keycap Co.', true, true, 'CN')
      returning id`
    ids.lieferant = p.id
    const [p2] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_vendor, is_company) values ('Zweiter Lieferant', true, true) returning id`
    ids.lieferant2 = p2.id
    ids.teil = await artikel('Keycap-Set Frosted', 'goods')
    ids.dienst = await artikel('Regal-Montage', 'service')
    const [bp] = await h.sql<{ bill_policy: string }[]>`
      select bill_policy::text from product_templates where id = ${ids['tpl:Regal-Montage']}`
    assert.equal(bp.bill_policy, 'ordered', 'Dienstleistungen rechnen nach Bestellmenge ab')
  })

  test('Ablage einrichten: vier Hauptordner, zweiter Lauf ohne Doppel; nur Admin', async () => {
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, TINO), /Administratoren/)
    await aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, ADMIN)
    await h.sql`delete from drive_ordner` // wie nach „Betriebsdaten löschen"
    const r = await aktionAusfuehrenGeprueft('einkauf.ablage_einrichten', {}, ADMIN)
    assert.match(r.text ?? '', /Lieferanten, Projekte, Artikel, Eingang/)
    const { fakeDrive } = await import('../../src/modules/google/google-fake.ts')
    const { FAKE_WURZEL } = await import('../../src/modules/google/ablage.ts')
    assert.ok(await fakeDrive.ordnerFinden('Lieferanten', FAKE_WURZEL))
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from drive_ordner`
    assert.equal(n, 4, 'gefundene Ordner werden gemerkt, nicht neu angelegt')
  })

  test('Upload an eine Bestellung: Stücke, Prüfung bei Google, Index mit Lieferant', async () => {
    ids.po = await bestellung([[ids.teil, 2000, 0.0034]])
    const inhalt = Buffer.alloc(600 * 1024, 7)
    const vorb = await aktionAusfuehrenGeprueft(
      'einkauf.upload_vorbereiten',
      {
        parameter: {
          name: 'Frosted_Keycaps_RevB.ai',
          mime: 'application/postscript',
          groesse: inhalt.byteLength,
          modell: 'purchase_order',
          record_id: ids.po,
        },
      },
      TINO,
    )
    const sitzung = (vorb.daten as { sitzung_id: string }).sitzung_id
    const dateiId = await stueckeSenden(sitzung, inhalt)

    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.dokument_registrieren', { parameter: { sitzung_id: sitzung, drive_file_id: dateiId } }, ANDERE),
      /anderen Benutzer/,
    )
    const r = await aktionAusfuehrenGeprueft(
      'einkauf.dokument_registrieren',
      { parameter: { sitzung_id: sitzung, drive_file_id: dateiId, revision: 'B' } },
      TINO,
    )
    ids.dok = r.recordId!
    const [d] = await h.sql<{ art: string; revision: string; partner_id: string; groesse: number; md5: string | null }[]>`
      select art::text, revision, partner_id, groesse::float as groesse, md5 from dokumente where id = ${ids.dok}`
    assert.equal(d.art, 'ai', 'Art aus dem Dateinamen vorbelegt')
    assert.equal(d.revision, 'B')
    assert.equal(d.partner_id, ids.lieferant, 'die Lieferantenakte sieht die Datei')
    assert.equal(d.groesse, inhalt.byteLength)
    assert.ok(d.md5)

    // Ordnerbaum: Lieferanten/<Lieferant>/<Bestellnummer>
    const ordner = await h.sql<{ schluessel: string; name: string }[]>`
      select schluessel, name from drive_ordner where schluessel like 'partner:%' or schluessel like 'purchase_order:%'
      order by schluessel`
    assert.deepEqual(ordner.map((o) => o.name).sort(), ['Shenzhen Keycap Co.', (await poNummer(ids.po))].sort())

    await assert.rejects(
      aktionAusfuehrenGeprueft('einkauf.dokument_registrieren', { parameter: { sitzung_id: sitzung, drive_file_id: dateiId } }, TINO),
      /bereits übernommen/,
    )
  })

  test('Eine fremde Datei (anderer Ordner) wird nicht übernommen', async () => {
    const vorb = await aktionAusfuehrenGeprueft(
      'einkauf.upload_vorbereiten',
      { parameter: { name: 'x.pdf', groesse: 10, modell: 'partner', record_id: ids.lieferant2 } },
      TINO,
    )
    const { fakeDrive } = await import('../../src/modules/google/google-fake.ts')
    const fremd = await fakeDrive.dateiHochladen({ name: 'x.pdf', mime: 'application/pdf', bytes: Buffer.alloc(10), elternId: 'woanders' })
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.dokument_registrieren',
        { parameter: { sitzung_id: (vorb.daten as { sitzung_id: string }).sitzung_id, drive_file_id: fremd.id } },
        TINO,
      ),
      /nicht im Ordner/,
    )
  })

  test('Verknüpfen, beschreiben, lösen — die Datei bleibt', async () => {
    await aktionAusfuehrenGeprueft(
      'einkauf.dokument_verknuepfen',
      { parameter: { dokument_id: ids.dok, modell: 'product_template', record_id: ids['tpl:Keycap-Set Frosted'] } },
      TINO,
    )
    await aktionAusfuehrenGeprueft(
      'einkauf.dokument_aendern',
      { parameter: { dokument_id: ids.dok, art: 'zeichnung', revision: 'C', notiz: 'Legenden neu' } },
      TINO,
    )
    const [d] = await h.sql<{ art: string; revision: string; notiz: string }[]>`
      select art::text, revision, notiz from dokumente where id = ${ids.dok}`
    assert.deepEqual(d, { art: 'zeichnung', revision: 'C', notiz: 'Legenden neu' })
    await aktionAusfuehrenGeprueft(
      'einkauf.dokument_loesen',
      { parameter: { dokument_id: ids.dok, modell: 'purchase_order', record_id: ids.po } },
      TINO,
    )
    const verweise = await h.sql<{ modell: string }[]>`select modell from dokument_verweise where dokument_id = ${ids.dok}`
    assert.deepEqual(verweise.map((v) => v.modell), ['product_template'])
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.dokument_loesen',
        { parameter: { dokument_id: ids.dok, modell: 'purchase_order', record_id: ids.po } },
        TINO,
      ),
      /gibt es nicht/,
    )
  })

  test('Lieferantenakte: Sprache, Maildomains eindeutig, Standards', async () => {
    await aktionAusfuehrenGeprueft(
      'einkauf.lieferantendaten_setzen',
      {
        recordId: ids.lieferant,
        parameter: { sprache: 'zh', mail_domains: ['Keycap-SZ.cn', 'keycap-sz.cn'], standard_incoterm: 'FOB', standard_waehrung: 'USD' },
      },
      TINO,
    )
    const [p] = await h.sql<{ sprache: string; mail_domains: string[]; standard_incoterm: string; standard_waehrung: string }[]>`
      select sprache, mail_domains, standard_incoterm, standard_waehrung from partners where id = ${ids.lieferant}`
    assert.deepEqual(p, { sprache: 'zh', mail_domains: ['keycap-sz.cn'], standard_incoterm: 'FOB', standard_waehrung: 'USD' })
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einkauf.lieferantendaten_setzen',
        { recordId: ids.lieferant2, parameter: { mail_domains: ['keycap-sz.cn'] } },
        TINO,
      ),
      /schon vergeben: keycap-sz\.cn \(Shenzhen Keycap Co\.\)/,
    )
  })

  test('Preis mit 6 Nachkommastellen bleibt exakt', async () => {
    const [l] = await h.sql<{ price_unit: string }[]>`
      select price_unit::text from purchase_order_lines where order_id = ${ids.po}`
    assert.equal(l.price_unit, '0.003400')
  })

  test('Dienstleistung: kein Wareneingang, die Weiche führt direkt zur Rechnung; gemischt nur Lagerware ins Lager', async () => {
    const nurDienst = await bestellung([[ids.dienst, 1, 450]])
    await aktionAusfuehrenGeprueft('einkauf.bestaetigen', { recordId: nurDienst }, TINO)
    const eingaenge = await h.sql`select 1 from stock_pickings where origin_model = 'purchase_order' and origin_id = ${nurDienst}`
    assert.equal(eingaenge.length, 0, 'kein Eingangs-Transfer')
    const [{ daten }] = await h.sql<{ daten: { hat_lagerware: boolean } }[]>`
      select prozess_beleg_daten('purchase_order', ${nurDienst}) as daten`
    assert.equal(daten.hat_lagerware, false)
    const naechste = (
      await h.sql<{ code: string }[]>`select code from prozess_naechste_schritte('einkauf_wareneingang_rechnung', ${nurDienst})`
    ).map((s) => s.code)
    assert.ok(naechste.includes('rechnung'), `angeboten: ${naechste.join(', ')}`)
    assert.ok(!naechste.includes('wareneingang'))
    const [po] = await h.sql<{ billing_status: string }[]>`select billing_status::text from purchase_orders where id = ${nurDienst}`
    assert.equal(po.billing_status, 'waiting', 'sofort abrechenbar (nach Bestellmenge)')

    const gemischt = await bestellung([[ids.teil, 5, 1], [ids.dienst, 1, 50]])
    await aktionAusfuehrenGeprueft('einkauf.bestaetigen', { recordId: gemischt }, TINO)
    const bewegungen = await h.sql<{ variant_id: string }[]>`
      select m.variant_id from stock_moves m join stock_pickings p on p.id = m.picking_id
      where p.origin_model = 'purchase_order' and p.origin_id = ${gemischt}`
    assert.deepEqual(bewegungen.map((b) => b.variant_id), [ids.teil])
  })
})

async function poNummer(id: string): Promise<string> {
  const [r] = await h.sql<{ number: string }[]>`select number from purchase_orders where id = ${id}`
  return r.number
}
