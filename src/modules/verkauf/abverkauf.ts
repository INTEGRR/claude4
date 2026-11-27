import { sql } from '@/db/client'
import { type Fenster, type TeilRoh, type TeilZeile, abverkaufRang, anteile } from './abverkauf-logik.ts'

/**
 * Abverkauf (0144): der Live-Stand für das Command Center. Nur lesend.
 * Nachfrage sind die Komponentenbuchungen der Fertigungsaufträge zu den
 * Bestellungen (und Lieferungen von Lagerartikeln) — also genau das, was
 * die Stücklisten je bestellter Variante wirklich ziehen. Bestand ist
 * shop_frei(): dieselbe Zahl, mit der die Shop-Verfügbarkeit rechnet.
 */
export interface AbverkaufStand {
  stand: string
  fenster: Fenster
  projekt: string | null
  projekte: string[]
  /** Bestätigte Bestellungen im Zeitfenster. */
  bestellungen: number
  /** Verkaufte Tastaturen im Zeitfenster. */
  stueck: number
  /** Tastaturen je Stunde (letzte 15 Minuten, hochgerechnet). */
  tempo: number
  /** Verkaufte Tastaturen je 5 Minuten, die letzten 60 Minuten (ältester zuerst). */
  verlauf: number[]
  teile: TeilZeile[]
  artikel: { id: string; name: string; menge: number; m15: number; anteil: number }[]
  optionen: { option: string; wert: string; menge: number; anteil: number }[]
  auflagen: {
    id: string
    name: string
    von: number
    bis: number
    vergeben: number
    /** Verkaufte Stück ohne Nummer (warten noch oder Auflage voll). */
    ohneNummer: number
    letzte: { nummer: number; bestellung: string }[]
  }[]
  /** An Shopify geht nur im Modus „schreiben" etwas hinaus. */
  shopify: string
}

const n = (x: unknown) => Number(x ?? 0)

