import { sql } from '@/db/client'
import { type BestandZeile, einordnen } from './bestandsliste-logik'

/**
 * Bestandsabgleich, vollständig (Entscheidungslog 2026-11-28): je
 * Shop-Angebot, was KRNL melden würde und was der Shop gerade zeigt — alle
 * verknüpften Varianten und Zweitangebote, nicht nur die Abweichungen. Nur
 * lesend. „KRNL meldet" ist dasselbe Ziel wie beim Abgleich
 * (`kontingent`, sonst `shopify_soll_menge`), der Shop-Stand der zuletzt
 * gelesene (viertelstündlich und von Hand).
 */

export type { BestandZeile, Einordnung } from './bestandsliste-logik'

interface Roh {
  variant_id: string
  template_id: string
  produkt: string
  variante: string
  sku: string | null
  mto: boolean
  zweitangebot: boolean
  status: string | null
  shop: number | null
  verkaufbar: boolean | null
  policy: string | null
  tracked: boolean | null
  krnl: number
  grund: string
}

export async function bestandsliste(): Promise<{ zeilen: BestandZeile[]; gelesen: string | null }> {
  const roh = await sql<Roh[]>`
    with v as (
      select pv.id, pv.template_id, pt.name as produkt, pv.display_name, pv.sku,
             ist_made_to_order(pv.id) as mto, shop_modus_von(pv.id) as modus,
             exists (select 1 from shop_option_sperren sp
                     join product_variant_attribute_values a on a.variant_id = pv.id and a.ptav_id = sp.ptav_id
                     where sp.template_id = pv.template_id) as gesperrt,
             s.shop_qty, s.shop_verkaufbar, s.shop_policy, s.shop_tracked, s.shop_status,
             coalesce(s.kontingent, shopify_soll_menge(pv.id)) as krnl,
             pv.shop_nicht_einzeln, pv.shop_zurueckhalten, pv.shop_rueckhalt, pv.shop_hoechstmenge, pv.shop_oos_unter
      from product_variants pv
      join product_templates pt on pt.id = pv.template_id
      left join shopify_inventory_state s on s.variant_id = pv.id
      where pv.shopify_variant_id is not null and pv.active
    )
    select v.id as variant_id, v.template_id, v.produkt,
           coalesce(nullif(regexp_replace(v.display_name, '^.*\\(([^()]*)\\)\\s*$', '\\1'), v.display_name), '') as variante,
           nullif(v.sku, '') as sku, v.mto, false as zweitangebot,
           v.shop_status as status, v.shop_qty::float as shop, v.shop_verkaufbar as verkaufbar,
           v.shop_policy as policy, v.shop_tracked as tracked, v.krnl::float as krnl,
           case when v.modus = 'aus' then 'steht in KRNL auf „aus"'
                when v.modus = 'immer' then 'steht in KRNL auf „immer verfügbar"'
                when v.gesperrt then 'Option gesperrt'
                when not v.mto and v.shop_nicht_einzeln then 'nicht einzeln verkaufen'
                when not v.mto and v.shop_zurueckhalten then 'für den Shop gesperrt'
                when not v.mto then 'frei ' || round(free_to_use(v.id))::int
                  || coalesce(', Rückhalt ' || v.shop_rueckhalt::int, '')
                  || coalesce(', höchstens ' || v.shop_hoechstmenge, '')
                  || coalesce(', aus unter ' || v.shop_oos_unter, '')
                else coalesce((select 'baubar ' || b.menge::int
                                 || coalesce(' — Engpass ' || coalesce(nullif(e.sku, ''), et.name), '')
                               from baubar(v.id, 0, true) b
                               left join product_variants e on e.id = b.engpass
                               left join product_templates et on et.id = e.template_id), 'keine Stückliste')
           end as grund
    from v
    union all
    select pv.id, pv.template_id, coalesce(z.produkt, 'Zweitangebot') as produkt,
           coalesce(nullif(z.sku, ''), pv.display_name) as variante, coalesce(nullif(z.sku, ''), nullif(pv.sku, '')) as sku,
           ist_made_to_order(pv.id) as mto, true as zweitangebot,
           null as status, z.shop_qty::float as shop, z.shop_verkaufbar as verkaufbar, null as policy, null as tracked,
           coalesce(z.kontingent, shopify_soll_menge_zweitangebot(z.id))::float as krnl,
           case when z.shop_modus = 'aus' or shop_modus_von(pv.id) = 'aus' then 'steht in KRNL auf „aus"'
                when z.shop_modus = 'immer' then 'steht in KRNL auf „immer verfügbar"'
                else 'wie ' || pv.display_name end as grund
    from shopify_zweitangebote z
    join product_variants pv on pv.id = z.variant_id and pv.active
    where not exists (select 1 from product_variants x where x.shopify_variant_id = z.shopify_variant_id)
    order by produkt, variante`

  const [stand] = await sql<{ gelesen: string | null }[]>`
    select max(shop_seen_at)::text as gelesen from shopify_inventory_state`

  const zeilen = roh.map((r): BestandZeile => {
    const shop = r.shop === null ? null : Math.round(Number(r.shop))
    const krnl = Math.max(Math.floor(Number(r.krnl)), 0)
    const sichtbar = r.status !== 'DRAFT' && r.status !== 'ARCHIVED'
    const ohneBestand = r.policy === 'CONTINUE' || r.tracked === false
    const shopKaufbar = sichtbar && (r.verkaufbar ?? (ohneBestand || (shop ?? 0) > 0))
    return {
      variant_id: r.variant_id, template_id: r.template_id, produkt: r.produkt, variante: r.variante, sku: r.sku,
      mto: r.mto, zweitangebot: r.zweitangebot, status: r.status, shop, shopKaufbar, ohneBestand, krnl, grund: r.grund,
      einordnung: einordnen({ status: r.status, shopKaufbar, shop, krnl, mto: r.mto, ohneBestand }),
    }
  })
  return { zeilen, gelesen: stand?.gelesen ?? null }
}
