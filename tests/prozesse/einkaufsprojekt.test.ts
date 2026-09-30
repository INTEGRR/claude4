/**
 * Einkauf, Stufe 3 (Migration 0097) gegen die echte Datenbank mit Gmail-/
 * Drive-Attrappe und EZB_FAKE: Einstand je Stück (Staffelwahl, EZB-Kurs,
 * Werkzeug-Umlage nach Warenwert, Fracht mit Mindestbetrag nach Gewicht,
 * Zoll nach längstem HS-Präfix, D-Klausel/DDP ohne Fracht und Zoll),
 * Vergleich mit Zielpreis, fehlender Kurs statt stiller 1, Anfragen als
 * Entwürfe in Lieferantensprache mit EP-Nummer, Sammelfreigabe alles oder
 * nichts, Senden hängt Thread und Anfrage ans Projekt, Antworten mit
 * EP-Nummer finden ihr Projekt, Abbruch nur ohne offene Bestellung,
 * EZB-Abruf überschreibt keine Handkurse.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { angebotSumme, bestesAngebot, type EinstandZeile } from '../../src/modules/einkauf/einkaufsprojekt.ts'

const DATENBANK = 'erp_einkaufsprojekt_check'
const ADMIN = { name: 'einkauf-admin', role: 'admin' as const }
const POSTFACH = 'einkauf@anvil.example'

let h: Harness
const ids: Record<string, string> = {}
type Fake = typeof import('../../src/modules/google/google-fake-gmail.ts')
let fake: Fake

before(async () => {
  process.env.GOOGLE_FAKE = '1'
  process.env.KI_FAKE = '1'
  process.env.EZB_FAKE = '1'
  process.env.EINKAUF_POSTFACH = POSTFACH
  h = await harnessStart(DATENBANK)
  fake = await import('../../src/modules/google/google-fake-gmail.ts')
  fake.fakeGmailLeeren()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

async function jobs() {
  const { runDueJobs } = await import('../../src/modules/integrationen/jobs.ts')
  for (let i = 0; i < 10; i++) if ((await runDueJobs(50)).ran === 0) break
}

async function einstand(angebotId: string) {
  const zeilen = await h.sql<(EinstandZeile & Record<string, unknown>)[]>`
    select position_id, bezeichnung, menge::float as menge, staffel_ab::float as staffel_ab, ware_eur::float as ware_eur,
           umlage_eur::float as umlage_eur, fracht_eur::float as fracht_eur, zoll_eur::float as zoll_eur,
           einstand_eur::float as einstand_eur, zielpreis_eur::float as zielpreis_eur, hinweise
    from einstand_schaetzen(${angebotId})`
  return zeilen.map((z) => ({ ...z }))
}

describe('Einkaufsprojekt: Angebotsvergleich und Anfragen', () => {
  test('Vorbereitung: Lieferanten, Kurse, Zolltarife', async () => {
    const lieferant = async (name: string, email: string | null, sprache: string, land: string) =>
      (
        await h.sql<{ id: string }[]>`
          insert into partners (name, is_vendor, is_company, email, sprache, country_code)
          values (${name}, true, true, ${email}, ${sprache}, ${land}) returning id`
      )[0].id
    ids.cn = await lieferant('Dongguan Keycap Co.', 'sales@keycap.cn', 'zh', 'CN')
    ids.us = await lieferant('Keycap Supply Inc.', 'orders@keycap.us', 'en', 'US')
    ids.de = await lieferant('Foam GmbH', null, 'de', 'DE')
    await h.sql`delete from exchange_rates where currency in ('USD', 'CNY', 'GBP')`
    await h.sql`insert into exchange_rates (currency, rate, valid_from, source)
                values ('USD', 0.92, current_date - 1, 'manuell'), ('CNY', 0.128, current_date - 1, 'manuell')`
    await aktion('einkauf.zolltarif_setzen', undefined, { hs_praefix: '8473', satz_pct: 0, bezeichnung: 'Teile für Tastaturen' })
    await aktion('einkauf.zolltarif_setzen', undefined, { hs_praefix: '39.26', satz_pct: 6.5, bezeichnung: 'Kunststoffwaren' })
    await aktion('einkauf.frachtsatz_setzen', undefined, { modus: 'see', eur_je_kg: 1.5, mindestbetrag_eur: 150 })
    const [z] = await h.sql<{ hs_praefix: string }[]>`select hs_praefix from zolltarife where satz_pct = 6.5`
    assert.equal(z.hs_praefix, '3926', 'HS-Präfix ohne Punkte gespeichert')

    const r = await aktion('einkauf.projekt_anlegen', undefined, {
      titel: 'Keycap-Set PBT',
      art: 'neuteil',
      zieltermin: '2026-12-01',
      positionen: [
        { bezeichnung: 'Keycap-Set PBT Dye-Sub', menge: 500, zielpreis_eur: 9, gewicht_g: 180, hs_code: '8473.30', spezifikation: 'Cherry-Profil\n129 Tasten' },
        { bezeichnung: 'Keycap-Puller', menge: 500, zielpreis_eur: 0.5, gewicht_g: 12, hs_code: '3926' },
      ],
    })
    ids.projekt = r.recordId!
    const pos = await h.sql<{ id: string }[]>`select id from einkaufsprojekt_positionen where projekt_id = ${ids.projekt} order by sequence`
    ids.set = pos[0].id
    ids.puller = pos[1].id
    const [ep] = await h.sql<{ nummer: string; status: string }[]>`select nummer, status::text from einkaufsprojekte where id = ${ids.projekt}`
    assert.match(ep.nummer, /^EP\/\d{5}$/)
    assert.equal(ep.status, 'bedarf')
    ids.nummer = ep.nummer
  })

  test('Anfragen: Entwürfe in Lieferantensprache mit EP-Nummer, Positionen, ohne Zielpreis', async () => {
    const r = await aktion('einkauf.anfragen_senden', ids.projekt, { partner_ids: [ids.cn, ids.us, ids.de], frist: '2026-10-15' })
    assert.match(r.text!, /3 Anfrage/)
    assert.match(r.text!, /Ohne Mailadresse: Foam GmbH/)
    const entwuerfe = await h.sql<{ partner_id: string; sprache: string; betreff: string; text_de: string; text_ziel: string | null; an: string[]; antwort_erwartet_bis: string }[]>`
      select e.partner_id, e.sprache, e.betreff, e.text_de, e.text_ziel, e.an, e.antwort_erwartet_bis::text
      from lieferantenanfragen a join mail_entwuerfe e on e.id = a.entwurf_id
      where a.projekt_id = ${ids.projekt}`
    const cn = entwuerfe.find((e) => e.partner_id === ids.cn)!
    assert.equal(cn.sprache, 'zh')
    assert.equal(cn.betreff, `询价 ${ids.nummer} – Keycap-Set PBT`)
    assert.match(cn.text_ziel!, new RegExp(`我方参考编号：${ids.nummer.replace('/', '\\/')}`))
    assert.match(cn.text_ziel!, /1\. Keycap-Set PBT Dye-Sub \(Cherry-Profil; 129 Tasten\) – 数量：500 件/)
    assert.match(cn.text_ziel!, /期望交期：2026-12-01/)
    assert.doesNotMatch(cn.text_ziel!, /- 产品：/, 'leere Stichpunkte der Vorlage ersetzt')
    assert.match(cn.text_de, /Gewünschter Liefertermin: 01\.12\.2026/, 'Deutsch zum Mitlesen')
    assert.doesNotMatch(cn.text_de + cn.text_ziel, /Zielpreis|\b9[,.]0/, 'der Zielpreis geht nicht hinaus')
    assert.equal(cn.antwort_erwartet_bis, '2026-10-15')
    const us = entwuerfe.find((e) => e.partner_id === ids.us)!
    assert.equal(us.betreff, `Request for quotation ${ids.nummer} – Keycap-Set PBT`)
    assert.match(us.text_ziel!, /2\. Keycap-Puller – Quantity: 500 pcs/)

    // Ein zweiter Lauf legt nichts doppelt an.
    const zweit = await aktion('einkauf.anfragen_senden', ids.projekt, { partner_ids: [ids.cn] })
    assert.match(zweit.text!, /Übersprungen: Dongguan Keycap Co\. \(Entwurf liegt schon\)/)
  })

  test('Sammelfreigabe: alles oder nichts', async () => {
    await assert.rejects(aktion('einkauf.anfragen_freigeben', ids.projekt), /Nichts gesendet.*Foam GmbH: Bitte mindestens einen Empfänger/)
    const [{ offen }] = await h.sql<{ offen: number }[]>`
      select count(*)::int as offen from mail_entwuerfe where einkaufsprojekt_id = ${ids.projekt} and status = 'entwurf'`
    assert.equal(offen, 3, 'kein Entwurf wurde freigegeben')

    // Foam GmbH bekommt eine Adresse im Entwurf, dann geht alles hinaus.
    const [foam] = await h.sql<{ id: string }[]>`
      select entwurf_id as id from lieferantenanfragen where projekt_id = ${ids.projekt} and partner_id = ${ids.de}`
    await aktion('einkauf.mail_entwurf_aendern', foam.id, { an: ['info@foam.de'] })
    const r = await aktion('einkauf.anfragen_freigeben', ids.projekt)
    assert.match(r.text!, /3 Anfrage\(n\) freigegeben/)
    await jobs()

    const anfragen = await h.sql<{ status: string; thread_id: string | null; angefragt_am: string | null }[]>`
      select status, thread_id, angefragt_am::text from lieferantenanfragen where projekt_id = ${ids.projekt}`
    assert.ok(anfragen.every((a) => a.status === 'angefragt' && a.thread_id && a.angefragt_am))
    const [{ threads }] = await h.sql<{ threads: number }[]>`
      select count(*)::int as threads from mail_threads where einkaufsprojekt_id = ${ids.projekt}`
    assert.equal(threads, 3, 'jeder Thread hängt am Projekt')
    const [ep] = await h.sql<{ status: string }[]>`select status::text from einkaufsprojekte where id = ${ids.projekt}`
    assert.equal(ep.status, 'angefragt')
    const zh = fake.fakeGesendet().find((m) => m.raw.includes('sales@keycap.cn'))
    assert.ok(zh, 'Anfrage an den chinesischen Lieferanten gesendet')
  })

  test('Antwort mit EP-Nummer in neuem Thread findet ihr Projekt', async () => {
    fake.fakeMailEinliefern({
      threadId: 'g-antwort-neu',
      von: 'Lily <lily@other-keycap.cn>',
      betreff: `Re: 询价 ${ids.nummer} – Keycap-Set PBT`,
      text: 'Please find our quotation attached.',
    })
    const { postfachAbgleichen } = await import('../../src/modules/einkauf/postfach-abgleich.ts')
    await postfachAbgleichen()
    const [t] = await h.sql<{ einkaufsprojekt_id: string | null; zugeordnet_durch: string | null }[]>`
      select einkaufsprojekt_id, zugeordnet_durch::text from mail_threads where gmail_thread_id = 'g-antwort-neu'`
    assert.deepEqual(t, { einkaufsprojekt_id: ids.projekt, zugeordnet_durch: 'regel' })
  })

  test('Einstand: Staffel, Kurs, Werkzeug-Umlage, Fracht mit Mindestbetrag, Zoll nach HS-Präfix', async () => {
    const cn = await aktion('einkauf.angebot_erfassen', ids.projekt, {
      partner_id: ids.cn,
      waehrung: 'CNY',
      incoterm_code: 'FOB',
      werkzeugkosten: 3000,
      fracht_modus: 'see',
      anzahlung_pct: 30,
      staffeln: [
        { position_id: ids.set, ab_menge: 300, preis: 52 },
        { position_id: ids.set, ab_menge: 1000, preis: 45 },
        { position_id: ids.puller, ab_menge: 500, preis: 1.2 },
      ],
    })
    ids.angebotCn = String(cn.daten!.angebot_id)
    const zeilen = await einstand(ids.angebotCn)
    const set = zeilen.find((z) => z.position_id === ids.set)!
    const puller = zeilen.find((z) => z.position_id === ids.puller)!
    // Staffel 300 gilt bei 500 Stück (größte ≤ Menge): 52 CNY × 0,128 = 6,656 €.
    assert.equal(set.staffel_ab, 300)
    assert.equal(set.ware_eur, 6.656)
    // Werkzeug 3000 CNY = 384 € nach Warenwert: 384 × 3328 / 3404,8 / 500.
    assert.equal(set.umlage_eur, 0.7507)
    assert.equal(puller.umlage_eur, 0.0173)
    // 96 kg × 1,50 € = 144 € < Mindestbetrag 150 € → nach Gewicht verteilt.
    assert.equal(set.fracht_eur, 0.2813)
    assert.equal(puller.fracht_eur, 0.0188)
    // 8473.30 → Präfix 8473 (0 %); 3926 → 6,5 % auf Ware + Fracht.
    assert.equal(set.zoll_eur, 0)
    assert.equal(puller.zoll_eur, 0.0112)
    assert.equal(set.einstand_eur, 7.6879)
    assert.equal(puller.einstand_eur, 0.2009)
    assert.deepEqual([set.hinweise, puller.hinweise], [[], []])
    assert.match(cn.text!, /Einstand 3\.944,40\s€ · -17 % zum Ziel/)

    const us = await aktion('einkauf.angebot_erfassen', ids.projekt, {
      partner_id: ids.us,
      waehrung: 'USD',
      incoterm_code: 'DDP',
      moq: 1000,
      staffeln: [
        { position_id: ids.set, ab_menge: 100, preis: 10.5 },
        { position_id: ids.puller, ab_menge: 100, preis: 0.4 },
      ],
    })
    ids.angebotUs = String(us.daten!.angebot_id)
    const usZeilen = await einstand(ids.angebotUs)
    const usSet = usZeilen.find((z) => z.position_id === ids.set)!
    // DDP: keine Fracht, kein Zoll; 10,50 USD × 0,92.
    assert.deepEqual([usSet.ware_eur, usSet.fracht_eur, usSet.zoll_eur, usSet.einstand_eur], [9.66, 0, 0, 9.66])
    assert.deepEqual(usSet.hinweise, ['unter_moq'])

    const summen = [
      { id: ids.angebotCn, verworfen: false, summe: angebotSumme(zeilen) },
      { id: ids.angebotUs, verworfen: false, summe: angebotSumme(usZeilen) },
    ]
    assert.equal(summen[1].summe.gesamt, 5014)
    assert.equal(bestesAngebot(summen), ids.angebotCn, 'trotz Werkzeug und Fracht ist China günstiger')
    const [a] = await h.sql<{ status: string }[]>`
      select status from lieferantenanfragen where projekt_id = ${ids.projekt} and partner_id = ${ids.cn}`
    assert.equal(a.status, 'angebot')
  })

  test('Ohne Kurs bleibt der Einstand leer statt 1 — und entscheiden braucht einen Preis je Position', async () => {
    const gbp = await aktion('einkauf.angebot_erfassen', ids.projekt, {
      partner_id: ids.de,
      waehrung: 'GBP',
      staffeln: [{ position_id: ids.set, ab_menge: 1, preis: 8 }],
    })
    const zeilen = await einstand(String(gbp.daten!.angebot_id))
    const set = zeilen.find((z) => z.position_id === ids.set)!
    assert.equal(set.einstand_eur, null)
    assert.ok(set.hinweise.includes('kein_kurs'))
    assert.ok(zeilen.find((z) => z.position_id === ids.puller)!.hinweise.includes('kein_preis'))
    assert.equal(angebotSumme(zeilen).gesamt, null)
    await assert.rejects(
      aktion('einkauf.projekt_entscheiden', ids.projekt, { angebot_id: gbp.daten!.angebot_id }),
      /keinen Preis für: Keycap-Puller/,
    )
  })

  test('Entscheiden, bestellen; Abbruch nur ohne offene Bestellung; Abschluss beim Wareneingang', async () => {
    await aktion('einkauf.projekt_entscheiden', ids.projekt, { angebot_id: ids.angebotCn, begruendung: 'günstigster Einstand' })
    await assert.rejects(aktion('einkauf.angebot_verwerfen', undefined, { angebot_id: ids.angebotCn }), /gewählte Angebot/)
    const r = await aktion('einkauf.projekt_bestellen', ids.projekt)
    assert.match(r.text!, /neue Artikel: Keycap-Set PBT Dye-Sub, Keycap-Puller/)
    const [po] = await h.sql<{ id: string; currency: string; zeilen: number }[]>`
      select po.id, po.currency, (select count(*)::int from purchase_order_lines l where l.order_id = po.id) as zeilen
      from purchase_orders po where po.einkaufsprojekt_id = ${ids.projekt}`
    assert.deepEqual({ currency: po.currency, zeilen: po.zeilen }, { currency: 'CNY', zeilen: 3 })
    const [werkzeug] = await h.sql<{ price_unit: number; typ: string }[]>`
      select l.price_unit::float as price_unit, pt.type::text as typ
      from purchase_order_lines l join product_variants pv on pv.id = l.variant_id
      join product_templates pt on pt.id = pv.template_id
      where l.order_id = ${po.id} and l.name like 'Werkzeugkosten%'`
    assert.deepEqual(werkzeug, { price_unit: 3000, typ: 'service' })
    const [artikel] = await h.sql<{ weight_g: number; hs_code: string }[]>`
      select pt.weight_g, pt.hs_code from einkaufsprojekt_positionen p
      join product_variants pv on pv.id = p.variant_id join product_templates pt on pt.id = pv.template_id
      where p.id = ${ids.set}`
    assert.deepEqual(artikel, { weight_g: 180, hs_code: '8473.30' })

    await assert.rejects(aktion('einkauf.projekt_abbrechen', ids.projekt, { grund: 'test' }), /Erst die Bestellung\(en\) stornieren/)
    await assert.rejects(aktion('einkauf.projekt_position_entfernen', ids.projekt, { position_id: ids.puller }), /nur bis zur Bestellung/)

    await h.sql`select confirm_purchase_order(${po.id}, 'test')`
    let [ep] = await h.sql<{ status: string }[]>`select status::text from einkaufsprojekte where id = ${ids.projekt}`
    assert.equal(ep.status, 'bestellt', 'bestätigt, aber noch nicht geliefert')
    const [eingang] = await h.sql<{ id: string }[]>`
      select id from stock_pickings where origin_model = 'purchase_order' and origin_id = ${po.id} and state not in ('done', 'cancel')`
    await h.sql`select picking_validate(${eingang.id}, '{}'::jsonb, false)`
    ;[ep] = await h.sql<{ status: string }[]>`select status::text from einkaufsprojekte where id = ${ids.projekt}`
    assert.equal(ep.status, 'abgeschlossen')
  })

  test('EZB-Kurse: 1/Kurs mit Quelle ezb, Handkurse bleiben; Kurs ohne Datum gilt ab heute', async () => {
    await h.sql`insert into exchange_rates (currency, rate, valid_from, source) values ('CHF', 1.05, current_date, 'manuell')`
    const r = await aktion('einkauf.ezb_kurse_abrufen', undefined)
    assert.match(r.text!, /USD/)
    assert.match(r.text!, /CHF von Hand gepflegt/)
    const kurse = await h.sql<{ currency: string; rate: number; source: string }[]>`
      select currency, rate::float as rate, source from exchange_rates where valid_from = current_date order by currency`
    assert.deepEqual(kurse.map((k) => ({ ...k })), [
      { currency: 'CHF', rate: 1.05, source: 'manuell' },
      { currency: 'CNY', rate: 0.12820513, source: 'ezb' },
      { currency: 'GBP', rate: 1.19047619, source: 'ezb' },
      { currency: 'USD', rate: 0.92592593, source: 'ezb' },
    ])

    await aktion('einkauf.wechselkurs_erfassen', undefined, { currency: 'USD', rate: 0.9 })
    const [usd] = await h.sql<{ rate: number; source: string }[]>`
      select rate::float as rate, source from exchange_rates where currency = 'USD' and valid_from = current_date`
    assert.deepEqual(usd, { rate: 0.9, source: 'manuell' })
  })
})
