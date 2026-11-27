import { sql } from '@/db/client'
import { type AnlageLuecke, anlageLuecken } from '@/modules/shared/anlage-luecken'

/**
 * Shop-Produkte, deren Anlage unvollständig ist (A6): mit Shopify verknüpft
 * oder verkaufbar mit Shop-Projekt, aber ohne Route, Stückliste oder
 * Artikelnummern. Die Shop-Verfügbarkeit zeigt die Liste über allem.
 */
export interface ProduktMitLuecken {
  id: string
  name: string
  luecken: AnlageLuecke[]
}

export async function shopProdukteMitLuecken(): Promise<ProduktMitLuecken[]> {
  const zeilen = await sql<
    {
      id: string
      name: string
      route_buy: boolean
      route_manufacture: boolean
      stuecklisten: number
      positionen: number
      ohne_sku: number
      varianten: number
    }[]
  >`
    select pt.id, pt.name, pt.route_buy, pt.route_manufacture,
           (select count(*) from boms b where b.template_id = pt.id and b.active)::int as stuecklisten,
           (select count(*) from bom_lines l join boms b on b.id = l.bom_id
             where b.template_id = pt.id and b.active)::int as positionen,
           count(*) filter (where pv.sku is null)::int as ohne_sku,
           count(*)::int as varianten
    from product_templates pt
    join product_variants pv on pv.template_id = pt.id and pv.active
    where pt.active
    group by pt.id
    having bool_or(pv.shopify_variant_id is not null)
    order by pt.name`
  return zeilen
    .map((z) => ({ id: z.id, name: z.name, luecken: anlageLuecken(z) }))
    .filter((z) => z.luecken.length > 0)
}
