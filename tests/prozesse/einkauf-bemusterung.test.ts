/**
 * Einkauf, Stufe 4 (Migration 0107) gegen die echte Datenbank:
 *  - Musterpflicht: ohne freigegebenes Golden Sample des GEWÄHLTEN
 *    Lieferanten verweigert die Datenbank die Bestellung (Trigger), der
 *    Prozess führt durch den Teilprozess Bemusterung; nachbessern legt die
 *    nächste Runde an, ein neues Golden Sample ersetzt das alte.
 *  - Werkzeuge: Anlage aus der Werkzeugkosten-Zeile, Schüsse buchen,
 *    Sperren/Ausmustern, Lebensdauer-Wiedervorlage ab 90 %.
 *  - Lieferantenverträge: Preisliste → Lieferantenpreise mit Gültigkeit
 *    (alles oder nichts, ersetzt beim zweiten Mal), Gültigkeit folgt dem
 *    Vertrag, Beenden kürzt sie; ablaufende Verträge erscheinen als
 *    regelbasierte Wiedervorlage und verschwinden nach der Kündigung.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_bemusterung_check'
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }

let h: Harness
const ids: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

/** Angebotene Schritte, sortiert — die Reihenfolge der Kanten interessiert hier nicht. */
async function naechste(prozess: string, id: string): Promise<string[]> {
  return (await h.sql<{ code: string }[]>`select code from prozess_naechste_schritte(${prozess}, ${id})`)
    .map((z) => z.code)
    .sort()
}

async function artikel(sku: string, name: string): Promise<string> {
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, type, uom_id, can_be_purchased)
    values (${name}, 'goods', (select id from uoms where name = 'Stück' limit 1), true) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  await h.sql`update product_variants set sku = ${sku} where template_id = ${tpl.id}`
  return tpl.id
}

