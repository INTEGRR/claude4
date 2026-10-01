/**
 * Einkauf, Stufe 5 (Migration 0108) gegen die echte Datenbank:
 *  - Sammelsendung mit drei Bestellungen zweier Lieferanten: Verschiffung
 *    setzt verschifft_am (Zahlplan-Rate „bei Verschiffung" wird fällig),
 *    ETA wandert auf die Bestellungen;
 *  - Verteilung auf die Wareneingänge: Summe = Kosten, Rundungsrest auf den
 *    letzten Eingang, Fracht nach Gewicht, Zoll nach Wert, Schätzung →
 *    Rechnung als Storno + Neubuchung (landed_cost_post unverändert), EUSt
 *    nie in den Landed Costs;
 *  - Pflichtdokumente: fehlende CI nach der Verschiffung erscheint und
 *    verschwindet mit dem Upload; Nachfrage-Entwurf in Lieferantensprache;
 *    Endrechnung ab Wareneingang, Spediteursrechnung und Zollbescheid;
 *  - lernende Schätzwerte (Vorschlag → übernehmen), DATEV-Vorbereitung
 *    (nur Übersicht), Cockpit-Kategorien je Einkäufer, Digest-Job in den
 *    Telegram-Kanal gegliedert nach Einkäufer.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { cockpitLaden } from '../../src/modules/einkauf/cockpit.ts'

const DATENBANK = 'erp_sendung_check'
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

const heute = () => new Date().toISOString().slice(0, 10)
const inTagen = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function lieferant(name: string, land: string, sprache: string, email: string): Promise<string> {
  const [p] = await h.sql<{ id: string }[]>`
    insert into partners (name, is_vendor, is_company, sprache, country_code, standard_waehrung, email)
    values (${name}, true, true, ${sprache}, ${land}, 'EUR', ${email}) returning id`
  return p.id
}

async function artikel(sku: string, name: string, gewichtG: number | null, hs: string): Promise<void> {
  const [tpl] = await h.sql<{ id: string }[]>`
    insert into product_templates (name, type, uom_id, can_be_purchased, weight_g, hs_code)
    values (${name}, 'goods', (select id from uoms where name = 'Stück' limit 1), true, ${gewichtG}, ${hs}) returning id`
  await h.sql`select generate_variants(${tpl.id})`
  await h.sql`update product_variants set sku = ${sku} where template_id = ${tpl.id}`
}

async function bestellung(partnerId: string, sku: string, menge: number, preis: number): Promise<{ id: string; number: string }> {
  const r = await aktion('einkauf.bestellung_mit_positionen', undefined, {
    lieferant: partnerId,
    positionen: [{ produkt: sku, menge, preis }],
  })
  await aktion('einkauf.bestaetigen', r.recordId)
  const [po] = await h.sql<{ number: string }[]>`select number from purchase_orders where id = ${r.recordId!}`
  return { id: r.recordId!, number: po.number }
}

async function eingangVon(poId: string): Promise<{ id: string; number: string; eingangs_sendung_id: string | null }> {
  const [p] = await h.sql<{ id: string; number: string; eingangs_sendung_id: string | null }[]>`
    select id, number, eingangs_sendung_id from stock_pickings
    where origin_model = 'purchase_order' and origin_id = ${poId} order by created_at limit 1`
  return p
}

/** Dokument „hochgeladen" (Index-Zeile wie nach dokument_registrieren) und verknüpft. */
async function dokument(art: string, modell: string, recordId: string, partnerId: string | null = null): Promise<string> {
  const [d] = await h.sql<{ id: string }[]>`
    insert into dokumente (drive_file_id, name, mime, groesse, art, partner_id, hochgeladen_von)
    values (${`fake-${art}-${Math.random().toString(36).slice(2)}`}, ${`${art}.pdf`}, 'application/pdf', 2048, ${art}::dokument_art,
            ${partnerId}, 'test')
    returning id`
  await h.sql`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von) values (${d.id}, ${modell}, ${recordId}, 'test')`
  return d.id
}

async function fehlend(modell: string, recordId: string): Promise<string[]> {
  return (
    await h.sql<{ art: string }[]>`
      select art from einkauf_offene_pflichtdokumente where modell = ${modell} and record_id = ${recordId} order by art`
  ).map((r) => r.art)
}

