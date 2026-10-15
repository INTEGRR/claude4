/**
 * Abnahmetest, Teil 2 — der Live-Lauf (Entscheidungslog 2026-10-15).
 *
 * Spielt das Drei-Monats-Szenario (tests/abnahme/szenario.ts) gegen eine
 * frische Datenbank nach: jeder Schritt ist ein Aktionsaufruf über den
 * Torwächter (derselbe Weg wie Knöpfe, KI-Chat und /api/aktion), Shop-
 * Bestellungen kommen als Webhook-Ereignisse über die Shopify-Attrappe,
 * Labels über die DHL-Attrappe, Rückmeldungen über die Outbox. Am Ende
 * jedes Monats wird der Ist-Stand (tests/abnahme/ist.ts) Feld für Feld
 * gegen den vorher gerechneten Soll-Stand (modell.ts) gehalten — Bestand,
 * Bewertung, Belege, Umsätze, Zahlungen, Fälligkeiten, Verträge, Darlehen,
 * Steuern und die an Shopify gemeldeten Mengen und Fulfillments.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { spur } from './spur.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'
import { runDueJobs } from '../../src/modules/integrationen/jobs.ts'
import { type Erwartung, simulieren } from '../abnahme/modell.ts'
import { type Kennungen, istStandLesen } from '../abnahme/ist.ts'
import { abweichungenText, vergleichen } from '../abnahme/vergleich.ts'
import {
  ARBEITSGANG,
  BANKKONTO,
  PARTNER,
  PRODUKTE,
  SHOP_VERSAND_BRUTTO,
  STUECKLISTE,
  type Schritt,
  type Sku,
  type Szenario,
  szenarioErzeugen,
} from '../abnahme/szenario.ts'

const DATENBANK = 'erp_abnahme_check'
const ADMIN = { name: 'abnahme', role: 'admin' as const }

let h: Harness
let szenario: Szenario
let erwartung: Erwartung

/** Kennungen, die der Lauf unterwegs einsammelt (Belege nach Szenario-ID). */
const k = {
  varianten: {} as Record<Sku, string>,
  templates: {} as Record<Sku, string>,
  bankkonto: '',
  bestellungen: new Map<string, string>(),
  auftraege: new Map<string, { id: string; gid: string | null }>(),
  rechnungen: new Map<string, string>(),
  vertraege: new Map<string, string>(),
  darlehen: new Map<string, string>(),
  steuern: new Map<string, string>(),
  shopNummer: 880_100,
}

const aktion = (name: string, recordId: string | undefined, parameter: Record<string, unknown> = {}) =>
  aktionAusfuehrenGeprueft(name, { recordId, parameter }, ADMIN)

const sql = () => h.sql

/** Outbox leerarbeiten (Fulfillments, Bestandsmeldungen) — gedeckelt gegen Endlosschleifen. */
async function jobsLeeren(): Promise<void> {
  for (let runde = 0; runde < 50; runde++) {
    const r = await runDueJobs(20)
    if (r.ran === 0) return
  }
  throw new Error('Outbox wird nach 50 Runden nicht leer')
}

// --- Stammdaten über die Registry ------------------------------------------------