describe('Bemusterung und Musterpflicht', () => {
  test('Vorbereitung: zwei Lieferanten, Projekt mit Musterpflicht, entschieden', async () => {
    const lieferant = async (name: string, waehrung: string) =>
      (
        await h.sql<{ id: string }[]>`
          insert into partners (name, is_vendor, is_company, sprache, country_code, standard_waehrung)
          values (${name}, true, true, 'en', 'CN', ${waehrung}) returning id`
      )[0].id
    ids.cn = await lieferant('Ningbo Mould Co.', 'CNY')
    ids.zweit = await lieferant('Xiamen Plastics Ltd.', 'USD')
    await h.sql`insert into exchange_rates (currency, rate, valid_from, source)
                values ('CNY', 0.128, current_date - 1, 'manuell') on conflict do nothing`

    const r = await aktion('einkauf.projekt_anlegen', undefined, {
      titel: 'Tastaturgehäuse Spritzguss',
      art: 'neuteil',
      muster_pflicht: true,
      positionen: [{ bezeichnung: 'Gehäuse ABS schwarz', menge: 1000, zielpreis_eur: 4, gewicht_g: 400, hs_code: '3926' }],
    })
    ids.projekt = r.recordId!
    const [pos] = await h.sql<{ id: string }[]>`select id from einkaufsprojekt_positionen where projekt_id = ${ids.projekt}`
    const angebot = async (partner: string, preis: number, werkzeug: number, muster: number) =>
      String(
        (
          await aktion('einkauf.angebot_erfassen', ids.projekt, {
            partner_id: partner,
            waehrung: 'CNY',
            incoterm_code: 'FOB',
            werkzeugkosten: werkzeug,
            musterkosten: muster,
            staffeln: [{ position_id: pos.id, ab_menge: 500, preis }],
          })
        ).daten!.angebot_id,
      )
    ids.angebotCn = await angebot(ids.cn, 24, 18000, 400)
    ids.angebotZweit = await angebot(ids.zweit, 26, 0, 0)
    await aktion('einkauf.projekt_entscheiden', ids.projekt, { angebot_id: ids.angebotCn })
    const [ep] = await h.sql<{ nummer: string; muster_pflicht: boolean }[]>`
      select nummer, muster_pflicht from einkaufsprojekte where id = ${ids.projekt}`
    assert.equal(ep.muster_pflicht, true)
    ids.nummer = ep.nummer
  })

  test('ohne Golden Sample: Bestellung abgewiesen, der Prozess wartet auf die Bemusterung', async () => {
    await assert.rejects(
      aktion('einkauf.projekt_bestellen', ids.projekt),
      new RegExp(`${ids.nummer.replace('/', '\\/')} hat Musterpflicht: ohne freigegebenes Golden Sample von Ningbo Mould Co\\. wird nicht bestellt`),
    )
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from purchase_orders where einkaufsprojekt_id = ${ids.projekt}`
    assert.equal(n, 0, 'nichts halb angelegt — die Transaktion ist zurückgerollt')
    const [{ artikel }] = await h.sql<{ artikel: number }[]>`
      select count(*)::int as artikel from product_templates where name = 'Gehäuse ABS schwarz'`
    assert.equal(artikel, 0, 'auch der neue Artikel nicht')
    assert.deepEqual(await naechste('einkaufsprojekt', ids.projekt), ['abbrechen', 'bemusterung'])
  })

  test('Golden Sample eines ANDEREN Lieferanten zählt nicht', async () => {
    const r = await aktion('einkauf.muster_anfordern', undefined, { projekt_id: ids.projekt, partner_id: ids.zweit })
    await aktion('einkauf.muster_bewerten', r.recordId, { ergebnis: 'freigeben', golden: true })
    await assert.rejects(aktion('einkauf.projekt_bestellen', ids.projekt), /Golden Sample von Ningbo Mould Co\./)
  })

  test('Runden: Kosten aus dem Angebot, Eingang, Nachbessern legt Runde 2 an (Revision B)', async () => {
    const r = await aktion('einkauf.muster_anfordern', undefined, {
      projekt_id: ids.projekt,
      partner_id: ids.cn,
      bezeichnung: 'T1-Muster',
      revision: 'A',
      tracking: 'SF1234567890',
    })
    ids.runde1 = r.recordId!
    assert.match(r.text!, /Runde 1/)
    const [b] = await h.sql<{ kosten: number; waehrung: string; angebot_id: string; bestellt_am: string }[]>`
      select kosten::float as kosten, waehrung, angebot_id, bestellt_am::text as bestellt_am from bemusterungen where id = ${ids.runde1}`
    assert.deepEqual({ kosten: b.kosten, waehrung: b.waehrung, angebot_id: b.angebot_id }, { kosten: 400, waehrung: 'CNY', angebot_id: ids.angebotCn })
    assert.ok(b.bestellt_am, 'angefordert heute')

    // Vor dem Eingang bietet der Prozess das Erfassen (und Absagen) an, nicht das Bewerten.
    assert.deepEqual(await naechste('bemusterung', ids.runde1), ['ablehnen', 'erhalten'])
    await aktion('einkauf.muster_erhalten', ids.runde1, { erhalten_am: '2026-09-28' })
    assert.deepEqual(await naechste('bemusterung', ids.runde1), ['ablehnen', 'freigeben', 'nachbessern'])
    await assert.rejects(aktion('einkauf.muster_bewerten', ids.runde1, { ergebnis: 'nachbessern' }), /Befund/)

    const z = await aktion('einkauf.muster_bewerten', ids.runde1, { ergebnis: 'nachbessern', note: 2, bewertung: 'Einfallstellen an den Domen' })
    ids.runde2 = String(z.daten!.naechste_runde_id)
    const [n] = await h.sql<{ runde: number; revision: string; status: string; vorgaenger_id: string; angebot_id: string }[]>`
      select runde, revision, status::text as status, vorgaenger_id, angebot_id from bemusterungen where id = ${ids.runde2}`
    assert.deepEqual({ ...n }, { runde: 2, revision: 'B', status: 'offen', vorgaenger_id: ids.runde1, angebot_id: ids.angebotCn })
    await assert.rejects(aktion('einkauf.muster_erhalten', ids.runde1), /Runde 1 ist schon zum Nachbessern zurück/)
    // Teilprozess am Projekt: Runde 2 ist offen → die Bemusterung läuft noch.
    const [stand] = await h.sql<{ gesamt: number; fertig: number }[]>`
      select gesamt, fertig from teilprozess_stand('bemusterung', '{"spalte": "projekt_id"}', 'einkaufsprojekt', ${ids.projekt})`
    assert.deepEqual({ ...stand }, { gesamt: 3, fertig: 2 })
  })

  test('Golden Sample: Prozess bietet das Bestellen an, ein neues ersetzt das alte', async () => {
    await aktion('einkauf.muster_bewerten', ids.runde2, { ergebnis: 'freigeben', golden: true, note: 5 })
    const [b] = await h.sql<{ erhalten_am: string | null; golden: boolean }[]>`
      select erhalten_am::text as erhalten_am, golden from bemusterungen where id = ${ids.runde2}`
    assert.equal(b.golden, true)
    assert.ok(b.erhalten_am, 'wer freigibt, hat das Muster — der Eingang steht von selbst')
    const [daten] = await h.sql<{ d: { golden_sample: boolean } }[]>`select prozess_beleg_daten('einkaufsprojekt', ${ids.projekt}) as d`
    assert.equal(daten.d.golden_sample, true)
    assert.deepEqual(await naechste('einkaufsprojekt', ids.projekt), ['abbrechen', 'bestellen'])

    // Runde 3 als neues Golden Sample: Runde 2 verliert die Marke (höchstens eines je Lieferant).
    const r3 = await aktion('einkauf.muster_anfordern', undefined, { projekt_id: ids.projekt, partner_id: ids.cn })
    await aktion('einkauf.muster_bewerten', r3.recordId, { ergebnis: 'freigeben', golden: true })
    const golden = await h.sql<{ runde: number }[]>`
      select runde from bemusterungen where projekt_id = ${ids.projekt} and partner_id = ${ids.cn} and golden`
    assert.deepEqual(golden.map((g) => g.runde), [3])
    const [rev] = await h.sql<{ revision: string }[]>`select revision from bemusterungen where id = ${r3.recordId!}`
    assert.equal(rev.revision, 'C', 'die Revision zählt weiter')
  })

  test('Bestellen klappt jetzt — das Werkzeug entsteht aus der Werkzeugkosten-Zeile', async () => {
    const r = await aktion('einkauf.projekt_bestellen', ids.projekt)
    assert.match(r.text!, /Werkzeug WZ\/\d{5}/)
    const [wz] = await h.sql<{ id: string; partner_id: string; kosten: number; waehrung: string; status: string; po: string }[]>`
      select w.id, w.partner_id, w.kosten::float as kosten, w.waehrung, w.status::text as status, po.number as po
      from werkzeuge w join purchase_order_lines l on l.id = w.purchase_order_line_id
      join purchase_orders po on po.id = l.order_id
      where w.einkaufsprojekt_id = ${ids.projekt}`
    assert.deepEqual({ partner_id: wz.partner_id, kosten: wz.kosten, waehrung: wz.waehrung, status: wz.status },
      { partner_id: ids.cn, kosten: 18000, waehrung: 'CNY', status: 'in_auftrag' })
    ids.werkzeugAuto = wz.id
    await assert.rejects(
      aktion('einkauf.projekt_aendern', ids.projekt, { muster_pflicht: false }),
      /die Musterpflicht gilt bis zur Bestellung/,
    )
  })

  test('Musterpflicht abwählen vor der Bestellung steht im Verlauf', async () => {
    const r = await aktion('einkauf.projekt_anlegen', undefined, {
      titel: 'Ersatz-Füße', muster_pflicht: true, positionen: [{ bezeichnung: 'Gummifuß', menge: 5000 }],
    })
    await aktion('einkauf.projekt_aendern', r.recordId, { muster_pflicht: false })
    const [log] = await h.sql<{ message: string }[]>`
      select message from audit_log where model = 'einkaufsprojekt' and record_id = ${r.recordId!} order by created_at desc limit 1`
    assert.equal(log.message, 'Musterpflicht aufgehoben')
  })
})

describe('Werkzeuge', () => {
  test('anlegen mit Artikel, Schüsse buchen, Lebensdauer-Wiedervorlage ab 90 %', async () => {
    ids.deckel = await artikel('WZ-DECKEL-01', 'Deckel ABS')
    const r = await aktion('einkauf.werkzeug_anlegen', undefined, {
      bezeichnung: 'Form Deckel 2-fach',
      art: 'form',
      partner_id: ids.cn,
      eigentuemer: 'wir',
      kosten: 9500,
      produkt: 'WZ-DECKEL-01',
      lebensdauer_schuss: 10000,
      schuss_zaehler: 1000,
      status: 'aktiv',
    })
    ids.werkzeug = r.recordId!
    const [w] = await h.sql<{ nummer: string; template_id: string; waehrung: string }[]>`
      select nummer, template_id, waehrung from werkzeuge where id = ${ids.werkzeug}`
    assert.match(w.nummer, /^WZ\/\d{5}$/)
    assert.deepEqual({ template_id: w.template_id, waehrung: w.waehrung }, { template_id: ids.deckel, waehrung: 'CNY' })

    const b = await aktion('einkauf.werkzeug_schuss_buchen', ids.werkzeug, { anzahl: 7000, notiz: 'Los 1' })
    assert.match(b.text!, /8\.000 von 10\.000 Schuss \(80 %\)/)
    const regel = async () =>
      h.sql<{ grund: string; faellig_am: string }[]>`
        select grund, faellig_am::text as faellig_am from einkauf_regel_wiedervorlagen
        where modell = 'werkzeug' and record_id = ${ids.werkzeug}`
    assert.equal((await regel()).length, 0, 'unter 90 % keine Wiedervorlage')
    const c = await aktion('einkauf.werkzeug_schuss_buchen', ids.werkzeug, { anzahl: 1500 })
    assert.match(c.text!, /Über 90 %/)
    const [wv] = await regel()
    assert.match(wv.grund, /hat 9500 von 10000 Schuss \(95 %\)/)
  })

  test('Sperren mit Grund, dann nur Korrekturen nach unten; Ausmustern ist endgültig', async () => {
    await assert.rejects(aktion('einkauf.werkzeug_status_setzen', ids.werkzeug, { status: 'gesperrt' }), /Grund/)
    await aktion('einkauf.werkzeug_status_setzen', ids.werkzeug, { status: 'gesperrt', grund: 'Kavität 2 beschädigt' })
    await assert.rejects(aktion('einkauf.werkzeug_schuss_buchen', ids.werkzeug, { anzahl: 10 }), /gesperrt/)
    await aktion('einkauf.werkzeug_schuss_buchen', ids.werkzeug, { anzahl: -500, notiz: 'Doppelt gemeldet' })
    await assert.rejects(aktion('einkauf.werkzeug_schuss_buchen', ids.werkzeug, { anzahl: -99999 }), /unter 0/)
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from einkauf_regel_wiedervorlagen where record_id = ${ids.werkzeug}`
    assert.equal(n, 0, 'gesperrte Werkzeuge erinnern nicht')
    await aktion('einkauf.werkzeug_status_setzen', ids.werkzeug, { status: 'ausgemustert', grund: 'Nachbau bestellt' })
    await assert.rejects(aktion('einkauf.werkzeug_status_setzen', ids.werkzeug, { status: 'aktiv' }), /endgültig/)
  })

  test('aus einer Bestellzeile: Lieferant, Kosten und Projekt kommen von dort', async () => {
    const [zeile] = await h.sql<{ id: string }[]>`
      select l.id from purchase_order_lines l join purchase_orders po on po.id = l.order_id
      where po.einkaufsprojekt_id = ${ids.projekt} and l.name like 'Musterkosten%'`
    const r = await aktion('einkauf.werkzeug_anlegen', undefined, {
      bezeichnung: 'Prüflehre Gehäuse',
      art: 'vorrichtung',
      purchase_order_line_id: zeile.id,
    })
    const [w] = await h.sql<{ partner_id: string; kosten: number; waehrung: string; einkaufsprojekt_id: string; status: string }[]>`
      select partner_id, kosten::float as kosten, waehrung, einkaufsprojekt_id, status::text as status
      from werkzeuge where id = ${r.recordId!}`
    assert.deepEqual({ ...w }, { partner_id: ids.cn, kosten: 400, waehrung: 'CNY', einkaufsprojekt_id: ids.projekt, status: 'in_auftrag' })
    await assert.rejects(aktion('einkauf.werkzeug_anlegen', undefined, { bezeichnung: 'ohne Standort' }), /Lieferanten/)
  })
})