/** Gebuchte Landed Costs der Sendung je Wareneingang (Nummer → Summe). */
async function verteilung(sendungId: string): Promise<{ picking: string; art: string; betrag: number; schaetzung: boolean }[]> {
  const zeilen = await h.sql<{ picking: string; art: string; betrag: number; schaetzung: boolean }[]>`
    select p.number as picking, k.art, l.amount as betrag, l.is_estimate as schaetzung
    from landed_costs l
    join sendung_kosten k on k.id = l.sendung_kosten_id
    join stock_pickings p on p.id = l.picking_id
    where k.sendung_id = ${sendungId} and l.state = 'posted'
    order by k.art, p.number`
  return zeilen.map((z) => ({ ...z }))
}

describe('Sammelsendung: zwei Lieferanten, drei Bestellungen', () => {
  test('Vorbereitung: Lieferanten in China, Spediteur, Artikel mit Gewicht und HS-Code, Zolltarife', async () => {
    ids.a = await lieferant('Shenzhen PCB Works', 'CN', 'zh', 'sales@pcbworks-test.cn')
    ids.b = await lieferant('Dongguan Keycaps Ltd.', 'CN', 'en', 'sales@keycaps-test.cn')
    ids.kn = await lieferant('Kühne + Nagel (AG & Co.) KG', 'DE', 'de', 'hamburg@kn-test.example')
    await artikel('ES-PCB', 'Platine 60 %', 50, '85340090')
    await artikel('ES-CAP', 'Keycap-Set PBT', 100, '84733020')
    await h.sql`insert into zolltarife (hs_praefix, satz_pct, bezeichnung) values ('8534', 0, 'Leiterplatten'), ('8473', 2.5, 'Teile für Maschinen der 8471')`
    const [{ id: tino }] = await h.sql<{ id: string }[]>`
      insert into users (name, benutzername, password_hash, role) values ('Tino', 'tino', 'x', 'mitarbeiter') returning id`
    ids.tino = tino

    const a1 = await bestellung(ids.a, 'ES-PCB', 100, 4)
    const b = await bestellung(ids.b, 'ES-CAP', 200, 2)
    const a2 = await bestellung(ids.a, 'ES-PCB', 100, 4)
    Object.assign(ids, { a1: a1.id, a1Nr: a1.number, b1: b.id, b1Nr: b.number, a2: a2.id, a2Nr: a2.number })
    // Tino kauft bei Shenzhen; A1 mit Zahlplan 30 % Anzahlung / 70 % bei Verschiffung.
    await h.sql`update purchase_orders set user_id = ${tino}, expected_arrival = ${inTagen(60)}::date where id in (${a1.id}, ${a2.id})`
    await h.sql`insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
                values (${a1.id}, 10, 'Anzahlung', 30, 'bestellung'), (${a1.id}, 20, 'Rest bei Verschiffung', 70, 'verschiffung')`
  })

  test('anlegen und zuordnen: die Wareneingänge hängen an der Sendung', async () => {
    const r = await aktion('einkauf.sendung_anlegen', undefined, {
      modus: 'see',
      bezeichnung: 'LCL Shenzhen KW 41',
      spediteur_id: ids.kn,
      gewicht_kg: 30,
      volumen_cbm: 0.4,
      bestellungen: [ids.a1Nr, ids.b1Nr],
    })
    ids.s = r.recordId!
    assert.match(r.text ?? '', /ES\/\d{5} angelegt mit 2 Bestellung/)
    await assert.rejects(aktion('einkauf.sendung_bestellung_zuordnen', ids.s, { bestellungen: ['P99999'] }), /nicht gefunden: P99999/)
    const z = await aktion('einkauf.sendung_bestellung_zuordnen', ids.s, { bestellungen: [ids.a2] })
    assert.match(z.text ?? '', /3 Wareneingang/)
    for (const po of [ids.a1, ids.b1, ids.a2]) {
      assert.equal((await eingangVon(po)).eingangs_sendung_id, ids.s)
    }
    const [s] = await h.sql<{ status: string; nummer: string }[]>`select status::text as status, nummer from eingangs_sendungen where id = ${ids.s}`
    assert.equal(s.status, 'geplant')
    ids.sNr = s.nummer
    // Vor der Verschiffung keine CI-Pflicht (PI ja: A1 hat eine Anzahlung).
    assert.deepEqual(await fehlend('purchase_order', ids.a1), ['pi'])
    assert.deepEqual(await fehlend('purchase_order', ids.b1), [])
  })

  test('verschiffen: verschifft_am und ETA an den Bestellungen, die Rate „bei Verschiffung" wird fällig', async () => {
    const vorher = await h.sql<{ faellig: string }[]>`
      select zahlplan_faelligkeit(r)::text as faellig from zahlplan_raten r
      where r.purchase_order_id = ${ids.a1} and r.ausloeser = 'verschiffung'`
    assert.equal(vorher[0].faellig, inTagen(30), 'ohne Verschiffung: ETA − Transitzeit (Schätzung)')

    const verschifft = inTagen(-2)
    const r = await aktion('einkauf.sendung_verschiffen', ids.s, { verschifft_am: verschifft, eta: inTagen(25), hbl_awb: 'KNSZXHAM0042' })
    assert.match(r.text ?? '', new RegExp(`Raten „bei Verschiffung" von ${ids.a1Nr} sind jetzt fällig`))

    const pos = await h.sql<{ id: string; verschifft_am: string; eta_confirmed: string; tracking_number: string; carrier: string }[]>`
      select id, verschifft_am::text as verschifft_am, eta_confirmed::text as eta_confirmed, tracking_number, carrier
      from purchase_orders where id in (${ids.a1}, ${ids.b1}, ${ids.a2})`
    for (const po of pos) {
      assert.deepEqual(
        { v: po.verschifft_am, eta: po.eta_confirmed, t: po.tracking_number, c: po.carrier },
        { v: verschifft, eta: inTagen(25), t: 'KNSZXHAM0042', c: 'Kühne + Nagel (AG & Co.) KG' },
      )
    }
    const [rate] = await h.sql<{ faellig: string }[]>`
      select zahlplan_faelligkeit(r)::text as faellig from zahlplan_raten r
      where r.purchase_order_id = ${ids.a1} and r.ausloeser = 'verschiffung'`
    assert.equal(rate.faellig, verschifft, 'derselbe Mechanismus wie „Verschiffung erfassen": verschifft_am')
    const [eingang] = await h.sql<{ tag: string }[]>`
      select scheduled_date::date::text as tag from stock_pickings where id = ${(await eingangVon(ids.b1)).id}`
    assert.equal(eingang.tag, inTagen(25), 'der Lagerist plant nach dem ETA der Sendung')
  })

  test('Pflichtdokumente: fehlende CI nach der Verschiffung erscheint und verschwindet mit dem Upload', async () => {
    assert.deepEqual(await fehlend('purchase_order', ids.a1), ['ci', 'packing_list', 'pi'])
    assert.deepEqual(await fehlend('purchase_order', ids.b1), ['ci', 'packing_list'])

    await dokument('ci', 'purchase_order', ids.a1)
    assert.deepEqual(await fehlend('purchase_order', ids.a1), ['packing_list', 'pi'])
    // Eine CI an der Sendung zählt nur für die Bestellungen ihres Lieferanten.
    await dokument('ci', 'eingangs_sendung', ids.s, ids.b)
    assert.deepEqual(await fehlend('purchase_order', ids.b1), ['packing_list'])
    assert.deepEqual(await fehlend('purchase_order', ids.a2), ['ci', 'packing_list'])
  })

  test('Nachfragen: Entwurf in der Sprache des Lieferanten mit genau den fehlenden Dokumenten', async () => {
    const r = await aktion('einkauf.pflichtdokumente_nachfragen', undefined, { modell: 'purchase_order', record_id: ids.a2 })
    const [e] = await h.sql<{ sprache: string; betreff: string; text_de: string; text_ziel: string; partner_id: string; status: string; an: string[] }[]>`
      select sprache, betreff, text_de, text_ziel, partner_id, status::text as status, an from mail_entwuerfe where id = ${r.recordId!}`
    assert.equal(e.sprache, 'zh')
    assert.equal(e.partner_id, ids.a)
    assert.equal(e.status, 'entwurf', 'gesendet wird erst nach Freigabe')
    assert.deepEqual(e.an, ['sales@pcbworks-test.cn'])
    assert.ok(e.betreff.includes(ids.a2Nr))
    assert.match(e.text_ziel, /商业发票 \(CI\)/)
    assert.match(e.text_ziel, /装箱单/)
    assert.match(e.text_de, /- Commercial Invoice \(CI\)\n- Packliste/)
    assert.doesNotMatch(e.text_de, /\[dokumente\]/)
    await assert.rejects(
      aktion('einkauf.pflichtdokumente_nachfragen', undefined, { modell: 'purchase_order', record_id: ids.b1, antwort_erwartet_bis: inTagen(3) })
        .then(async () => {
          await dokument('packing_list', 'purchase_order', ids.b1)
          return aktion('einkauf.pflichtdokumente_nachfragen', undefined, { modell: 'purchase_order', record_id: ids.b1 })
        }),
      new RegExp(`Für ${ids.b1Nr} fehlt derzeit kein Pflichtdokument`),
    )
  })

  test('verzollen, ankommen, Wareneingänge buchen — Teilprozess fertig, Abrechnen wird angeboten', async () => {
    await aktion('einkauf.sendung_verzollen', ids.s)
    await aktion('einkauf.sendung_ankommen', ids.s)
    assert.deepEqual(
      (await h.sql<{ code: string }[]>`select code from prozess_naechste_schritte('eingangs_sendung', ${ids.s})`).map((z) => z.code),
      ['wareneingang'],
    )
    await assert.rejects(aktion('einkauf.sendung_abrechnen', ids.s), /keinen gebuchten Wareneingang/)
    for (const po of [ids.a1, ids.b1, ids.a2]) {
      await h.sql`select picking_validate(${(await eingangVon(po)).id}, '{}'::jsonb, false)`
    }
    assert.deepEqual(
      (await h.sql<{ code: string }[]>`select code from prozess_naechste_schritte('eingangs_sendung', ${ids.s})`).map((z) => z.code),
      ['abrechnen'],
    )
    await assert.rejects(aktion('einkauf.sendung_stornieren', ids.s, { grund: 'Test' }), /storniert wird nur eine geplante oder verschiffte/)
  })

  test('schätzen und verteilen: Fracht nach Gewicht, Zoll nach Wert, Summe = Kosten', async () => {
    const r = await aktion('einkauf.sendung_schaetzen', ids.s)
    assert.match(r.text ?? '', /Fracht 150,00 EUR/)
    const kosten = await h.sql<{ art: string; betrag: number; schaetzung: boolean }[]>`
      select art, betrag, schaetzung from sendung_kosten where sendung_id = ${ids.s} order by art`
    // 30 kg × 1,50 €/kg = 45 € < Mindestbetrag 150 €; Zoll = 400 € × 2,5 % × (1 + 150/1200) = 11,25 €.
    assert.deepEqual(kosten.map((k) => ({ ...k })), [
      { art: 'fracht', betrag: 150, schaetzung: true },
      { art: 'zoll', betrag: 11.25, schaetzung: true },
    ])

    await aktion('einkauf.sendung_verteilen', ids.s)
    const [e1, e2, e3] = [await eingangVon(ids.a1), await eingangVon(ids.b1), await eingangVon(ids.a2)].map((e) => e.number)
    assert.deepEqual(await verteilung(ids.s), [
      // Gewichte 5 kg / 20 kg / 5 kg.
      { picking: e1, art: 'fracht', betrag: 25, schaetzung: true },
      { picking: e2, art: 'fracht', betrag: 100, schaetzung: true },
      { picking: e3, art: 'fracht', betrag: 25, schaetzung: true },
      // Warenwerte je 400 €.
      { picking: e1, art: 'zoll', betrag: 3.75, schaetzung: true },
      { picking: e2, art: 'zoll', betrag: 3.75, schaetzung: true },
      { picking: e3, art: 'zoll', betrag: 3.75, schaetzung: true },
    ])
    const [{ wert }] = await h.sql<{ wert: number }[]>`
      select coalesce(sum(value), 0) as wert from stock_valuation_layers where layer_type = 'landed_cost'`
    assert.equal(Number(wert), 161.25, 'die Wertschichten tragen genau die verteilten Kosten')
  })

  test('Schätzung → Rechnung: Storno + Neubuchung, Rundungsrest auf den letzten Eingang', async () => {
    await aktion('einkauf.sendung_kosten_erfassen', ids.s, { art: 'fracht', betrag: 333.33, partner_id: ids.kn })
    await aktion('einkauf.sendung_verteilen', ids.s)
    const fracht = (await verteilung(ids.s)).filter((v) => v.art === 'fracht')
    // 333,33 × 5/30 = 55,555 → 55,56; × 20/30 = 222,22; Rest 55,55 (nicht 55,56 — sonst wären es 333,34).
    assert.deepEqual(fracht.map((f) => [f.betrag, f.schaetzung]), [[55.56, false], [222.22, false], [55.55, false]])
    assert.equal(Math.round(fracht.reduce((s, f) => s + f.betrag, 0) * 100) / 100, 333.33)

    const storniert = await h.sql<{ n: number }[]>`
      select count(*)::int as n from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
      where k.sendung_id = ${ids.s} and k.art = 'fracht' and k.schaetzung and l.state = 'cancel'`
    assert.equal(Number(storniert[0].n), 3, 'die Landed Costs der Schätzung sind storniert')
    const [korr] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
      where k.sendung_id = ${ids.s} and k.art = 'fracht' and not k.schaetzung and l.corrects_id is not null`
    assert.equal(Number(korr.n), 3, 'die neuen zeigen per corrects_id auf die Schätzung')
    // Netto auf den Wertschichten: genau die Differenz.
    const [{ netto }] = await h.sql<{ netto: number }[]>`
      select coalesce(sum(value), 0) as netto from stock_valuation_layers where layer_type in ('landed_cost', 'revaluation')`
    assert.equal(Number(netto), 344.58, '333,33 Fracht + 11,25 Zoll-Schätzung')
  })

  test('Zollbescheid: Zoll ersetzt die Schätzung, EUSt getrennt — abrechnen verteilt den Rest', async () => {
    await assert.rejects(aktion('einkauf.sendung_abrechnen', ids.s), /Noch geschätzt: Zoll/)
    const fd = new FormData()
    fd.set('zeilen', 'oops\n8473 30 20; 1.200,00')
    await assert.rejects(aktionAusfuehrenGeprueft('einkauf.sendung_zoll_erfassen', { recordId: ids.s, formData: fd }, ADMIN), /„oops"/)

    await aktion('einkauf.sendung_zoll_erfassen', ids.s, {
      zeilen: [
        { hs_code: '85340090', zollwert_eur: 800, zoll_eur: 0, eust_eur: 152 },
        { hs_code: '84733020', zollwert_eur: 400, zoll_eur: 100, eust_eur: 76 },
      ],
    })
    const r = await aktion('einkauf.sendung_abrechnen', ids.s)
    assert.match(r.text ?? '', /abgerechnet/)
    const zoll = (await verteilung(ids.s)).filter((v) => v.art === 'zoll')
    assert.deepEqual(zoll.map((z) => z.betrag), [33.33, 33.33, 33.34], 'gleiche Warenwerte: Rundungsrest auf den letzten')

    const [summen] = await h.sql<{ lc: number; eust_lc: number; eust: number }[]>`
      select (select coalesce(sum(l.amount), 0) from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
              where k.sendung_id = ${ids.s} and l.state = 'posted') as lc,
             (select count(*) from landed_costs l join sendung_kosten k on k.id = l.sendung_kosten_id
              where k.sendung_id = ${ids.s} and k.art = 'eust') as eust_lc,
             (select sum(betrag) from sendung_kosten where sendung_id = ${ids.s} and art = 'eust' and storniert_am is null) as eust`
    assert.equal(Number(summen.lc), 433.33, 'Summe der Verteilung = Fracht + Zoll')
    assert.equal(Number(summen.eust_lc), 0, 'die EUSt ist nie in den Landed Costs')
    assert.equal(Number(summen.eust), 228)
    const [{ netto }] = await h.sql<{ netto: number }[]>`
      select coalesce(sum(value), 0) as netto from stock_valuation_layers where layer_type in ('landed_cost', 'revaluation')`
    assert.equal(Number(netto), 433.33)
    const [s] = await h.sql<{ status: string }[]>`select status::text as status from eingangs_sendungen where id = ${ids.s}`
    assert.equal(s.status, 'abgerechnet')
    assert.deepEqual(
      (await h.sql<{ code: string }[]>`select code from prozess_naechste_schritte('eingangs_sendung', ${ids.s})`).map((z) => z.code),
      [],
    )
  })

  test('Pflichtdokumente der Sendung und Endrechnung ab Wareneingang', async () => {
    // Spediteursrechnung (Frist 14 Tage) und Zollbescheid (7 Tage) ab Ankunft — Ankunft zurückdatieren.
    await h.sql`update eingangs_sendungen set angekommen_am = current_date - 15 where id = ${ids.s}`
    assert.deepEqual(await fehlend('eingangs_sendung', ids.s), ['rechnung', 'zollbescheid'])
    await dokument('zollbescheid', 'eingangs_sendung', ids.s)
    assert.deepEqual(await fehlend('eingangs_sendung', ids.s), ['rechnung'])
    const n = await aktion('einkauf.pflichtdokumente_nachfragen', undefined, { modell: 'eingangs_sendung', record_id: ids.s })
    const [e] = await h.sql<{ partner_id: string; sprache: string; betreff: string; text_de: string }[]>`
      select partner_id, sprache, betreff, text_de from mail_entwuerfe where id = ${n.recordId!}`
    assert.deepEqual({ p: e.partner_id, s: e.sprache }, { p: ids.kn, s: 'de' })
    assert.ok(e.betreff.includes(ids.sNr) && e.betreff.includes('KNSZXHAM0042'))
    assert.match(e.text_de, /- Frachtrechnung \(Spediteur\)/)

    // Endrechnung: Frist 7 Tage ab Eingang.
    assert.ok(!(await fehlend('purchase_order', ids.b1)).includes('rechnung'), 'innerhalb der Frist noch nicht offen')
    await h.sql`update stock_pickings set date_done = now() - interval '8 days' where id = ${(await eingangVon(ids.b1)).id}`
    assert.ok((await fehlend('purchase_order', ids.b1)).includes('rechnung'))
  })

  test('DATEV-Vorbereitung: gebuchte Rechnung ohne Datei → fehlt Beleg, mit Datei → bereit, übergeben', async () => {
    const r = await aktion('einkauf.rechnung_erstellen', ids.b1)
    ids.bill = r.recordId!
    await h.sql`update vendor_bills set bill_date = current_date where id = ${ids.bill}`
    const status = async () =>
      (await h.sql<{ status: string }[]>`select status from einkauf_datev_vorbereitung where vendor_bill_id = ${ids.bill}`).map((s) => s.status)
    assert.deepEqual(await status(), [], 'Entwürfe gehen nicht an DATEV')
    await aktion('einkauf.rechnung_buchen', ids.bill)
    assert.deepEqual(await status(), ['fehlt_beleg'])
    const dok = await dokument('rechnung', 'vendor_bill', ids.bill, ids.b)
    assert.deepEqual(await status(), ['bereit'])
    // Die Endrechnung an der Rechnung erfüllt auch die Pflicht der Bestellung.
    assert.ok(!(await fehlend('purchase_order', ids.b1)).includes('rechnung'))
    await h.sql`update dokumente set datev_uebergeben_am = now() where id = ${dok}`
    assert.deepEqual(await status(), ['uebergeben'])
    // Nicht verdrahtet: kein Job, keine Aktion sendet an DATEV.
    const [{ jobs }] = await h.sql<{ jobs: number }[]>`select count(*)::int as jobs from integration_jobs where kind ilike '%datev%'`
    assert.equal(Number(jobs), 0)
  })

  test('lernende Schätzwerte: Vorschlag aus der abgerechneten Sendung, übernehmen', async () => {
    const v = await h.sql<{ art: string; schluessel: string; ist_wert: number; soll_wert: number | null; sendungen: number }[]>`
      select art, schluessel, ist_wert, soll_wert, sendungen from einkauf_einstand_vorschlaege order by art, schluessel`
    assert.deepEqual(v.map((x) => ({ ...x })), [
      { art: 'fracht', schluessel: 'see', ist_wert: 11.1110, soll_wert: 1.5, sendungen: 1 },
      { art: 'zoll', schluessel: '8473', ist_wert: 25, soll_wert: 2.5, sendungen: 1 },
    ])
    await aktion('einkauf.einstand_vorschlag_uebernehmen', undefined, { art: 'fracht', schluessel: 'see' })
    const [f] = await h.sql<{ eur_je_kg: number; notiz: string }[]>`select eur_je_kg, notiz from frachtsaetze where modus = 'see'`
    assert.equal(Number(f.eur_je_kg), 11.111)
    assert.match(f.notiz, /Gelernt aus Sendungen/)
    const rest = await h.sql<{ art: string }[]>`select art from einkauf_einstand_vorschlaege`
    assert.deepEqual(rest.map((x) => x.art), ['zoll'], 'der übernommene Vorschlag verschwindet')
    await assert.rejects(aktion('einkauf.einstand_vorschlag_uebernehmen', undefined, { art: 'fracht', schluessel: 'luft' }), /keinen Vorschlag/)
  })
})

describe('Kosten stornieren, Storno der Sendung, Express', () => {
  test('Kostenposition stornieren nimmt die Landed Costs zurück; Sendung storniert sich nur ohne Buchung', async () => {
    const po = await bestellung(ids.b, 'ES-CAP', 10, 2)
    const r = await aktion('einkauf.sendung_anlegen', undefined, { modus: 'luft', bestellungen: [po.number] })
    const s = r.recordId!
    await aktion('einkauf.sendung_verschiffen', s)
    await aktion('einkauf.sendung_ankommen', s)
    await h.sql`select picking_validate(${(await eingangVon(po.id)).id}, '{}'::jsonb, false)`
    await aktion('einkauf.sendung_kosten_erfassen', s, { art: 'versicherung', betrag: 12.5 })
    await aktion('einkauf.sendung_verteilen', s)
    assert.deepEqual((await verteilung(s)).map((v) => v.betrag), [12.5])
    const [k] = await h.sql<{ id: string }[]>`select id from sendung_kosten where sendung_id = ${s}`
    await aktion('einkauf.sendung_kosten_entfernen', s, { kosten_id: k.id })
    assert.deepEqual(await verteilung(s), [])
    const r2 = await aktion('einkauf.sendung_verteilen', s)
    assert.match(r2.text ?? '', /Nichts zu verteilen/)

    // Storno nur vor dem Eingang: neue Sendung, verschifft, dann storniert → verschifft_am zurück.
    const po2 = await bestellung(ids.a, 'ES-PCB', 10, 4)
    const s2 = (await aktion('einkauf.sendung_anlegen', undefined, { bestellungen: [po2.id] })).recordId!
    await aktion('einkauf.sendung_verschiffen', s2, { verschifft_am: heute() })
    const [vorher] = await h.sql<{ v: string | null }[]>`select verschifft_am::text as v from purchase_orders where id = ${po2.id}`
    assert.equal(vorher.v, heute())
    await aktion('einkauf.sendung_stornieren', s2, { grund: 'Container umgebucht' })
    const [nachher] = await h.sql<{ v: string | null }[]>`select verschifft_am::text as v from purchase_orders where id = ${po2.id}`
    assert.equal(nachher.v, null, 'die Verschiffung der stornierten Sendung ist zurückgenommen')
    assert.equal((await eingangVon(po2.id)).eingangs_sendung_id, null)
    ids.offenePo = po2.id
  })
})

describe('Cockpit und tägliche Zusammenfassung', () => {
  test('das Cockpit liefert die erwarteten Kategorien, je Einkäufer gefiltert', async () => {
    // Überfällige ETA: offene Bestellung, Termin verstrichen.
    await h.sql`update purchase_orders set eta_confirmed = current_date - 3, user_id = ${ids.tino} where id = ${ids.offenePo}`
    // Laufende Sendung, nicht zugeordnete Mail, überfällige Wiedervorlage.
    const po = await bestellung(ids.b, 'ES-CAP', 5, 2)
    await aktion('einkauf.sendung_anlegen', undefined, { bestellungen: [po.id], zustaendig_id: ids.tino, eta: inTagen(20) })
    await h.sql`insert into mail_threads (betreff, status, letzte_richtung, letzte_am) values ('Re: quotation', 'offen', 'eingang', now())`
    await h.sql`insert into wiedervorlagen (modell, record_id, faellig_am, grund, zustaendig_id, erstellt_von)
                values ('purchase_order', ${ids.a1}, current_date - 1, 'Preis für Q1 nachverhandeln', ${ids.tino}, 'test')`

    const alle = await cockpitLaden(h.sql, { finanzen: true })
    const kategorien = new Set(alle.map((e) => e.kategorie))
    for (const k of ['ueberfaellig', 'eta_ueberfaellig', 'dokumente', 'rechnungen', 'raten', 'unzugeordnet', 'sendungen']) {
      assert.ok(kategorien.has(k as never), `Kategorie ${k} fehlt: ${[...kategorien].join(', ')}`)
    }
    assert.ok(alle.every((e) => e.link.startsWith('/einkauf/')), 'jeder Eintrag führt zu seinem Beleg')
    const pi = alle.find((e) => e.kategorie === 'dokumente' && e.record_id === ids.a1 && /Proforma Invoice/.test(e.titel))
    assert.ok(pi, 'die fehlende PI von A1 steht unter „Fehlende Dokumente"')
    assert.equal(pi.link, `/einkauf/${ids.a1}`)

    // Ohne Finanzrecht keine Raten.
    assert.ok(!(await cockpitLaden(h.sql, { finanzen: false })).some((e) => e.kategorie === 'raten'))
    // Tinos Sicht: nur seins plus die nicht zugeordneten Mails.
    const meine = await cockpitLaden(h.sql, { zustaendigId: ids.tino, finanzen: true })
    assert.ok(meine.length > 0 && meine.length < alle.length)
    assert.ok(meine.every((e) => e.zustaendig_id === ids.tino || e.kategorie === 'unzugeordnet'))
    assert.ok(meine.some((e) => e.kategorie === 'eta_ueberfaellig' && e.record_id === ids.offenePo))
    assert.ok(meine.some((e) => e.kategorie === 'raten'), 'A1 (Tino) hat die fällige Rate')
  })

  test('Job einkauf_digest: eine Nachricht in den Telegram-Kanal, gegliedert nach Einkäufer', async () => {
    const tag = heute()
    await h.sql`select enqueue_job('einkauf_digest', ${h.sql.json({ datum: tag })}, ${`einkauf-digest:${tag}`})`
    const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
    await runDueJobs(20)
    const [job] = await h.sql<{ status: string; last_result: string }[]>`
      select status, last_result from integration_jobs where kind = 'einkauf_digest' order by created_at desc limit 1`
    assert.equal(job.status, 'done', job.last_result)
    const [b] = await h.sql<{ art: string; text: string; status: string }[]>`
      select art, text, status from benachrichtigungen where schluessel = ${`einkauf:${tag}`}`
    assert.equal(b.art, 'einkauf')
    assert.equal(b.status, 'offen')
    const tino = b.text.indexOf('<b>Tino</b>')
    const ohne = b.text.indexOf('<b>Ohne Zuständigen</b>')
    assert.ok(tino > 0 && ohne > tino, 'je Einkäufer, „Ohne Zuständigen" zuletzt')
    assert.match(b.text, /Überfällige ETA \(1\)/)
    assert.match(b.text, /Nicht zugeordnete Mails: 1/)
    // Zweiter Lauf am selben Tag: kein zweiter Eintrag.
    await h.sql`select enqueue_job('einkauf_digest', ${h.sql.json({ datum: tag })}, ${`einkauf-digest:${tag}`})`
    await runDueJobs(20)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from benachrichtigungen where art = 'einkauf'`
    assert.equal(Number(n), 1)
  })
})