async function stammdatenAnlegen(): Promise<void> {
  await aktion('einstellungen.shopify_modus_setzen', undefined, { modus: 'schreiben' })

  const konto = await aktion('finanzen.bankkonto_anlegen', undefined, { name: BANKKONTO, waehrung: 'EUR' })
  k.bankkonto = konto.recordId!

  await aktion('kontakte.partner_anlegen', undefined, {
    name: PARTNER.lieferantEur, is_company: true, is_customer: false, is_vendor: true, country_code: 'DE',
    street: 'Industriestraße', house_number: '7', zip: '70173', city: 'Stuttgart',
  })
  await aktion('kontakte.partner_anlegen', undefined, {
    name: PARTNER.lieferantUsd, is_company: true, is_customer: false, is_vendor: true, country_code: 'US',
    street: 'Market St', house_number: '400', zip: '94102', city: 'San Francisco',
  })
  await aktion('kontakte.partner_anlegen', undefined, {
    name: PARTNER.kunde, is_company: true, is_customer: true, is_vendor: false, country_code: 'DE',
    street: 'Hafenstraße', house_number: '12', zip: '20457', city: 'Hamburg', email: 'einkauf@buero-nord.example',
  })

  for (const p of PRODUKTE) {
    const r = await aktion('produkte.produkt_anlegen', undefined, {
      name: p.name, sku: p.sku, verkaufspreis: p.preis, einstandspreis: p.kosten, gewicht_g: p.gewicht_g,
      verkaufbar: p.verkaufbar, einkaufbar: p.einkaufbar, route: p.route, attribute: [],
    })
    k.templates[p.sku] = r.recordId!
    const [v] = await sql()<{ id: string }[]>`
      select id from product_variants where template_id = ${r.recordId!} and active`
    k.varianten[p.sku] = v.id
    // Stammdaten-Verdrahtung, für die es keinen Knopf im Szenario braucht:
    // „auf Auftrag fertigen" und die Shopify-Verknüpfung (sonst der Produktimport).
    if (p.mto) await sql()`update product_templates set route_mto = true where id = ${r.recordId!}`
    if (p.shopify) {
      await sql()`update product_variants set shopify_variant_id = ${`gid://shopify/ProductVariant/${p.shopify}`} where id = ${v.id}`
    }
  }

  const platz = await aktion('fertigung.arbeitsplatz_anlegen', undefined, {
    code: ARBEITSGANG.arbeitsplatz, name: 'Montagetisch', art: 'fertigung', cost_per_hour: ARBEITSGANG.satz, capacity: 1, time_efficiency: 100,
  })
  const [wc] = await sql()<{ id: string }[]>`select id from work_centers where code = ${ARBEITSGANG.arbeitsplatz}`
  assert.ok(wc, `Arbeitsplatz angelegt (${platz.text ?? ''})`)
  const bom = await aktion('fertigung.stueckliste_anlegen', undefined, { template_id: k.templates[STUECKLISTE.produkt], qty: 1 })
  for (const c of STUECKLISTE.komponenten) {
    await aktion('fertigung.stueckliste_position_hinzufuegen', bom.recordId, {
      component_variant_id: k.varianten[c.sku], qty: c.menge, issue_method: 'backflush', ptav_ids: [],
    })
  }
  await aktion('fertigung.arbeitsgang_hinzufuegen', bom.recordId, {
    name: ARBEITSGANG.name, work_center_id: wc.id, duration_minutes: ARBEITSGANG.minuten, setup_minutes: 0,
  })
}

// --- Hilfen für Belege -----------------------------------------------------------

async function lieferung(auftragId: string): Promise<{ id: string; state: string }> {
  const [p] = await sql()<{ id: string; state: string }[]>`
    select p.id, p.state::text as state from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
    where p.origin_model = 'sales_order' and p.origin_id = ${auftragId}
    order by p.created_at desc limit 1`
  assert.ok(p, 'Lieferung zum Auftrag')
  return p
}

async function wareneingaenge(poId: string): Promise<{ id: string; state: string }[]> {
  return sql()<{ id: string; state: string }[]>`
    select p.id, p.state::text as state from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'receipt'
    where p.origin_model = 'purchase_order' and p.origin_id = ${poId}
    order by p.created_at`
}

