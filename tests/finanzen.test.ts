import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, expectError, uomStueck, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Finanzen, Ausbaustufe 1 (Migration 0058): Zahlungsregister, Teilzahlungen
 * mit Anrechnung, Zahlplan-Fälligkeiten, Kontostands-Anker. Alles läuft über
 * die SQL-Funktionen — genau wie die Oberfläche.
 */

async function finanzSzenario(t: TransactionSql) {
  const uom = await uomStueck(t)
  const [vendor] = await t<{ id: string }[]>`
    insert into partners (name, is_vendor) values ('Fernost Components Ltd', true) returning id`
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_purchased, route_buy, bill_policy)
    values ('Gehäuse CNC', ${uom}, true, true, 'ordered'::bill_policy) returning id`
  await t`select generate_variants(${tpl.id})`
  const [variant] = await t<{ id: string }[]>`
    select id from product_variants where template_id = ${tpl.id} limit 1`
  const [order] = await t<{ id: string }[]>`
    insert into purchase_orders (number, vendor_id)
    values (next_sequence('purchase'), ${vendor.id}) returning id`
  // 100 Stück à 10 € netto, 19 % → 1190 € brutto
  await t`insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit, tax_rate)
          values (${order.id}, ${variant.id}, 'Gehäuse CNC', 100, ${uom}, 10, 19)`
  return { vendorId: vendor.id, orderId: order.id, uom }
}

async function rechnungZu(t: TransactionSql, orderId: string): Promise<string> {
  // Abrechnung setzt eine bestätigte Bestellung voraus (Statusmaschine 0007).
  await t`update purchase_orders set state = 'purchase', confirmed_at = coalesce(confirmed_at, now())
          where id = ${orderId}`
  const [bill] = await t<{ create_vendor_bill: string }[]>`
    select create_vendor_bill(${orderId}, 'test')`
  await t`update vendor_bills set bill_date = current_date where id = ${bill.create_vendor_bill}`
  await t`select post_vendor_bill(${bill.create_vendor_bill}, 'test')`
  return bill.create_vendor_bill
}

describe('Finanzen: Zahlungsregister', () => {
  test('Teilzahlung deckt erst bei voller Summe — dann paid', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      const billId = await rechnungZu(t, s.orderId)

      await t`select zahlung_erfassen('aus', 500, 'EUR', current_date, null, 'vendor_bill', ${billId}, null, 'test')`
      let [bill] = await t<{ state: string }[]>`select state from vendor_bills where id = ${billId}`
      assert.equal(bill.state, 'posted', 'Teilzahlung darf noch nicht auf paid springen')
      const [offen1] = await t<{ offen: number }[]>`select vendor_bill_offen(${billId}) as offen`
      assert.equal(Number(offen1.offen), 690)

      await t`select zahlung_erfassen('aus', 690, 'EUR', current_date, null, 'vendor_bill', ${billId}, null, 'test')`
      ;[bill] = await t<{ state: string }[]>`select state from vendor_bills where id = ${billId}`
      assert.equal(bill.state, 'paid', 'Volle Deckung setzt die Rechnung auf paid')
    })
  })

  test('Überzahlung einer gedeckten Rechnung wird abgewiesen', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      const billId = await rechnungZu(t, s.orderId)
      await t`select zahlung_erfassen('aus', 1190, 'EUR', current_date, null, 'vendor_bill', ${billId}, null, 'test')`
      await expectError(
        t,
        (sp) =>
          sp`select zahlung_erfassen('aus', 1, 'EUR', current_date, null, 'vendor_bill', ${billId}, null, 'test')`,
        /vollständig gedeckt/,
      )
    })
  })

  test('Storno öffnet die Rechnung wieder', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      const billId = await rechnungZu(t, s.orderId)
      await t`select zahlung_erfassen('aus', 1190, 'EUR', current_date, null, 'vendor_bill', ${billId}, null, 'test')`
      const [z] = await t<{ id: string }[]>`
        select id from zahlungen where vendor_bill_id = ${billId}`
      await t`select zahlung_stornieren(${z.id}, 'test')`
      const [bill] = await t<{ state: string; paid_at: string | null }[]>`
        select state, paid_at from vendor_bills where id = ${billId}`
      assert.equal(bill.state, 'posted')
      assert.equal(bill.paid_at, null)
      const [offen] = await t<{ offen: number }[]>`select vendor_bill_offen(${billId}) as offen`
      assert.equal(Number(offen.offen), 1190)
    })
  })

  test('Anrechnung 30/70: Zahlplan-Anzahlung mindert den offenen Rechnungsbetrag', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      // Zahlplan: 30 % bei Bestellung, 70 % bei Verschiffung
      const [rate30] = await t<{ id: string }[]>`
        insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
        values (${s.orderId}, 10, 'Anzahlung 30 %', 30, 'bestellung') returning id`
      await t`insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
              values (${s.orderId}, 20, 'Rest 70 %', 70, 'verschiffung')`

      // Anzahlung zahlen (357 = 30 % von 1190)
      await t`select zahlung_erfassen('aus', 357, 'EUR', current_date, null, 'po_rate', ${rate30.id}, null, 'test')`
      const [rate] = await t<{ bezahlt_am: string | null }[]>`
        select bezahlt_am from zahlplan_raten where id = ${rate30.id}`
      assert.ok(rate.bezahlt_am, 'Rate ist als bezahlt markiert')

      // 100-%-Rechnung kommt später: offen sind nur noch 70 %
      const billId = await rechnungZu(t, s.orderId)
      const [offen] = await t<{ offen: number }[]>`select vendor_bill_offen(${billId}) as offen`
      assert.equal(Number(offen.offen), 833, 'Anzahlung wird angerechnet (1190 − 357)')

      // pay_vendor_bill zahlt nur den Rest und setzt paid
      await t`select pay_vendor_bill(${billId}, 'test')`
      const [bill] = await t<{ state: string }[]>`select state from vendor_bills where id = ${billId}`
      assert.equal(bill.state, 'paid')
      const [summe] = await t<{ s: number }[]>`
        select coalesce(sum(betrag_eur), 0) as s from zahlungen where storniert_am is null`
      assert.equal(Number(summe.s), 1190, 'Insgesamt fließt genau das Bestellbrutto')
    })
  })

  test('Fälligkeit je Auslöser: Termin, Bestellung, Verschiffung über Transitzeit', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      await t`update purchase_orders set confirmed_at = '2026-08-01', eta_confirmed = '2026-09-15'
              where id = ${s.orderId}`
      const faelligkeit = async (bezeichnung: string): Promise<string> => {
        const [row] = await t<{ f: string }[]>`
          select zahlplan_faelligkeit(r)::text as f from zahlplan_raten r
          where r.purchase_order_id = ${s.orderId} and r.bezeichnung = ${bezeichnung}`
        return row.f.slice(0, 10)
      }
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser, termin)
              values (${s.orderId}, 'Termin-Rate', 10, 'termin', '2026-10-01')`
      assert.equal(await faelligkeit('Termin-Rate'), '2026-10-01')
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser, versatz_tage)
              values (${s.orderId}, 'Anzahlung', 30, 'bestellung', 3)`
      assert.equal(await faelligkeit('Anzahlung'), '2026-08-04', 'Bestätigt-Datum + Versatz')
      // Verschiffung ohne Fakt: bestätigte ETA minus Transitzeit (Default 30)
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser)
              values (${s.orderId}, 'Rest', 60, 'verschiffung')`
      assert.equal(await faelligkeit('Rest'), '2026-08-16', 'ETA − transit_tage')
      // Echter Verschiffungstag schlägt die Schätzung
      await t`update purchase_orders set verschifft_am = '2026-08-20' where id = ${s.orderId}`
      assert.equal(await faelligkeit('Rest'), '2026-08-20')
    })
  })

  test('finanz_saldo: Anker + spätere Zahlungen, frühere zählen nicht', async () => {
    await withRollback(async (t) => {
      const [konto] = await t<{ id: string }[]>`
        insert into bankkonten (name) values ('Testkonto') returning id`
      await t`insert into kontostaende (bankkonto_id, stichtag, saldo)
              values (${konto.id}, '2026-08-10', 10000)`
      // Vor dem Anker: darf nicht zählen
      await t`select zahlung_erfassen('aus', 999, 'EUR', '2026-08-05', ${konto.id}, 'manuell', null, 'alt', 'test')`
      // Nach dem Anker: zählt
      await t`select zahlung_erfassen('ein', 500, 'EUR', '2026-08-12', ${konto.id}, 'manuell', null, 'neu', 'test')`
      await t`select zahlung_erfassen('aus', 200, 'EUR', '2026-08-13', ${konto.id}, 'manuell', null, 'neu', 'test')`
      const [saldo] = await t<{ saldo: number }[]>`
        select saldo from finanz_saldo() where bankkonto_id = ${konto.id}`
      assert.equal(Number(saldo.saldo), 10300)
    })
  })

  test('finanz_faellig: je Bestellung zählt Zahlplan ODER Rechnung, nie beides', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      await t`update purchase_orders set confirmed_at = current_date where id = ${s.orderId}`
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser)
              values (${s.orderId}, 'Anzahlung 30 %', 30, 'bestellung')`
      const billId = await rechnungZu(t, s.orderId)
      await t`update vendor_bills set due_date = current_date where id = ${billId}`
      // Nur die Posten DIESER Bestellung — die Funktion sieht auch Dev-Daten.
      const eintraege = await t<{ quelle: string; link: string }[]>`
        select quelle, link from finanz_faellig(current_date + 30)
        where link in (${'/einkauf/' + s.orderId}, ${'/einkauf/rechnungen/' + billId})`
      assert.equal(eintraege.length, 1, 'Nur die Zahlplan-Rate erscheint')
      assert.equal(eintraege[0].quelle, 'po_rate')
    })
  })

  test('Zahlplan-Riegel: bezahlte Raten überleben das Neu-Aufsetzen nicht heimlich', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      const [rate] = await t<{ id: string }[]>`
        insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser)
        values (${s.orderId}, 'Anzahlung', 30, 'bestellung') returning id`
      await t`select zahlung_erfassen('aus', 357, 'EUR', current_date, null, 'po_rate', ${rate.id}, null, 'test')`
      await expectError(
        t,
        (sp) => sp`select zahlung_erfassen('aus', 1, 'EUR', current_date, null, 'po_rate', ${rate.id}, null, 'test')`,
        /bereits bezahlt/,
      )
    })
  })
})
