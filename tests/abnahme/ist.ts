/**
 * Abnahmetest — der IST-Stand aus der Datenbank, in derselben Form wie der
 * SOLL-Stand des Modells (modell.ts). Gelesen wird ausschließlich über die
 * Funktionen und Sichten, die auch die Oberfläche benutzt (on_hand_qty,
 * free_to_use, baubar, shopify_soll_menge, sales_order_total,
 * vendor_bill_offen, finanz_saldo, finanz_faellig, mv_contribution_margin).
 */
import type { Sql } from 'postgres'
import type { BestandZeile, Stand } from './modell.ts'
import { BANKKONTO, type Datum, PRODUKTE, type Sku } from './szenario.ts'

export interface Kennungen {
  /** Varianten-ID je SKU. */
  varianten: Record<Sku, string>
}

const r = (x: number | string | null, stellen: number) => {
  const n = Number(x ?? 0)
  const f = 10 ** stellen
  return Math.round(Math.abs(n) * f + 1e-7) / f * (n < 0 ? -1 : 1)
}

function zaehlung(zeilen: { schluessel: string; n: number | string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const z of zeilen) out[z.schluessel] = Number(z.n)
  return out
}

export async function istStandLesen(sql: Sql, k: Kennungen, faelligBis: Datum): Promise<Stand> {
  const bestand = {} as Record<Sku, BestandZeile>
  for (const p of PRODUKTE) {
    const id = k.varianten[p.sku]
    const [z] = await sql<
      { on_hand: number; frei: number; bewertet: number; wert: number; mac: number }[]
    >`
      select on_hand_qty(${id}) as on_hand, free_to_use(${id}) as frei,
             pv.valued_qty as bewertet, pv.valuation_total as wert, pv.moving_avg_cost as mac
      from product_variants pv where pv.id = ${id}`
    bestand[p.sku] = {
      on_hand: Number(z.on_hand),
      reserviert: Number(z.on_hand) - Number(z.frei),
      frei: Number(z.frei),
      bewertet: Number(z.bewertet),
      wert: r(z.wert, 4),
      mac: r(z.mac, 6),
    }
  }
  const [{ lagerwert }] = await sql<{ lagerwert: number }[]>`
    select coalesce(sum(valuation_total), 0) as lagerwert from product_variants`
  const [{ baubar }] = await sql<{ baubar: number }[]>`
    select b.menge as baubar from baubar(${k.varianten['KB-65']}, 0, true) b`

  const soll: Record<string, number> = {}
  const gemeldet: Record<string, number | null> = {}
  for (const p of PRODUKTE) {
    if (!p.shopify) continue
    const [z] = await sql<{ soll: number; gemeldet: number | null }[]>`
      select shopify_soll_menge(${k.varianten[p.sku]}) as soll,
             (select s.pushed_qty from shopify_inventory_state s where s.variant_id = ${k.varianten[p.sku]}) as gemeldet`
    soll[p.sku] = Number(z.soll)
    gemeldet[p.sku] = z.gemeldet === null ? null : Number(z.gemeldet)
  }
  const [mto] = await sql<{ eingerichtet: boolean }[]>`
    select coalesce((select mto_eingerichtet_at is not null from shopify_inventory_state
                     where variant_id = ${k.varianten['KB-65']}), false) as eingerichtet`
  const [{ fulfillments }] = await sql<{ fulfillments: number }[]>`
    select count(*)::int as fulfillments from shipments where shopify_fulfillment_id is not null`

  const belege = {
    auftraege: zaehlung(await sql`select state::text as schluessel, count(*)::int as n from sales_orders group by 1`),
    bestellungen: zaehlung(await sql`select state::text as schluessel, count(*)::int as n from purchase_orders group by 1`),
    fertigungsauftraege: zaehlung(await sql`select state::text as schluessel, count(*)::int as n from manufacturing_orders group by 1`),
    lieferungen: zaehlung(await sql`
      select p.state::text as schluessel, count(*)::int as n
      from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
      where ot.kind = 'delivery' group by 1`),
    wareneingaenge: zaehlung(await sql`
      select p.state::text as schluessel, count(*)::int as n
      from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
      where ot.kind = 'receipt' group by 1`),
    rechnungen: zaehlung(await sql`select state::text as schluessel, count(*)::int as n from vendor_bills group by 1`),
    demontagen: Number((await sql<{ n: number }[]>`select count(*)::int as n from unbuild_orders where state = 'done'`)[0].n),
  }

  const umsatzZeilen = await sql<{ monat: string; quelle: string; net: number; tax: number; gross: number }[]>`
    select to_char(so.order_date, 'YYYY-MM') as monat, so.source::text as quelle, t.net, t.tax, t.gross
    from sales_orders so, sales_order_total(so.id) t
    where so.state = 'sale' order by so.order_date`
  const jeMonat: Stand['umsatz']['je_monat'] = {}
  let shopBrutto = 0
  let b2bNetto = 0
  for (const z of umsatzZeilen) {
    const m = (jeMonat[z.monat] ??= { netto: 0, steuer: 0, brutto: 0, auftraege: 0 })
    m.netto = r(m.netto + Number(z.net), 2)
    m.steuer = r(m.steuer + Number(z.tax), 2)
    m.brutto = r(m.brutto + Number(z.gross), 2)
    m.auftraege++
    if (z.quelle === 'shopify') shopBrutto = r(shopBrutto + Number(z.gross), 2)
    else b2bNetto = r(b2bNetto + Number(z.net), 2)
  }

  const [f] = await sql<{ material: number; lohn: number; stueck: number }[]>`
    select coalesce(sum(material_cost), 0) as material, coalesce(sum(labor_cost), 0) as lohn,
           coalesce(sum(qty_produced), 0) as stueck
    from manufacturing_orders where state = 'done'`

  const zahlungenZeilen = await sql<{ monat: string; richtung: 'ein' | 'aus'; summe: number; n: number }[]>`
    select to_char(gezahlt_am, 'YYYY-MM') as monat, richtung, sum(betrag_eur) as summe, count(*)::int as n
    from zahlungen where storniert_am is null group by 1, 2 order by 1`
  const zahlungenJeMonat: Stand['zahlungen']['je_monat'] = {}
  for (const z of zahlungenZeilen) {
    const m = (zahlungenJeMonat[z.monat] ??= { ein: 0, aus: 0, anzahl: 0 })
    m[z.richtung] = r(Number(z.summe), 2)
    m.anzahl += Number(z.n)
  }
  const saldo: Record<string, number> = {}
  for (const z of await sql<{ name: string; saldo: number }[]>`select name, saldo from finanz_saldo()`) {
    saldo[z.name] = r(z.saldo, 2)
  }
  saldo[BANKKONTO] ??= 0

  const [v] = await sql<{ offen: number; rechnungen: number }[]>`
    select coalesce(sum(vendor_bill_offen(id)), 0) as offen,
           count(*) filter (where vendor_bill_offen(id) > 0)::int as rechnungen
    from vendor_bills where state = 'posted'`

  const faellig: Stand['faellig'] = {}
  for (const z of await sql<{ quelle: string; n: number; summe: number }[]>`
    select quelle, count(*)::int as n, sum(betrag_eur) as summe
    from finanz_faellig(${faelligBis}::date) group by 1`) {
    faellig[z.quelle] = { anzahl: Number(z.n), summe: r(z.summe, 2) }
  }

  const vertraege: Stand['vertraege'] = {}
  for (const z of await sql<{ name: string; status: string; ende: string | null; gezahlt: number }[]>`
    select v.name, v.status::text as status, v.gekuendigt_zum::text as ende,
           coalesce((select sum(z.betrag_eur) from zahlungen z where z.vertrag_id = v.id and z.storniert_am is null), 0) as gezahlt
    from vertraege v`) {
    vertraege[z.name] = { status: z.status, ende: z.ende, gezahlt: r(z.gezahlt, 2) }
  }

  const [d] = await sql<
    { status: string; restschuld: number; bezahlte_raten: number; naechste: string | null; annuitaet: number }[]
  >`
    select d.status::text as status,
           coalesce((select r.restschuld from darlehen_raten r where r.darlehen_id = d.id and r.bezahlt_am is not null
                     order by r.nr desc limit 1), d.betrag) as restschuld,
           (select count(*)::int from darlehen_raten r where r.darlehen_id = d.id and r.bezahlt_am is not null) as bezahlte_raten,
           (select min(r.faellig_am)::text from darlehen_raten r where r.darlehen_id = d.id and r.bezahlt_am is null) as naechste,
           (select r.zins + r.tilgung from darlehen_raten r where r.darlehen_id = d.id and r.nr = 1) as annuitaet
    from darlehen d order by d.created_at limit 1`
  const darlehen = d
    ? { status: d.status, restschuld: r(d.restschuld, 2), bezahlte_raten: Number(d.bezahlte_raten), naechste: d.naechste, annuitaet: r(d.annuitaet, 2) }
    : { status: 'keins', restschuld: 0, bezahlte_raten: 0, naechste: null, annuitaet: 0 }

  const [st] = await sql<{ offen: number; bezahlt: number }[]>`
    select coalesce(sum(betrag) filter (where bezahlt_am is null), 0) as offen,
           coalesce(sum(betrag) filter (where bezahlt_am is not null), 0) as bezahlt
    from steuerzahlungen`

  const [db] = await sql<{ umsatz: number; einsatz: number }[]>`
    select coalesce(sum(revenue), 0) as umsatz, coalesce(sum(cost), 0) as einsatz from mv_contribution_margin`

  return {
    bestand,
    lagerwert: r(lagerwert, 4),
    baubar: Number(baubar),
    shopify: { soll, gemeldet, mto_eingerichtet: Boolean(mto.eingerichtet), fulfillments: Number(fulfillments) },
    belege,
    umsatz: { je_monat: jeMonat, shop_brutto: shopBrutto, b2b_netto: b2bNetto },
    fertigung: { material: r(f.material, 4), lohn: r(f.lohn, 4), stueck: Number(f.stueck) },
    zahlungen: { je_monat: zahlungenJeMonat, saldo },
    verbindlichkeiten: { offen: r(v.offen, 2), rechnungen: Number(v.rechnungen) },
    faellig,
    vertraege,
    darlehen,
    steuern: { offen: r(st.offen, 2), bezahlt: r(st.bezahlt, 2) },
    deckungsbeitrag: { umsatz: r(db.umsatz, 4), einsatz: r(db.einsatz, 4) },
  }
}