async function shopBestellung(s: Extract<Schritt, { art: 'shop_bestellung' }>): Promise<void> {
  const { fakeOrderHinterlegen } = await import('../../src/modules/integrationen/shopify-fake.ts')
  const { processPendingWebhooks } = await import('../../src/modules/integrationen/import.ts')
  const nummer = ++k.shopNummer
  const gid = `gid://shopify/Order/${nummer}`
  const brutto = s.positionen.reduce((sum, p) => sum + p.menge * p.preis, 0) + SHOP_VERSAND_BRUTTO
  fakeOrderHinterlegen({
    id: gid, name: s.nr, createdAt: `${s.am}T10:00:00Z`, updatedAt: `${s.am}T10:00:00Z`,
    email: `kunde${nummer}@example.com`, tags: [], displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    cancelledAt: null, taxesIncluded: true, customer: null,
    totalPriceSet: { shopMoney: { amount: brutto.toFixed(2), currencyCode: 'EUR' } },
    shippingAddress: { name: `Shop-Kunde ${nummer}`, address1: 'Musterstraße 5', address2: null, zip: '10115', city: 'Berlin', countryCodeV2: 'DE', phone: null },
    shippingLine: { discountedPriceSet: { shopMoney: { amount: SHOP_VERSAND_BRUTTO.toFixed(2) } }, taxLines: [{ rate: 0.19 }] },
    lineItems: {
      nodes: s.positionen.map((p, i) => ({
        id: `gid://shopify/LineItem/${nummer}${i}`, title: PRODUKTE.find((x) => x.sku === p.produkt)!.name, sku: p.produkt,
        quantity: p.menge, currentQuantity: p.menge, variant: null,
        originalUnitPriceSet: { shopMoney: { amount: p.preis.toFixed(2) } },
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: p.preis.toFixed(2) } },
        taxLines: [{ rate: 0.19 }],
      })),
    },
  } as never)
  await sql()`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`abnahme-${nummer}`}, 'orders/create', ${gid}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  assert.equal(r.processed, 1, `${s.id}: Webhook verarbeitet`)
  const [so] = await sql()<{ id: string; state: string }[]>`
    select id, state::text as state from sales_orders where shopify_order_id = ${gid}`
  assert.ok(so, `${s.id}: Auftrag importiert`)
  assert.equal(so.state, 'sale', `${s.id}: bezahlt ⇒ bestätigt`)
  k.auftraege.set(s.id, { id: so.id, gid })
}

async function shopStorno(auftrag: string): Promise<void> {
  const { fakeOrderHinterlegen, fakeOrderHolen } = await import('../../src/modules/integrationen/shopify-fake.ts')
  const { processPendingWebhooks } = await import('../../src/modules/integrationen/import.ts')
  const a = k.auftraege.get(auftrag)!
  const bisher = fakeOrderHolen(a.gid!)!
  // Shopify meldet die Bestellung storniert und erstattet — KRNL zieht nach.
  const storniert = { ...bisher, cancelledAt: `${szenario.heute}T12:00:00Z`, displayFinancialStatus: 'REFUNDED' }
  fakeOrderHinterlegen(storniert)
  await sql()`insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
              values (${`abnahme-storno-${auftrag}`}, 'orders/cancelled', ${a.gid}, '{}'::jsonb)`
  const r = await processPendingWebhooks(5)
  assert.equal(r.processed, 1)
  const [so] = await sql()<{ state: string }[]>`select state::text as state from sales_orders where id = ${a.id}`
  assert.equal(so.state, 'cancel', `${auftrag}: storniert`)
}

async function rechnungAnlegen(s: Extract<Schritt, { art: 'rechnung' }>): Promise<void> {
  const poId = k.bestellungen.get(s.bestellung)!
  const r = await aktion('einkauf.rechnung_erstellen', poId)
  const billId = r.recordId!
  k.rechnungen.set(s.id, billId)
  await aktion('einkauf.rechnung_details', billId, { bill_date: s.datum })
  await aktion('einkauf.rechnung_buchen', billId)
  if (s.zahlen_am) await rechnungZahlen(s.id, s.zahlen_am)
  else if (s.gedeckt) await aktion('einkauf.rechnung_zahlen', billId)
}

async function rechnungZahlen(rechnung: string, am: string): Promise<void> {
  const billId = k.rechnungen.get(rechnung)!
  const [{ offen }] = await sql()<{ offen: number }[]>`select vendor_bill_offen(${billId}) as offen`
  assert.ok(Number(offen) > 0, `${rechnung}: offener Betrag zum Überweisen`)
  await aktion('finanzen.rechnung_teilzahlung', billId, { betrag: Number(offen), gezahlt_am: am, bankkonto_id: k.bankkonto })
}

// --- Der Interpreter: ein Schritt = Aktionen über den Torwächter -------------------

async function ausfuehren(s: Schritt): Promise<void> {
  switch (s.art) {
    case 'kurs':
      await aktion('einkauf.wechselkurs_erfassen', undefined, { currency: s.waehrung, rate: s.kurs, valid_from: s.ab })
      return
    case 'kontostand':
      await aktion('finanzen.kontostand_erfassen', undefined, { bankkonto_id: k.bankkonto, stichtag: s.stichtag, saldo: s.saldo })
      return
    case 'vertrag': {
      const r = await aktion('finanzen.vertrag_anlegen', undefined, {
        name: s.name, kategorie: 'sonstiges', betrag: s.betrag, waehrung: 'EUR', intervall: 'monatlich',
        zahltag: s.zahltag, beginn: s.beginn, kuendigungsfrist_monate: s.frist,
      })
      k.vertraege.set(s.id, r.recordId!)
      return
    }
    case 'vertrag_zahlen':
      await aktion('finanzen.vertrag_zahlen', k.vertraege.get(s.vertrag), { gezahlt_am: s.am, bankkonto_id: k.bankkonto })
      return
    case 'vertrag_kuendigen':
      await aktion('finanzen.vertrag_kuendigen', k.vertraege.get(s.vertrag), { zum: s.zum })
      return
    case 'darlehen': {
      const r = await aktion('finanzen.darlehen_anlegen', undefined, {
        name: s.name, betrag: s.betrag, zinssatz_pct: s.zins_pct, art: 'annuitaet', auszahlung_am: s.auszahlung_am,
        laufzeit_monate: s.laufzeit, tilgungsfrei_monate: 0, zahltag: s.zahltag, bankkonto_id: k.bankkonto,
      })
      k.darlehen.set(s.id, r.recordId!)
      return
    }
    case 'darlehen_auszahlen':
      await aktion('finanzen.darlehen_auszahlen', undefined, { darlehen_id: k.darlehen.get(s.darlehen), datum: s.am })
      return
    case 'darlehen_rate': {
      const [rate] = await sql()<{ id: string }[]>`
        select id from darlehen_raten where darlehen_id = ${k.darlehen.get(s.darlehen)!} and nr = ${s.nr}`
      await aktion('finanzen.darlehen_rate_zahlen', undefined, { rate_id: rate.id, datum: s.am, bankkonto_id: k.bankkonto })
      return
    }
    case 'steuer': {
      const r = await aktion('finanzen.steuer_erfassen', undefined, {
        art: 'ust', zeitraum_von: s.von, zeitraum_bis: s.bis, bezeichnung: s.bezeichnung, betrag: s.betrag, faellig_am: s.faellig,
      })
      k.steuern.set(s.id, r.recordId!)
      return
    }
    case 'steuer_zahlen':
      await aktion('finanzen.steuer_zahlen', undefined, { steuer_id: k.steuern.get(s.steuer), datum: s.am, bankkonto_id: k.bankkonto })
      return
    case 'inventur': {
      const id = k.varianten[s.produkt]
      const [{ buch }] = await sql()<{ buch: number }[]>`select on_hand_qty(${id}) as buch`
      const gezaehlt = s.gezaehlt ?? Number(buch) + (s.differenz ?? 0)
      const z = await aktion('lager.zaehlung_erfassen', undefined, { variant_id: id, counted_qty: gezaehlt })
      await aktion('lager.zaehlung_buchen', z.recordId)
      return
    }
    case 'bestellung': {
      const positionen = s.positionen.map((p) => ({ produkt: p.produkt, menge: p.menge, preis: p.preis }))
      if (s.waehrung === 'EUR') {
        const r = await aktion('einkauf.bestellung_mit_positionen', undefined, { lieferant: s.lieferant, positionen })
        k.bestellungen.set(s.id, r.recordId!)
        await aktion('einkauf.bestaetigen', r.recordId)
      } else {
        const r = await aktion('einkauf.bestellung_erfassen', undefined, {
          lieferant: s.lieferant, lieferant_neu: false, positionen, waehrung: s.waehrung, referenz: s.referenz,
          versandkosten: s.fracht, bestaetigen: true, bezahlt: Boolean(s.vorkasse_am), bezahlt_am: s.vorkasse_am,
        })
        k.bestellungen.set(s.id, r.recordId!)
      }
      const [po] = await sql()<{ state: string }[]>`select state::text as state from purchase_orders where id = ${k.bestellungen.get(s.id)!}`
      assert.equal(po.state, 'purchase', `${s.id}: bestätigt`)
      return
    }
    case 'wareneingang': {
      const poId = k.bestellungen.get(s.bestellung)!
      const offen = (await wareneingaenge(poId)).find((p) => p.state === 'assigned' || p.state === 'confirmed')
      assert.ok(offen, `${s.bestellung}: offener Wareneingang`)
      const mengen: Record<string, number> = {}
      if (s.mengen) {
        const moves = await sql()<{ id: string; sku: string }[]>`
          select m.id, pv.sku from stock_moves m join product_variants pv on pv.id = m.variant_id
          where m.picking_id = ${offen.id} and m.state not in ('done', 'cancel')`
        for (const m of moves) if (m.sku in s.mengen) mengen[m.id] = s.mengen[m.sku as Sku]!
      }
      await aktion('lager.transfer_buchen', offen.id, { mengen, lose: {}, backorder: true })
      return
    }
    case 'nebenkosten': {
      const poId = k.bestellungen.get(s.bestellung)!
      const picking = (await wareneingaenge(poId))[s.eingang - 1]
      assert.ok(picking, `${s.bestellung}: Wareneingang ${s.eingang}`)
      await aktion('einkauf.nebenkosten_erfassen', picking.id, { amount: s.betrag, currency: 'EUR', cost_type: s.typ, basis: s.basis, is_estimate: false })
      const [lc] = await sql()<{ id: string }[]>`
        select id from landed_costs where picking_id = ${picking.id} and state = 'draft' order by created_at desc limit 1`
      await aktion('einkauf.nebenkosten_buchen', lc.id)
      return
    }
    case 'rechnung':
      await rechnungAnlegen(s)
      return
    case 'rechnung_zahlen':
      await rechnungZahlen(s.rechnung, s.am)
      return
    case 'shop_bestellung':
      await shopBestellung(s)
      return
    case 'shop_storno':
      await shopStorno(s.bestellung)
      return
    case 'auftrag': {
      const r = await aktion('verkauf.auftrag_mit_positionen', undefined, {
        kunde: s.kunde, positionen: s.positionen.map((p) => ({ produkt: p.produkt, menge: p.menge, preis: p.preis })),
      })
      k.auftraege.set(s.id, { id: r.recordId!, gid: null })
      await aktion('verkauf.bestaetigen', r.recordId)
      return
    }
    case 'auftrag_storno':
      await aktion('verkauf.stornieren', k.auftraege.get(s.auftrag)!.id)
      return
    case 'fertig': {
      const a = k.auftraege.get(s.auftrag)!
      const mos = await sql()<{ id: string }[]>`
        select id from manufacturing_orders where sales_order_id = ${a.id} and state in ('confirmed', 'progress') order by created_at`
      assert.ok(mos.length > 0, `${s.auftrag}: offener Fertigungsauftrag`)
      for (const mo of mos) await aktion('fertigung.fertig_melden', mo.id, { mengen: {}, backorder: false })
      return
    }
    case 'fertigung': {
      const r = await aktion('fertigung.auftrag_anlegen', undefined, { variant_id: s.produkt, qty: s.menge })
      await aktion('fertigung.bestaetigen', r.recordId)
      await aktion('fertigung.fertig_melden', r.recordId, { mengen: {}, backorder: false })
      return
    }
    case 'versand': {
      const a = k.auftraege.get(s.auftrag)!
      const p = await lieferung(a.id)
      assert.equal(p.state, 'assigned', `${s.auftrag}: Lieferung versandbereit`)
      if (a.gid) {
        const r = await aktion('versand.label_erstellen', p.id, { nicht_ausbuchen: false })
        assert.match(r.text ?? '', /ausgebucht/, `${s.auftrag}: Label bucht aus`)
      } else {
        await aktion('lager.transfer_buchen', p.id, { mengen: {}, lose: {}, backorder: false })
      }
      const [nachher] = await sql()<{ state: string }[]>`select state::text as state from stock_pickings where id = ${p.id}`
      assert.equal(nachher.state, 'done', `${s.auftrag}: Warenausgang gebucht`)
      await jobsLeeren()
      return
    }
    case 'demontage': {
      const r = await aktion('fertigung.demontage_anlegen', undefined, { variant_id: k.varianten[s.produkt], qty: s.menge })
      await aktion('fertigung.demontage_buchen', r.recordId, { force: false })
      return
    }
    case 'ausschuss':
      await aktion('lager.ausschuss_buchen', undefined, { variant_id: k.varianten[s.produkt], qty: s.menge, reason: 'Abnahmetest' })
      return
    case 'monatsende': {
      // Wie der Betrieb: Outbox leer, stündlicher Shopify-Abgleich, dann der Vergleich.
      await jobsLeeren()
      const { inventarAbgleichen } = await import('../../src/modules/integrationen/inventar.ts')
      const r = await inventarAbgleichen()
      assert.equal(r.gesperrt, false, 'Abgleich lief')
      await jobsLeeren()
      return
    }
  }
}

async function monatPruefen(monat: 1 | 2 | 3): Promise<void> {
  const ist = await istStandLesen(sql(), { varianten: k.varianten } satisfies Kennungen, szenario.faelligBis)
  const abweichungen = vergleichen(erwartung.monate[monat], ist)
  const text = abweichungenText(`Monat ${monat}`, abweichungen)
  spur(text)
  assert.equal(abweichungen.length, 0, text)

  // Die Attrappe hat zuletzt genau die Mengen bekommen, die der Shop zeigen soll.
  const { fakeLetzterAufruf } = await import('../../src/modules/integrationen/shopify-fake.ts')
  const aufruf = fakeLetzterAufruf('inventorySetQuantities') as
    | { input: { quantities: { inventoryItemId: string; quantity: number }[] } }
    | undefined
  assert.ok(aufruf, 'Bestand wurde an Shopify gemeldet')
  for (const q of aufruf.input.quantities) {
    const p = PRODUKTE.find((x) => q.inventoryItemId === `gid://shopify/InventoryItem/${x.shopify}`)
    assert.ok(p, `gemeldetes InventoryItem ${q.inventoryItemId} gehört zu einem Szenario-Artikel`)
    assert.equal(q.quantity, erwartung.monate[monat].shopify.soll[p.sku], `${p.sku}: an Shopify übergebene Menge`)
  }
}

