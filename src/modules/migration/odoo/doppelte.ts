/**
 * Doppelte Artikel zusammenführen (Entscheidungslog 2026-09-30, „Doppelte
 * Artikel zusammenführen").
 *
 * Die Odoo-Übernahme legt Komponenten, die sie per SKU nicht findet, neu an.
 * Manche davon gibt es schon als Shop-Artikel mit anderer SKU und anderem
 * Namen (GATERON-Switches SH00000115 = Odoo SW-GT-LY-001). Beides ist
 * dasselbe Einzelteil. Zusammengeführt wird immer IN den Shop-Artikel (er
 * trägt die Shopify-Kopplung und die Verkaufshistorie); die Odoo-Kopie wird
 * aufgelöst:
 *
 *   - offene Bewegungen (z. B. Komponenten laufender Fertigungsaufträge) und
 *     Stücklistenzeilen aktiver Stücklisten zeigen danach auf den Shop-Artikel,
 *   - Bestand je Lagerort wandert per Inventurzählung (bewertet), Preis
 *     vorher, nur wo der Shop-Artikel 0 hat,
 *   - Lieferantenpreise, Meldebestand und Odoo-Zuordnung (odoo_verweise)
 *     ziehen mit — die nächste Übernahme erkennt das Teil als Shop-Artikel,
 *   - SKU der Odoo-Kopie geht an den Shop-Artikel (als SKU, wenn er keine
 *     hat, sonst als Barcode) — Odoo-Etiketten im Lager bleiben scanbar,
 *   - die Odoo-Kopie wird archiviert, nicht gelöscht.
 *
 * Hart statt still: nur Artikel, die die Übernahme selbst ANGELEGT hat und
 * die keine Belege haben (Verkauf, Einkauf, Fertigung, Reparatur, Chargen)
 * und deren Bestand nur aus Übernahme-Zählungen stammt; Ziel ist ein
 * Shop-Artikel ohne eigene Stückliste in derselben Einheit.
 */
import { sql, tx } from '@/db/client'
import type { TransactionSql } from 'postgres'
import { vorschlagen } from './doppelte-vorschlag.ts'

export interface ZusammenfuehrenZeile {
  id: string
  sku: string | null
  name: string
  bestand: number
  inStuecklisten: number
  vorschlag: string | null
}

export interface ShopArtikel {
  id: string
  sku: string | null
  name: string
}

/** Aus Odoo angelegte Komponenten und Shop-Artikel, die dasselbe Teil sein könnten. */
export async function zusammenfuehrenKandidaten(): Promise<{ links: ZusammenfuehrenZeile[]; rechts: ShopArtikel[] }> {
  const [links, rechts] = await Promise.all([
    sql<{ id: string; sku: string | null; name: string; bestand: number; in_stl: number }[]>`
      select pv.id, pv.sku, pv.display_name as name,
             on_hand_qty(pv.id, null)::float as bestand,
             (select count(*)::int from bom_lines bl join boms b on b.id = bl.bom_id and b.active
               where bl.component_variant_id = pv.id) as in_stl
      from odoo_verweise v
      join product_variants pv on pv.id = v.krnl_id and pv.active
      where v.krnl_tabelle = 'product_variants' and v.herkunft = 'angelegt'
      order by pv.display_name`,
    sql<ShopArtikel[]>`
      select pv.id, nullif(pv.sku, '') as sku, pv.display_name as name
      from product_variants pv
      join product_templates pt on pt.id = pv.template_id
      where pv.active and pv.shopify_variant_id is not null and pt.type = 'goods'
        and not exists (select 1 from boms b where b.template_id = pt.id and b.active)
        and not exists (select 1 from odoo_verweise v where v.krnl_id = pv.id)
      order by pv.display_name`,
  ])
  const vorschlag = vorschlagen(links, rechts)
  return {
    links: links
      .map((l) => ({
        id: l.id,
        sku: l.sku,
        name: l.name,
        bestand: Number(l.bestand),
        inStuecklisten: l.in_stl,
        vorschlag: vorschlag.get(l.id) ?? null,
      }))
      .sort((a, b) => Number(b.vorschlag !== null) - Number(a.vorschlag !== null)),
    rechts,
  }
}

export interface ZusammenfuehrenBericht {
  von: string
  nach: string
  bestand: number
  stuecklistenzeilen: number
  offeneBewegungen: number
  lieferantenpreise: number
  preisUebernommen: boolean
  sku: 'sku' | 'barcode' | null
}