describe('Lieferantenverträge und Preislisten', () => {
  test('Preisliste → Lieferantenpreise mit Gültigkeit und Währung des Vertrags', async () => {
    ids.kappe = await artikel('KC-PBT-01', 'Keycap-Set PBT')
    ids.puller = await artikel('KC-PULL', 'Keycap-Puller')
    const r = await aktion('einkauf.lieferantenvertrag_anlegen', undefined, {
      partner_id: ids.zweit,
      art: 'preisliste',
      titel: 'Preisliste 2026/27',
      gueltig_von: '2026-10-01',
      gueltig_bis: '2027-09-30',
    })
    ids.preisliste = r.recordId!
    const u = await aktion('einkauf.preisliste_uebernehmen', ids.preisliste, {
      text: '# Keycaps\nKC-PBT-01 / 500: 7,20\nKC-PBT-01 / 1.000: 6,85\nKC-PULL: 0,35',
      lieferzeit_tage: 30,
    })
    assert.match(u.text!, /3 Lieferantenpreis\(e\) aus „Preisliste 2026\/27" übernommen \(USD, gültig 01\.10\.2026 bis 30\.09\.2027\)/)
    const preise = await h.sql<{ template_id: string; min_qty: number; price: number; currency: string; date_start: string; date_end: string; lead_time_days: number }[]>`
      select template_id, min_qty::float as min_qty, price::float as price, currency, date_start::text as date_start,
             date_end::text as date_end, lead_time_days
      from vendor_prices where vertrag_id = ${ids.preisliste} order by template_id = ${ids.kappe} desc, min_qty`
    assert.deepEqual(preise.map((p) => ({ ...p })), [
      { template_id: ids.kappe, min_qty: 500, price: 7.2, currency: 'USD', date_start: '2026-10-01', date_end: '2027-09-30', lead_time_days: 30 },
      { template_id: ids.kappe, min_qty: 1000, price: 6.85, currency: 'USD', date_start: '2026-10-01', date_end: '2027-09-30', lead_time_days: 30 },
      { template_id: ids.puller, min_qty: 1, price: 0.35, currency: 'USD', date_start: '2026-10-01', date_end: '2027-09-30', lead_time_days: 30 },
    ])
  })

  test('alles oder nichts: unlesbare Zeile oder unbekannter Artikel ändern nichts; zweite Übernahme ersetzt', async () => {
    await assert.rejects(
      aktion('einkauf.preisliste_uebernehmen', ids.preisliste, { text: 'KC-PBT-01 / 500: 7,00\nirgendwas ohne Preis' }),
      /Nichts übernommen — bitte korrigieren: „irgendwas ohne Preis" ist keine Preiszeile/,
    )
    await assert.rejects(
      aktion('einkauf.preisliste_uebernehmen', ids.preisliste, { text: 'GIBTS-NICHT: 1,00' }),
      /Nichts übernommen — Produkt „GIBTS-NICHT" nicht gefunden/,
    )
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from vendor_prices where vertrag_id = ${ids.preisliste}`
    assert.equal(n, 3, 'die alten Preise stehen noch')

    await aktion('einkauf.preisliste_uebernehmen', ids.preisliste, { preise: [{ produkt: 'KC-PBT-01', ab_menge: 500, preis: 7.05 }] })
    const preise = await h.sql<{ price: number }[]>`select price::float as price from vendor_prices where vertrag_id = ${ids.preisliste}`
    assert.deepEqual(preise.map((p) => p.price), [7.05], 'ersetzt, nicht ergänzt')
    await assert.rejects(
      aktion('einkauf.lieferantenvertrag_aendern', ids.preisliste, { waehrung: 'EUR' }),
      /schon 1 Preise in USD/,
    )
  })

  test('Gültigkeit folgt dem Vertrag; Beenden kürzt sie, best_vendor_price kennt den Preis danach nicht mehr', async () => {
    await aktion('einkauf.lieferantenvertrag_aendern', ids.preisliste, { gueltig_von: '2026-09-01', gueltig_bis: '2027-12-31' })
    const [p] = await h.sql<{ date_start: string; date_end: string }[]>`
      select date_start::text as date_start, date_end::text as date_end from vendor_prices where vertrag_id = ${ids.preisliste}`
    assert.deepEqual({ ...p }, { date_start: '2026-09-01', date_end: '2027-12-31' })
    const preisHeute = async () =>
      (
        await h.sql<{ price: number | null }[]>`
          select (best_vendor_price(pv.id, ${ids.zweit}, 600)).price::float as price
          from product_variants pv where pv.template_id = ${ids.kappe}`
      )[0].price
    assert.equal(await preisHeute(), 7.05)

    await aktion('einkauf.lieferantenvertrag_status_setzen', ids.preisliste, { status: 'beendet', datum: '2026-09-15' })
    const [v] = await h.sql<{ status: string; gueltig_bis: string }[]>`
      select status::text as status, gueltig_bis::text as gueltig_bis from lieferantenvertraege where id = ${ids.preisliste}`
    assert.deepEqual({ ...v }, { status: 'beendet', gueltig_bis: '2026-09-15' })
    assert.equal(await preisHeute(), null, 'nach dem Ende gilt der Vertragspreis nicht mehr')
    await assert.rejects(aktion('einkauf.preisliste_uebernehmen', ids.preisliste, { text: 'KC-PULL: 0,30' }), /beendet/)
  })

  test('NDA und QSV liefern keine Preise', async () => {
    const r = await aktion('einkauf.lieferantenvertrag_anlegen', undefined, { partner_id: ids.cn, art: 'nda', titel: 'NDA Gehäuse' })
    await assert.rejects(aktion('einkauf.preisliste_uebernehmen', r.recordId, { text: 'KC-PULL: 0,30' }), /nicht aus „NDA/)
  })

  test('ablaufender Vertrag erscheint als regelbasierte Wiedervorlage und verschwindet nach der Kündigung', async () => {
    const heute = new Date()
    const inTagen = (n: number) => new Date(heute.getTime() + n * 86_400_000).toISOString().slice(0, 10)
    const anlegen = async (titel: string, extra: Record<string, unknown>) =>
      (await aktion('einkauf.lieferantenvertrag_anlegen', undefined, { partner_id: ids.cn, art: 'rahmenvertrag', titel, ...extra })).recordId!
    // Ende in 100 Tagen, 3 Monate Frist → Stichtag in ~10 Tagen ≤ heute + 30.
    ids.rvBald = await anlegen('Rahmenvertrag Gehäuse', { gueltig_bis: inTagen(100), kuendigungsfrist_monate: 3 })
    // Ende in 200 Tagen ohne Frist → noch nicht dran.
    ids.rvFern = await anlegen('Rahmenvertrag Kappen', { gueltig_bis: inTagen(200) })
    // Unbefristet → nie.
    await anlegen('QSV unbefristet', { kuendigungsfrist_monate: 6 })
    // Verlängert sich jährlich, vor 400 Tagen erstmals geendet → nächster Stichtag in der Zukunft.
    ids.rvRollt = await anlegen('Rahmenvertrag rollierend', {
      gueltig_bis: inTagen(-400), kuendigungsfrist_monate: 1, verlaengerung_monate: 12, erinnerung_tage: 365,
    })

    const regeln = await h.sql<{ record_id: string; grund: string; frist: string; faellig_am: string; zustaendig_id: string | null }[]>`
      select record_id, grund, frist::text as frist, faellig_am::text as faellig_am, zustaendig_id
      from einkauf_regel_wiedervorlagen where modell = 'lieferantenvertrag' order by grund`
    const bald = regeln.find((r) => r.record_id === ids.rvBald)
    assert.ok(bald, 'der bald ablaufende Vertrag ist da')
    assert.match(bald.grund, /^Rahmenvertrag „Rahmenvertrag Gehäuse" läuft am \d\d\.\d\d\.\d{4} aus — Kündigungsfrist bis \d\d\.\d\d\.\d{4}$/)
    const [soll] = await h.sql<{ stichtag: string }[]>`
      select lieferantenvertrag_stichtag(v)::text as stichtag from lieferantenvertraege v where id = ${ids.rvBald}`
    assert.equal(bald.frist, soll.stichtag)
    assert.ok(bald.faellig_am <= inTagen(0), 'fällig = Stichtag − 30 Tage, also schon heute')
    assert.ok(!regeln.some((r) => r.record_id === ids.rvFern), 'fernes Ende noch nicht')
    const rollt = regeln.find((r) => r.record_id === ids.rvRollt)
    assert.ok(rollt, 'der rollierende Vertrag erinnert an seinen nächsten Stichtag')
    assert.match(rollt.grund, /verlängert sich am .* um 12 Monate — kündigen bis/)
    assert.ok(rollt.frist >= inTagen(0), 'der nächste Stichtag liegt nicht in der Vergangenheit')

    await aktion('einkauf.lieferantenvertrag_status_setzen', ids.rvBald, { status: 'gekuendigt' })
    const [{ n }] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from einkauf_regel_wiedervorlagen where record_id = ${ids.rvBald}`
    assert.equal(n, 0, 'gekündigt → keine Wiedervorlage mehr')
    await assert.rejects(aktion('einkauf.lieferantenvertrag_status_setzen', ids.rvBald, { status: 'gekuendigt' }), /schon gekündigt/)
  })

  test('Dokumente und manuelle Wiedervorlagen hängen an Vertrag, Werkzeug und Muster', async () => {
    const [d] = await h.sql<{ id: string }[]>`
      insert into dokumente (drive_file_id, name, art, quelle) values ('fake-vertrag-1', 'NDA signiert.pdf', 'nda', 'manuell') returning id`
    await aktion('einkauf.dokument_verknuepfen', undefined, { dokument_id: d.id, modell: 'lieferantenvertrag', record_id: ids.rvFern })
    await aktion('einkauf.dokument_verknuepfen', undefined, { dokument_id: d.id, modell: 'werkzeug', record_id: ids.werkzeugAuto })
    await aktion('einkauf.dokument_verknuepfen', undefined, { dokument_id: d.id, modell: 'bemusterung', record_id: ids.runde2 })
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from dokument_verweise where dokument_id = ${d.id}`
    assert.equal(n, 3)
    await aktion('einkauf.wiedervorlage_anlegen', undefined, {
      modell: 'werkzeug', record_id: ids.werkzeugAuto, faellig_am: '2026-11-01', grund: 'T1-Freigabe nachhalten',
    })
    await assert.rejects(
      aktion('einkauf.dokument_verknuepfen', undefined, { dokument_id: d.id, modell: 'werkzeug', record_id: ids.preisliste }),
      /Werkzeug existiert nicht/,
    )
  })
})