async function monatLaufen(monat: 1 | 2 | 3): Promise<void> {
  const start = szenario.schritte.findIndex((_s, i) => (monat === 1 ? i === 0 : szenario.schritte[i - 1]?.art === 'monatsende' && (szenario.schritte[i - 1] as { monat: number }).monat === monat - 1))
  for (let i = start; i < szenario.schritte.length; i++) {
    const s = szenario.schritte[i]
    spur(`Monat ${monat}: ${s.art}${'id' in s ? ` ${s.id}` : ''}`)
    await ausfuehren(s)
    if (s.art === 'monatsende') {
      assert.equal(s.monat, monat)
      break
    }
  }
  await monatPruefen(monat)
}

before(async () => {
  h = await harnessStart(DATENBANK)
  const [{ heute }] = await h.sql<{ heute: string }[]>`select current_date::text as heute`
  szenario = szenarioErzeugen(heute)
  erwartung = simulieren(szenario)
  await stammdatenAnlegen()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Abnahmetest: drei Monate live gegen das Modell', () => {
  test('Monat 1 — Einrichtung, Einkauf in EUR und USD, erste Shop-Bestellungen', async () => {
    await monatLaufen(1)
  })
  test('Monat 2 — Rückstand, Nebenkosten, Fertigung, Storno im Shop, B2B-Auftrag', async () => {
    await monatLaufen(2)
  })
  test('Monat 3 — Demontage, Fertigung auf Lager, Inventur, Kündigung, Abschluss', async () => {
    await monatLaufen(3)
  })
})