export async function abverkaufStand(fenster: Fenster, projekt: string | null): Promise<AbverkaufStand> {
  const start = sql`case ${fenster}::text
      when 'heute' then date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'
      else now() - make_interval(mins => ${fenster === 'heute' ? 0 : Number(fenster)}) end`
  // Verkaufbare, gefertigte Produkte — der Kreis, um den es am Release-Tag geht.
  const tastaturen = sql`
    select pt.id from product_templates pt
    where pt.active and pt.can_be_sold and pt.route_manufacture
      and (${projekt}::text is null or pt.projekt = ${projekt})`

  const [teile, artikel, optionen, [kopf], verlauf, auflagen, projekte, [modus]] = await Promise.all([
    sql<
      {
        id: string; name: string; sku: string | null; je: number; artikel: number; frei: number; nutzbar: number
        gesperrt: boolean; fehlt: number; fenster: number; m15: number; m60: number
      }[]
    >`
      with teile as (
        select bl.component_variant_id as vid,
               max(bl.qty / nullif(b.qty, 0))::float as je,
               count(distinct b.template_id)::int as artikel
        from boms b
        join bom_lines bl on bl.bom_id = b.id
        where b.active and b.bom_type = 'manufacture' and b.template_id in (${tastaturen})
        group by 1
      ),
      bewegt as (
        -- Was die Bestellungen ziehen: Komponenten der Fertigungsaufträge …
        select m.variant_id as vid, m.qty, so.order_date
        from stock_moves m
        join manufacturing_orders mo on mo.id = m.production_id and mo.state <> 'cancel'
        join sales_orders so on so.id = mo.sales_order_id and so.state = 'sale'
        where m.reference = 'Komponentenverbrauch' and m.state <> 'cancel'
          and so.order_date >= least(${start}, now() - interval '60 minutes')
        union all
        -- … und direkt verkaufte Lagerartikel (Ersatzteil im Shop).
        select m.variant_id, m.qty, so.order_date
        from stock_moves m
        join stock_pickings p on p.id = m.picking_id and p.origin_model = 'sales_order'
        join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
        join sales_orders so on so.id = p.origin_id and so.state = 'sale'
        where m.state <> 'cancel' and so.order_date >= least(${start}, now() - interval '60 minutes')
          and not ist_made_to_order(m.variant_id)
      ),
      nachfrage as (
        select vid,
               coalesce(sum(qty) filter (where order_date >= ${start}), 0)::float as fenster,
               coalesce(sum(qty) filter (where order_date >= now() - interval '15 minutes'), 0)::float as m15,
               coalesce(sum(qty) filter (where order_date >= now() - interval '60 minutes'), 0)::float as m60
        from bewegt group by 1
      ),
      offen as (
        select m.variant_id as vid, sum(m.qty - m.reserved_qty)::float as fehlt
        from stock_moves m
        join stock_locations l on l.id = m.src_location_id and l.type = 'internal'
        where m.state not in ('done', 'cancel', 'draft') and m.qty > m.reserved_qty
          and m.variant_id in (select vid from teile)
          -- nur was Bestellungen fehlt — Fertigung auf Lager ist kein Überverkauf
          and (m.production_id in (select mo.id from manufacturing_orders mo
                                   where mo.sales_order_id is not null and mo.state not in ('done', 'cancel'))
               or m.picking_id in (select p.id from stock_pickings p
                                   join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
                                   where p.origin_model = 'sales_order'))
        group by 1
      )
      select pv.id, coalesce(nullif(pv.display_name, ''), pt.name) as name, nullif(pv.sku, '') as sku,
             t.je, t.artikel,
             free_to_use(pv.id)::float as frei, shop_frei(pv.id)::float as nutzbar,
             pv.shop_zurueckhalten as gesperrt,
             coalesce(o.fehlt, 0) as fehlt,
             coalesce(nf.fenster, 0) as fenster, coalesce(nf.m15, 0) as m15, coalesce(nf.m60, 0) as m60
      from teile t
      join product_variants pv on pv.id = t.vid and pv.active
      join product_templates pt on pt.id = pv.template_id
      left join nachfrage nf on nf.vid = t.vid
      left join offen o on o.vid = t.vid`,
    sql<{ id: string; name: string; menge: number; m15: number }[]>`
      select pt.id, pt.name,
             coalesce(sum(sol.qty) filter (where so.order_date >= ${start}), 0)::float as menge,
             coalesce(sum(sol.qty) filter (where so.order_date >= now() - interval '15 minutes'), 0)::float as m15
      from sales_order_lines sol
      join sales_orders so on so.id = sol.order_id and so.state = 'sale' and not so.historisch
      join product_variants pv on pv.id = sol.variant_id
      join product_templates pt on pt.id = pv.template_id
      where pt.id in (${tastaturen})
        and so.order_date >= least(${start}, now() - interval '15 minutes')
      group by pt.id, pt.name
      having coalesce(sum(sol.qty) filter (where so.order_date >= ${start}), 0) > 0
      order by 3 desc, pt.name
      limit 12`,
    sql<{ option: string; wert: string; menge: number }[]>`
      select pa.name as option, pav.name as wert, sum(sol.qty)::float as menge
      from sales_order_lines sol
      join sales_orders so on so.id = sol.order_id and so.state = 'sale' and not so.historisch
      join product_variants pv on pv.id = sol.variant_id
      join product_variant_attribute_values pvav on pvav.variant_id = pv.id
      join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
      join product_template_attribute_lines al on al.id = ptav.line_id
      join product_attributes pa on pa.id = al.attribute_id
      join product_attribute_values pav on pav.id = ptav.value_id
      where pv.template_id in (${tastaturen}) and so.order_date >= ${start}
      group by 1, 2
      order by 3 desc, 1, 2
      limit 14`,
    sql<{ bestellungen: number; stueck: number; m15: number }[]>`
      select count(distinct so.id) filter (where so.order_date >= ${start})::int as bestellungen,
             coalesce(sum(sol.qty) filter (where so.order_date >= ${start}), 0)::float as stueck,
             coalesce(sum(sol.qty) filter (where so.order_date >= now() - interval '15 minutes'), 0)::float as m15
      from sales_order_lines sol
      join sales_orders so on so.id = sol.order_id and so.state = 'sale' and not so.historisch
      join product_variants pv on pv.id = sol.variant_id
      where pv.template_id in (${tastaturen})
        and so.order_date >= least(${start}, now() - interval '15 minutes')`,
    sql<{ stufe: number; menge: number }[]>`
      select floor(extract(epoch from (now() - so.order_date)) / 300)::int as stufe, sum(sol.qty)::float as menge
      from sales_order_lines sol
      join sales_orders so on so.id = sol.order_id and so.state = 'sale' and not so.historisch
      join product_variants pv on pv.id = sol.variant_id
      where pv.template_id in (${tastaturen}) and so.order_date >= now() - interval '60 minutes'
      group by 1`,
    sql<
      {
        id: string; name: string; von: number; bis: number; vergeben: number; ohne_nummer: number
        letzte: { nummer: number; bestellung: string }[] | null
      }[]
    >`
      select a.id, a.name, a.von, a.bis,
             (select count(*)::int from auflage_nummern x where x.auflage_id = a.id) as vergeben,
             auflage_ohne_nummer(a.id) as ohne_nummer,
             (select jsonb_agg(jsonb_build_object('nummer', l.nummer, 'bestellung', l.bestellung) order by l.nummer desc)
                from (select x.nummer, coalesce(so.shopify_order_name, so.number) as bestellung
                      from auflage_nummern x
                      join sales_order_lines sol on sol.id = x.sales_order_line_id
                      join sales_orders so on so.id = sol.order_id
                      where x.auflage_id = a.id
                      order by x.vergeben_am desc, x.nummer desc limit 4) l) as letzte
      from auflagen a
      where exists (select 1 from product_templates pt where pt.auflage_id = a.id)
      order by a.name`,
    sql<{ projekt: string }[]>`
      select distinct pt.projekt from product_templates pt
      where pt.active and pt.can_be_sold and pt.route_manufacture and pt.projekt is not null
      order by 1`,
    sql<{ modus: string | null }[]>`select value->>'modus' as modus from settings where key = 'shopify'`,
  ])

  const roh: TeilRoh[] = teile.map((t) => ({
    id: t.id, name: t.name, sku: t.sku, je: n(t.je), artikel: t.artikel, frei: n(t.frei), nutzbar: n(t.nutzbar),
    gesperrt: t.gesperrt, fehlt: n(t.fehlt), fenster: n(t.fenster), m15: n(t.m15), m60: n(t.m60),
  }))
  const balken = new Array<number>(12).fill(0)
  for (const v of verlauf) if (v.stufe >= 0 && v.stufe < 12) balken[11 - v.stufe] = n(v.menge)

  return {
    stand: new Date().toISOString(),
    fenster,
    projekt,
    projekte: projekte.map((p) => p.projekt),
    bestellungen: kopf?.bestellungen ?? 0,
    stueck: n(kopf?.stueck),
    tempo: n(kopf?.m15) * 4,
    verlauf: balken,
    teile: abverkaufRang(roh),
    artikel: anteile(artikel.map((a) => ({ id: a.id, name: a.name, menge: n(a.menge), m15: n(a.m15) }))),
    optionen: anteile(optionen.map((o) => ({ option: o.option, wert: o.wert, menge: n(o.menge) }))),
    auflagen: auflagen.map((a) => ({
      id: a.id, name: a.name, von: a.von, bis: a.bis, vergeben: a.vergeben, ohneNummer: a.ohne_nummer,
      letzte: a.letzte ?? [],
    })),
    shopify: modus?.modus ?? 'lesen',
  }
}

/** Kurzer Zwischenspeicher: mehrere offene Bildschirme fragen im selben Takt — die Datenbank rechnet einmal. */
const speicher = new Map<string, { bis: number; wert: Promise<AbverkaufStand> }>()

export function abverkaufStandGepuffert(fenster: Fenster, projekt: string | null): Promise<AbverkaufStand> {
  const schluessel = `${fenster}|${projekt ?? ''}`
  const jetzt = Date.now()
  const treffer = speicher.get(schluessel)
  if (treffer && treffer.bis > jetzt) return treffer.wert
  const wert = abverkaufStand(fenster, projekt)
  speicher.set(schluessel, { bis: jetzt + 2500, wert })
  wert.catch(() => speicher.delete(schluessel))
  if (speicher.size > 40) for (const [k, v] of speicher) if (v.bis <= jetzt) speicher.delete(k)
  return wert
}