type Artikel = {
  id: string
  template_id: string
  sku: string | null
  barcode: string | null
  name: string
  uom_id: string
  standard_cost: number
  weight_g: number
  route_buy: boolean
  shopify: boolean
}

async function artikel(t: TransactionSql, id: string): Promise<Artikel | null> {
  const [a] = await t<Artikel[]>`
    select pv.id, pv.template_id, nullif(pv.sku, '') as sku, pv.barcode, pv.display_name as name,
           pt.uom_id, pt.standard_cost::float as standard_cost, pt.weight_g, pt.route_buy,
           pv.shopify_variant_id is not null as shopify
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${id} and pv.active
    for update of pv`
  return a ?? null
}

export async function artikelZusammenfuehren(
  aufloesenId: string,
  behaltenId: string,
  von: string,
): Promise<ZusammenfuehrenBericht> {
  if (aufloesenId === behaltenId) throw new Error('Ein Artikel lässt sich nicht mit sich selbst zusammenführen.')
  return tx(async (t) => {
    const a = await artikel(t, aufloesenId)
    const b = await artikel(t, behaltenId)
    if (!a || !b) throw new Error('Artikel nicht gefunden oder archiviert.')

    // --- Prüfungen: hart statt still -----------------------------------------
    const [pruef] = await t<{ angelegt: boolean; b_odoo: boolean; b_stueckliste: boolean; belege: string | null; fremd: number }[]>`
      select
        exists (select 1 from odoo_verweise where krnl_tabelle = 'product_variants' and krnl_id = ${a.id}
                and herkunft = 'angelegt') as angelegt,
        exists (select 1 from odoo_verweise where krnl_id = ${b.id}) as b_odoo,
        exists (select 1 from boms where template_id = ${b.template_id} and active) as b_stueckliste,
        concat_ws(', ',
          case when exists (select 1 from sales_order_lines where variant_id = ${a.id}) then 'Verkauf' end,
          case when exists (select 1 from purchase_order_lines where variant_id = ${a.id}) then 'Einkauf' end,
          case when exists (select 1 from manufacturing_orders where variant_id = ${a.id}) then 'Fertigung' end,
          case when exists (select 1 from repair_parts where variant_id = ${a.id}) then 'Reparatur' end,
          case when exists (select 1 from stock_lots where variant_id = ${a.id}) then 'Chargen' end) as belege,
        (select count(*)::int from stock_moves m left join inventory_counts ic on ic.id = m.inventory_id
          where m.variant_id = ${a.id} and m.state = 'done'
            and (ic.id is null or ic.note is null or ic.note not like 'Odoo-Übernahme%')) as fremd`
    if (!pruef.angelegt) throw new Error(`${a.name}: nur Artikel, die die Odoo-Übernahme angelegt hat, lassen sich auflösen.`)
    if (!b.shopify) throw new Error(`${b.name}: Ziel muss ein Shop-Artikel sein.`)
    if (pruef.b_odoo) throw new Error(`${b.name} ist schon einem Odoo-Artikel zugeordnet.`)
    if (pruef.b_stueckliste) throw new Error(`${b.name} hat eine eigene Stückliste — das ist kein Einzelteil.`)
    if (pruef.belege) throw new Error(`${a.name} hat Belege (${pruef.belege}) — Zusammenführen nicht möglich.`)
    if (pruef.fremd > 0) throw new Error(`${a.name} hat Lagerbuchungen außerhalb der Odoo-Übernahme — bitte erst prüfen.`)
    if (a.uom_id !== b.uom_id) throw new Error(`${a.name} und ${b.name} haben verschiedene Einheiten.`)

    const bericht: ZusammenfuehrenBericht = {
      von: a.sku ?? a.name, nach: b.name, bestand: 0, stuecklistenzeilen: 0, offeneBewegungen: 0,
      lieferantenpreise: 0, preisUebernommen: false, sku: null,
    }

    // --- Stammdaten: Preis vor Bestand (bewertet), nur wo der Shop-Artikel 0 hat.
    if (a.standard_cost > 0) {
      const preis = await t`
        update product_templates set standard_cost = ${a.standard_cost}
        where id = ${b.template_id} and standard_cost <= 0`
      bericht.preisUebernommen = preis.count > 0
    }
    await t`
      update product_templates set
        can_be_purchased = true,
        route_buy = route_buy or ${a.route_buy},
        weight_g = case when weight_g > 0 then weight_g else ${a.weight_g} end
      where id = ${b.template_id}`

    // --- Offene Bewegungen (Komponenten laufender Fertigungsaufträge, Transfers).
    const offen = await t<{ id: string; picking_id: string | null }[]>`
      select id, picking_id from stock_moves
      where variant_id = ${a.id} and state not in ('done', 'cancel')`
    for (const m of offen) {
      await t`select move_unreserve(${m.id})`
      await t`update stock_moves set variant_id = ${b.id},
                state = case when state = 'assigned' then 'confirmed'::move_state else state end
              where id = ${m.id}`
    }
    for (const p of new Set(offen.map((m) => m.picking_id).filter((x): x is string => x !== null))) {
      await t`select picking_recompute_state(${p})`
    }
    bericht.offeneBewegungen = offen.length

    // --- Bestand je Lagerort: Odoo-Kopie auf 0, Shop-Artikel um dieselbe Menge rauf.
    const orte = await t<{ location_id: string; menge: number }[]>`
      select q.location_id, q.on_hand::float as menge
      from stock_quants q join stock_locations l on l.id = q.location_id and l.type = 'internal'
      where q.variant_id = ${a.id} and q.on_hand > 0`
    for (const o of orte) {
      const [ab] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
        values (${o.location_id}, ${a.id}, 0, ${o.menge}, ${`Zusammengeführt in ${b.name}`}) returning id`
      await t`select inventory_apply(${ab.id}, ${von})`
      const [ist] = await t<{ menge: number }[]>`
        select coalesce(sum(on_hand), 0)::float as menge from stock_quants
        where variant_id = ${b.id} and location_id = ${o.location_id}`
      const [zu] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
        values (${o.location_id}, ${b.id}, ${Number(ist.menge) + o.menge}, ${ist.menge},
                ${`Odoo-Übernahme: zusammengeführt aus ${a.sku ?? a.name}`}) returning id`
      await t`select inventory_apply(${zu.id}, ${von})`
      bericht.bestand += o.menge
    }

    // --- Stücklisten, Lieferantenpreise, Meldebestand, Odoo-Zuordnung.
    const zeilen = await t`
      update bom_lines set component_variant_id = ${b.id}
      where component_variant_id = ${a.id} and bom_id in (select id from boms where active)`
    bericht.stuecklistenzeilen = zeilen.count
    const preise = await t`
      update vendor_prices set template_id = ${b.template_id}, variant_id = ${b.id}
      where variant_id = ${a.id}
         or (variant_id is null and template_id = ${a.template_id}
             and not exists (select 1 from product_variants x
                             where x.template_id = ${a.template_id} and x.id <> ${a.id} and x.active))`
    bericht.lieferantenpreise = preise.count
    await t`
      update stock_orderpoints set variant_id = ${b.id}
      where variant_id = ${a.id}
        and not exists (select 1 from stock_orderpoints o2
                        where o2.variant_id = ${b.id} and o2.location_id = stock_orderpoints.location_id)`
    await t`
      update odoo_verweise set krnl_id = ${b.id}, herkunft = 'zugeordnet'
      where krnl_tabelle = 'product_variants' and krnl_id = ${a.id}`

    // --- SKU weitergeben (Odoo-Etiketten bleiben scanbar), dann archivieren.
    if (a.sku) {
      await t`update product_variants set sku = null where id = ${a.id}`
      if (!b.sku) {
        await t`update product_variants set sku = ${a.sku} where id = ${b.id}`
        bericht.sku = 'sku'
      } else if (!b.barcode) {
        await t`update product_variants set barcode = ${a.sku} where id = ${b.id}`
        bericht.sku = 'barcode'
      }
    }
    await t`update product_variants set active = false where id = ${a.id}`
    await t`
      update product_templates set active = false
      where id = ${a.template_id}
        and not exists (select 1 from product_variants where template_id = ${a.template_id} and active)`

    await t`select log_event('odoo', gen_random_uuid(), 'note',
      ${`Artikel zusammengeführt: ${a.sku ?? a.name} → ${b.name} (${bericht.bestand} Stück, ` +
        `${bericht.stuecklistenzeilen} Stücklistenzeile(n), ${bericht.offeneBewegungen} offene Bewegung(en))`},
      ${von})`
    return bericht
  })
}
