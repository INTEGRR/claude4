import { sql } from '@/db/client'
import { shopifyGraphQL } from './shopify'
import { inGramm, type ShopifyGewicht } from './gewichte-logik'

/**
 * Gewichte aus Shopify übernehmen (Entscheidungslog 2026-10-01): der
 * Produktimport hat keine Gewichte geholt — ohne sie rechnet der Versand mit
 * 0 g (falsches DHL-Produkt, falsches Paketgewicht). Liest je Shop-Variante
 * das Gewicht (reine Abfrage, geht auch im Modus „nur lesen" und im
 * Probelauf) und setzt es am Artikel, wo KRNL noch keines führt. Gepflegte
 * Gewichte bleiben, außer `ueberschreiben`.
 */
export interface GewichteErgebnis {
  gelesen: number
  gesetzt: number
  ohneGewichtImShop: number
  schonGepflegt: number
}

export async function gewichteAusShopify(ueberschreiben = false): Promise<GewichteErgebnis> {
  const ergebnis: GewichteErgebnis = { gelesen: 0, gesetzt: 0, ohneGewichtImShop: 0, schonGepflegt: 0 }
  let after: string | null = null
  for (let seite = 0; seite < 40; seite++) {
    const data: {
      productVariants: {
        nodes: { id: string; inventoryItem: { measurement: { weight: ShopifyGewicht | null } | null } | null }[]
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } = await shopifyGraphQL(
      `query gewichte($after: String) {
         productVariants(first: 250, after: $after) {
           nodes { id inventoryItem { measurement { weight { unit value } } } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { after },
    )
    for (const n of data.productVariants.nodes) {
      const gramm = inGramm(n.inventoryItem?.measurement?.weight)
      const [artikel] = await sql<{ template_id: string; weight_g: number | null }[]>`
        select pt.id as template_id, pt.weight_g
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.shopify_variant_id = ${n.id}`
      if (!artikel) continue
      ergebnis.gelesen++
      if (gramm === null) {
        ergebnis.ohneGewichtImShop++
        continue
      }
      if (!ueberschreiben && Number(artikel.weight_g ?? 0) > 0) {
        ergebnis.schonGepflegt++
        continue
      }
      await sql`update product_templates set weight_g = ${gramm} where id = ${artikel.template_id}`
      ergebnis.gesetzt++
    }
    if (!data.productVariants.pageInfo.hasNextPage) break
    after = data.productVariants.pageInfo.endCursor
  }
  return ergebnis
}
