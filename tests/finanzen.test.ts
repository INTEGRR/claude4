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

  test('Vertrag: rollierende Mindestlaufzeit wahrt die Kündigungsfrist', async () => {
    await withRollback(async (t) => {
      // 12 Monate Laufzeit ab 2024-01-01, 3 Monate Frist. Kandidaten enden
      // am 2024-12-31, 2025-12-31, 2026-12-31 … — heute (2026-08-17) ist die
      // Frist für 2026-12-31 (bis 2026-09-30) noch offen.
      const [v] = await t<{ id: string }[]>`
        insert into vertraege (nummer, name, kategorie, betrag, beginn,
                               laufzeit_monate, kuendigungsfrist_monate)
        values (next_sequence('vertrag'), 'Lager Miete', 'miete', 2500, '2024-01-01', 12, 3)
        returning id`
      const [k] = await t<{ zum: string; frist: string }[]>`
        select vertrag_naechstes_kuendbar_zum(v)::text as zum,
               vertrag_kuendigungsfrist_bis(v)::text as frist
        from vertraege v where v.id = ${v.id}`
      const zum = new Date(k.zum)
      const frist = new Date(k.frist)
      assert.ok(frist >= new Date(), 'Der nächste Kandidat hat eine noch offene Frist')
      assert.equal(
        (zum.getTime() - new Date('2024-01-01').getTime()) % 1 >= 0 && zum.getMonth(),
        11,
        'Kandidat liegt am Laufzeitende (Dezember)',
      )

      // Kündigen ohne Datum nimmt genau diesen Termin.
      const [ergebnis] = await t<{ zum: string }[]>`
        select vertrag_kuendigen(${v.id}, null, 'test')::text as zum`
      assert.equal(ergebnis.zum, k.zum)

      // Ein früherer Termin als der fristgerechte wird abgewiesen.
      const [v2] = await t<{ id: string }[]>`
        insert into vertraege (nummer, name, kategorie, betrag, beginn,
                               laufzeit_monate, kuendigungsfrist_monate)
        values (next_sequence('vertrag'), 'Lager Miete 2', 'miete', 2500, '2024-01-01', 12, 3)
        returning id`
      await expectError(
        t,
        (sp) => sp`select vertrag_kuendigen(${v2.id}, current_date, 'test')`,
        /Frühester Kündigungstermin/,
      )
    })
  })

  test('Vertrag: Projektion endet mit der Kündigung, Zahlung deckt den Monatstermin', async () => {
    await withRollback(async (t) => {
      const [v] = await t<{ id: string }[]>`
        insert into vertraege (nummer, name, kategorie, betrag, beginn, zahltag)
        values (next_sequence('vertrag'), 'Sendcloud', 'lizenzen', 89, '2026-01-01', 15)
        returning id`
      // Unbefristet: 12-Monats-Horizont liefert monatliche Termine am 15.
      const termine = await t<{ faellig_am: string; betrag_eur: number }[]>`
        select * from vertrag_zahlungen_bis(${v.id}, current_date + 365)`
      assert.ok(termine.length >= 11 && termine.length <= 13, `Monatstermine (${termine.length})`)
      assert.ok(termine.every((z) => new Date(z.faellig_am).getDate() === 15))

      // Kündigung deckelt die Projektion.
      await t`update vertraege
              set status = 'gekuendigt', gekuendigt_zum = current_date + 45 where id = ${v.id}`
      const gedeckelt = await t<{ faellig_am: string }[]>`
        select faellig_am from vertrag_zahlungen_bis(${v.id}, current_date + 365)`
      assert.ok(gedeckelt.length <= 2, 'Nach dem Kündigungstermin kommt nichts mehr')

      // Vertragszahlung im Monat des Termins nimmt ihn aus der Fällig-Liste.
      await t`update vertraege set status = 'aktiv', gekuendigt_zum = null where id = ${v.id}`
      const vorher = await t<{ ref: string }[]>`
        select ref from finanz_faellig(current_date + 45) where ref = ${v.id}`
      if (vorher.length > 0) {
        await t`select zahlung_erfassen('aus', 89, 'EUR',
                  (select min(faellig_am) from vertrag_zahlungen_bis(${v.id}, current_date + 45)),
                  null, 'vertrag', ${v.id}, null, 'test')`
        const nachher = await t<{ ref: string; faellig_am: string }[]>`
          select ref, faellig_am from finanz_faellig(current_date + 45) where ref = ${v.id}`
        assert.ok(
          nachher.length < vorher.length,
          'Der beglichene Monatstermin verschwindet aus der Fällig-Liste',
        )
      }
    })
  })

  test('Darlehen: Annuität konstant, Tilgungssumme = Darlehenssumme', async () => {
    await withRollback(async (t) => {
      const [d] = await t<{ id: string }[]>`
        insert into darlehen (nummer, name, betrag, zinssatz_pct, art, auszahlung_am, laufzeit_monate)
        values (next_sequence('darlehen'), 'Warenfinanzierung', 60000, 6, 'annuitaet', '2026-09-01', 24)
        returning id`
      const [{ n }] = await t<{ n: number }[]>`
        select darlehen_raten_generieren(${d.id}, 'test') as n`
      assert.equal(n, 24)

      const raten = await t<{ zins: number; tilgung: number; restschuld: number }[]>`
        select zins, tilgung, restschuld from darlehen_raten
        where darlehen_id = ${d.id} order by nr`
      const tilgungSumme = raten.reduce((s, r) => s + Number(r.tilgung), 0)
      assert.ok(Math.abs(tilgungSumme - 60000) < 0.01, `Σ Tilgung = Summe (${tilgungSumme})`)
      assert.equal(Number(raten.at(-1)!.restschuld), 0, 'Restschuld endet bei 0')
      // Annuität (Zins + Tilgung) ist konstant — bis auf die Rundungs-Schlussrate.
      const annuitaeten = raten.slice(0, -1).map((r) => Number(r.zins) + Number(r.tilgung))
      const min = Math.min(...annuitaeten)
      const max = Math.max(...annuitaeten)
      assert.ok(max - min < 0.02, `Annuität konstant (${min}…${max})`)
    })
  })

  test('Darlehen: endfällig zahlt nur Zinsen, die Schlussrate tilgt alles', async () => {
    await withRollback(async (t) => {
      const [d] = await t<{ id: string }[]>`
        insert into darlehen (nummer, name, betrag, zinssatz_pct, art, auszahlung_am, laufzeit_monate)
        values (next_sequence('darlehen'), 'Bridge', 100000, 12, 'endfaellig', '2026-09-01', 6)
        returning id`
      await t`select darlehen_raten_generieren(${d.id}, 'test')`
      const raten = await t<{ nr: number; zins: number; tilgung: number }[]>`
        select nr, zins, tilgung from darlehen_raten where darlehen_id = ${d.id} order by nr`
      assert.ok(raten.slice(0, -1).every((r) => Number(r.tilgung) === 0))
      assert.equal(Number(raten.at(-1)!.tilgung), 100000)
      assert.equal(Number(raten[0].zins), 1000, '12 % p. a. auf 100k = 1000 €/Monat')
    })
  })

  test('Darlehen: Auszahlung bucht Einzahlung, letzte Rate tilgt', async () => {
    await withRollback(async (t) => {
      const [d] = await t<{ id: string }[]>`
        insert into darlehen (nummer, name, betrag, zinssatz_pct, art, auszahlung_am, laufzeit_monate)
        values (next_sequence('darlehen'), 'Mini', 1000, 0, 'rate', '2026-09-01', 2)
        returning id`
      await t`select darlehen_auszahlen(${d.id}, current_date, 'test')`
      const [ein] = await t<{ s: number }[]>`
        select coalesce(sum(betrag_eur), 0) as s from zahlungen
        where darlehen_id = ${d.id} and richtung = 'ein' and storniert_am is null`
      assert.equal(Number(ein.s), 1000)

      const raten = await t<{ id: string }[]>`
        select id from darlehen_raten where darlehen_id = ${d.id} order by nr`
      for (const r of raten) {
        await t`select darlehen_rate_zahlen(${r.id}, current_date, null, 'test')`
      }
      const [status] = await t<{ status: string }[]>`
        select status from darlehen where id = ${d.id}`
      assert.equal(status.status, 'getilgt')
    })
  })

  test('USt-Vorschlag: Umsatzsteuer − Vorsteuer aus den Belegen des Monats', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      // Die Dev-DB kann bereits Juli-Belege enthalten — deshalb misst der Test
      // die DIFFERENZ des Vorschlags vor/nach den eigenen Belegen, nicht absolut.
      const [vorher] = await t<
        { umsatzsteuer: number; vorsteuer: number }[]
      >`select * from ust_zahllast_vorschlag('2026-07-01')`

      // Einkauf: 1000 netto + 190 Vorsteuer im Juli 2026
      const billId = await rechnungZu(t, s.orderId)
      await t`update vendor_bills set bill_date = '2026-07-10' where id = ${billId}`
      // Verkauf: 500 netto + 95 USt im Juli 2026
      const [kunde] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('USt Kunde', true) returning id`
      const [so] = await t<{ id: string }[]>`
        insert into sales_orders (number, partner_id, state, order_date)
        values (next_sequence('sale'), ${kunde.id}, 'sale', '2026-07-05') returning id`
      const [variant] = await t<{ id: string }[]>`
        select pv.id from product_variants pv
        join product_templates pt on pt.id = pv.template_id
        where pt.name = 'Gehäuse CNC' limit 1`
      await t`insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit, tax_rate)
              values (${so.id}, ${variant.id}, 'Gehäuse CNC', 5, ${s.uom}, 100, 19)`

      const [v] = await t<
        { umsatzsteuer: number; vorsteuer: number; zahllast: number; faellig_am: string }[]
      >`select umsatzsteuer, vorsteuer, zahllast, faellig_am::text as faellig_am
        from ust_zahllast_vorschlag('2026-07-01')`
      assert.equal(Number(v.umsatzsteuer) - Number(vorher.umsatzsteuer), 95)
      assert.equal(Number(v.vorsteuer) - Number(vorher.vorsteuer), 190)
      assert.equal(Number(v.zahllast), Number(v.umsatzsteuer) - Number(v.vorsteuer))
      assert.equal(v.faellig_am, '2026-08-10', 'Folgemonat am ust_zahltag')

      // Übernehmen legt den Termin an; ein zweites Mal wird abgewiesen.
      await t`select ust_vorschlag_uebernehmen('2026-07-01', 'test')`
      await expectError(
        t,
        (sp) => sp`select ust_vorschlag_uebernehmen('2026-07-01', 'test')`,
        /existiert bereits/,
      )
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

/**
 * Ausbaustufe 4 (0061): Umsatzplan + finanz_prognose. Die Prüffälle des
 * Deckungskontos laufen auf einer NEUTRALISIERTEN Datenlage: alle laufenden
 * Belege/Verträge/Darlehen werden in der Transaktion stillgelegt (Rollback
 * macht alles rückgängig), damit die Fixtures die einzige Geldquelle sind.
 */

async function prognoseLeeren(t: TransactionSql) {
  await t`update settings set value = value || ${JSON.stringify({
    wareneinsatz_pct: 30, versand_pct: 6, fees_pct: 3,
    ust_satz_pct: 19, ust_zahltag: 10, ust_frist_monate: 1, ust_zahllast_quote_pct: 8,
    shopify_versatz_tage: 0, rechnung_versatz_tage: 14,
    best_aufschlag_pct: 15, worst_abschlag_pct: 20, liquiditaets_puffer: 0,
  })}::jsonb where key = 'finanzen'`
  await t`update settings set value = '{}'::jsonb where key = 'freigaben'`
  await t`delete from umsatzplan`
  await t`delete from zahlungen`
  await t`delete from zahlplan_raten`
  await t`update vendor_bills set state = 'paid' where state = 'posted'`
  await t`update purchase_orders set state = 'done' where state in ('draft', 'sent', 'purchase')`
  await t`update vertraege set status = 'beendet'`
  await t`update darlehen set status = 'getilgt'`
  await t`update steuerzahlungen set bezahlt_am = current_date where bezahlt_am is null`
  await t`update product_variants set valuation_total = 0 where valuation_total <> 0`
}

interface PrognoseZeile {
  periode_start: string
  periode_ende: string
  einzahlungen: number
  aus_bestellungen: number
  aus_vertraegen: number
  aus_darlehen: number
  aus_steuern: number
  aus_variable_quote: number
  endsaldo: number
}

async function prognose(t: TransactionSql, raster = 'monat'): Promise<PrognoseZeile[]> {
  return t<PrognoseZeile[]>`
    select periode_start::text, periode_ende::text, einzahlungen, aus_bestellungen,
           aus_vertraegen, aus_darlehen, aus_steuern, aus_variable_quote, endsaldo
    from finanz_prognose('base', ${raster})`
}

const summe = (zeilen: PrognoseZeile[], spalte: keyof PrognoseZeile) =>
  zeilen.reduce((s, z) => s + Number(z[spalte]), 0)

function assertNah(ist: number, soll: number, was: string, toleranz = 1) {
  assert.ok(
    Math.abs(ist - soll) <= toleranz,
    `${was}: erwartet ~${soll}, bekommen ${ist}`,
  )
}

/** Planmonat M+1 (voll in der Zukunft, liegt in beiden Rastern komplett im Horizont). */
async function folgemonat(t: TransactionSql): Promise<string> {
  const [m] = await t<{ monat: string }[]>`
    select ((date_trunc('month', current_date) + interval '1 month')::date)::text as monat`
  return m.monat
}

describe('Finanzen: Cashflow-Prognose (Deckungskonto)', () => {
  test('Prüffall 4: nichts vorhanden → volle Quote (Wochen ≙ Monate)', async () => {
    await withRollback(async (t) => {
      await prognoseLeeren(t)
      const m1 = await folgemonat(t)
      await t`select plan_setzen(${m1}, 'base', 10000, 'test')`

      const monat = await prognose(t)
      // 30 % Wareneinsatz + 6 % Versand + 3 % Fees = 3 900 € — nichts ist
      // gedeckt, die Quote trägt alles; konkrete Bestellzahlungen gibt es keine.
      assertNah(summe(monat, 'aus_variable_quote'), 3900, 'variable Quote (Monat)')
      assertNah(summe(monat, 'aus_bestellungen'), 0, 'Bestellungen', 0.01)

      // Dasselbe im Wochenraster: der Planmonat liegt komplett in den 13
      // Wochen, die Summen müssen übereinstimmen (taggenaue Verteilung).
      const woche = await prognose(t, 'woche')
      assertNah(
        summe(woche, 'aus_variable_quote'),
        summe(monat, 'aus_variable_quote'),
        'Wochen ≙ Monate (variable Quote)',
      )
    })
  })

  test('Prüffall 1: Ware da + Rechnung offen → nur konkret, Quote gedeckt', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      const billId = await rechnungZu(t, s.orderId)
      await prognoseLeeren(t)
      // Neutralisierung hat die Testrechnung mit stillgelegt — wieder öffnen,
      // die Bestellung bleibt bestätigt (kein Zulauf: alles empfangen).
      await t`update vendor_bills set state = 'posted' where id = ${billId}`
      await t`update purchase_orders set state = 'purchase' where id = ${s.orderId}`
      await t`update purchase_order_lines set qty_received = qty where order_id = ${s.orderId}`
      // Ware liegt bewertet im Lager: Deckung = 3 000 € = Wareneinsatz-Soll.
      await t`update product_variants pv set valuation_total = 3000
              from purchase_order_lines l
              where l.order_id = ${s.orderId} and l.variant_id = pv.id`
      const m1 = await folgemonat(t)
      await t`select plan_setzen(${m1}, 'base', 10000, 'test')`

      const zeilen = await prognose(t)
      assertNah(summe(zeilen, 'aus_bestellungen'), 1190, 'offene Rechnung als konkrete Zahlung', 0.01)
      // Wareneinsatz-Quote 0 (gedeckt), es bleiben Versand + Fees = 900 €.
      assertNah(summe(zeilen, 'aus_variable_quote'), 900, 'nur umsatzsynchrone Quoten')
    })
  })

  test('Prüffall 2: Ware da + Rechnung bezahlt → nichts', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      await rechnungZu(t, s.orderId)
      await prognoseLeeren(t)
      await t`update purchase_orders set state = 'purchase' where id = ${s.orderId}`
      await t`update purchase_order_lines set qty_received = qty where order_id = ${s.orderId}`
      await t`update product_variants pv set valuation_total = 3000
              from purchase_order_lines l
              where l.order_id = ${s.orderId} and l.variant_id = pv.id`
      const m1 = await folgemonat(t)
      await t`select plan_setzen(${m1}, 'base', 10000, 'test')`

      const zeilen = await prognose(t)
      assertNah(summe(zeilen, 'aus_bestellungen'), 0, 'bezahlte Ware erzeugt keinen Abfluss mehr', 0.01)
      assertNah(summe(zeilen, 'aus_variable_quote'), 900, 'Quote bleibt gedeckt')
    })
  })

  test('Prüffall 3: Container im Zulauf, 30 % gezahlt → nur die offenen 70 % konkret', async () => {
    await withRollback(async (t) => {
      const s = await finanzSzenario(t)
      await prognoseLeeren(t)
      // Bestellung bestätigt, nichts empfangen: der Zulauf (1 000 € netto)
      // deckt einen Teil des Solls, den Rest deckt vorhandene Ware.
      await t`update purchase_orders set state = 'purchase', confirmed_at = now()
              where id = ${s.orderId}`
      await t`update product_variants pv set valuation_total = 2000
              from purchase_order_lines l
              where l.order_id = ${s.orderId} and l.variant_id = pv.id`
      const m1 = await folgemonat(t)
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser, bezahlt_am)
              values (${s.orderId}, 'Anzahlung', 30, 'bestellung', current_date)`
      await t`insert into zahlplan_raten (purchase_order_id, bezeichnung, anteil_pct, ausloeser, termin)
              values (${s.orderId}, 'Rest bei Verschiffung', 70, 'termin', ${m1})`
      await t`select plan_setzen(${m1}, 'base', 10000, 'test')`

      const zeilen = await prognose(t)
      assertNah(summe(zeilen, 'aus_bestellungen'), 833, 'nur die offene 70-%-Rate zählt')
      assertNah(summe(zeilen, 'aus_variable_quote'), 900, 'Zulauf + Bestand decken die Warenquote')
    })
  })

  test('Vertrag mit Ende im Horizont: Zahlungen stoppen am effektiven Ende', async () => {
    await withRollback(async (t) => {
      await prognoseLeeren(t)
      const [v] = await t<{ id: string; ende: string }[]>`
        insert into vertraege (nummer, name, kategorie, betrag, intervall, zahltag,
                               beginn, ende, status)
        values (next_sequence('vertrag'), 'Testlizenz', 'lizenzen', 500, 'monatlich', 1,
                (date_trunc('month', current_date) - interval '6 months')::date,
                (date_trunc('month', current_date) + interval '2 months' + interval '14 days')::date,
                'aktiv')
        returning id, ende::text`

      const zeilen = await prognose(t)
      const horizontEnde = zeilen.at(-1)!.periode_ende
      const [soll] = await t<{ betrag: number; letzte: string | null }[]>`
        select coalesce(sum(betrag_eur), 0) as betrag, max(faellig_am)::text as letzte
        from vertrag_zahlungen_bis(${v.id}, ${horizontEnde})`
      assert.ok(Number(soll.betrag) >= 500, 'mindestens eine Vertragszahlung im Horizont')
      assertNah(summe(zeilen, 'aus_vertraegen'), Number(soll.betrag), 'Verträge fließen vollständig ein', 0.01)
      assert.ok(
        soll.letzte !== null && soll.letzte <= v.ende,
        `keine Zahlung nach dem Vertragsende (letzte: ${soll.letzte}, Ende: ${v.ende})`,
      )
    })
  })

  test('USt: erfasste Zeile schlägt die Quoten-Automatik ihres Monats', async () => {
    await withRollback(async (t) => {
      await prognoseLeeren(t)
      const m1 = await folgemonat(t)
      await t`select plan_setzen(${m1}, 'base', 10000, 'test')`

      // Ohne Zeile: Automatik = 8 % vom Planumsatz, fällig im Folgemonat.
      const vorher = await prognose(t)
      assertNah(summe(vorher, 'aus_steuern'), 800, 'USt-Automatik aus der Quote', 0.01)

      await t`insert into steuerzahlungen (art, zeitraum_von, zeitraum_bis, bezeichnung, betrag, faellig_am)
              values ('ust', ${m1}, ((${m1}::date + interval '1 month')::date - 1),
                      'USt Handwert', 123,
                      ((${m1}::date + interval '1 month')::date + 9))`
      const nachher = await prognose(t)
      assertNah(summe(nachher, 'aus_steuern'), 123, 'die erfasste Zeile gilt exklusiv', 0.01)
    })
  })
})
