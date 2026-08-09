import { sql } from '@/db/client'
import { ShopifyError, shopifyGraphQL } from './shopify'

/**
 * Legt ein ERP-Produkt samt Varianten in Shopify an und verknüpft beide
 * Seiten (shopify_variant_id + InventoryItem). Danach übernimmt der
 * Bestandsabgleich die Mengen automatisch.
 *
 * Bewusst ein Knopf je Produkt und kein Automatismus: nicht alles im ERP
 * gehört in den Shop — Komponenten, Schrauben und Verpackung sollen dort
 * nie auftauchen.
 */

interface VarianteZeile {
  id: string
  sku: string | null
  barcode: string | null
  price_extra: number
  display_name: string
  shopify_variant_id: string | null
}

export interface ProduktPushErgebnis {
  produktGid: string
  varianten: number
}

export async function pushProduktZuShopify(templateId: string): Promise<ProduktPushErgebnis> {
  const [tpl] = await sql<
    { name: string; list_price: number; description_sale: string | null; can_be_sold: boolean }[]
  >`select name, list_price, description_sale, can_be_sold
    from product_templates where id = ${templateId}`
  if (!tpl) throw new ShopifyError('Produkt nicht gefunden', false)
  if (!tpl.can_be_sold) {
    throw new ShopifyError('Dieses Produkt ist als „nicht verkäuflich" markiert — nichts für den Shop.', false)
  }

  const varianten = await sql<VarianteZeile[]>`
    select id, sku, barcode, price_extra, display_name, shopify_variant_id
    from product_variants where template_id = ${templateId} and active
    order by display_name`
  if (varianten.length === 0) throw new ShopifyError('Produkt hat keine aktiven Varianten', false)
  if (varianten.some((v) => v.shopify_variant_id)) {
    throw new ShopifyError(
      'Mindestens eine Variante ist schon mit Shopify verknüpft — dieses Produkt existiert dort bereits.',
      false,
    )
  }
  const ohneSku = varianten.filter((v) => !v.sku)
  if (ohneSku.length > 0) {
    throw new ShopifyError(
      `Ohne SKU keine eindeutige Zuordnung: ${ohneSku.map((v) => v.display_name).join(', ')} — erst SKUs vergeben.`,
      false,
    )
  }

  // Attribute + Werte je Variante (für optionValues) und je Attribut (für productOptions).
  const werte = await sql<{ variant_id: string; attribut: string; wert: string }[]>`
    select pvav.variant_id, a.name as attribut, av.name as wert
    from product_variant_attribute_values pvav
    join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
    join product_template_attribute_lines l on l.id = ptav.line_id
    join product_attributes a on a.id = l.attribute_id
    join product_attribute_values av on av.id = ptav.value_id
    join product_variants pv on pv.id = pvav.variant_id
    where pv.template_id = ${templateId}
    order by a.name, av.name`

  const optionen = new Map<string, Set<string>>()
  const jeVariante = new Map<string, { attribut: string; wert: string }[]>()
  for (const w of werte) {
    if (!optionen.has(w.attribut)) optionen.set(w.attribut, new Set())
    optionen.get(w.attribut)!.add(w.wert)
    if (!jeVariante.has(w.variant_id)) jeVariante.set(w.variant_id, [])
    jeVariante.get(w.variant_id)!.push({ attribut: w.attribut, wert: w.wert })
  }

  // 1) Produkt anlegen. Mit productOptions entsteht genau eine Standard-
  //    variante, die der Bulk-Create unten wieder entfernt.
  const create = await shopifyGraphQL<{
    productCreate: {
      product: { id: string; variants: { nodes: { id: string; inventoryItem: { id: string } }[] } } | null
      userErrors: { message: string }[]
    }
  }>(
    `mutation produktAnlegen($product: ProductCreateInput!) {
       productCreate(product: $product) {
         product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
         userErrors { message }
       }
     }`,
    {
      product: {
        title: tpl.name,
        status: 'ACTIVE',
        ...(tpl.description_sale ? { descriptionHtml: tpl.description_sale } : {}),
        ...(optionen.size > 0
          ? {
              productOptions: [...optionen.entries()].map(([name, values]) => ({
                name,
                values: [...values].map((v) => ({ name: v })),
              })),
            }
          : {}),
      },
    },
  )
  const fehler = create.productCreate.userErrors
  if (fehler.length || !create.productCreate.product) {
    throw new ShopifyError(
      `Shopify lehnt das Produkt ab: ${fehler.map((f) => f.message).join('; ') || 'unbekannt'}`,
      false,
    )
  }
  const produktGid = create.productCreate.product.id

  const preis = (v: VarianteZeile) => (Number(tpl.list_price) + Number(v.price_extra)).toFixed(2)

  if (optionen.size > 0) {
    // 2a) Alle Varianten anlegen; die automatische Standardvariante fliegt raus.
    const bulk = await shopifyGraphQL<{
      productVariantsBulkCreate: {
        productVariants: { id: string; sku: string | null; inventoryItem: { id: string } }[] | null
        userErrors: { message: string }[]
      }
    }>(
      `mutation variantenAnlegen($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkCreate(productId: $productId, variants: $variants,
                                   strategy: REMOVE_STANDALONE_VARIANT) {
           productVariants { id sku inventoryItem { id } }
           userErrors { message }
         }
       }`,
      {
        productId: produktGid,
        variants: varianten.map((v) => ({
          optionValues: (jeVariante.get(v.id) ?? []).map((w) => ({
            optionName: w.attribut,
            name: w.wert,
          })),
          price: preis(v),
          ...(v.barcode ? { barcode: v.barcode } : {}),
          inventoryItem: { sku: v.sku, tracked: true },
        })),
      },
    )
    const bulkFehler = bulk.productVariantsBulkCreate.userErrors
    if (bulkFehler.length || !bulk.productVariantsBulkCreate.productVariants) {
      throw new ShopifyError(
        `Varianten abgelehnt: ${bulkFehler.map((f) => f.message).join('; ') || 'unbekannt'}`,
        false,
      )
    }
    // Zuordnung über die SKU — deshalb ist sie oben Pflicht.
    const jeSku = new Map(varianten.map((v) => [v.sku!, v.id]))
    for (const sv of bulk.productVariantsBulkCreate.productVariants) {
      const variantId = sv.sku ? jeSku.get(sv.sku) : undefined
      if (!variantId) continue
      await sql`update product_variants
                set shopify_variant_id = ${sv.id},
                    shopify_inventory_item_gid = ${sv.inventoryItem.id}
                where id = ${variantId}`
    }
  } else {
    // 2b) Ohne Attribute: die automatisch angelegte Standardvariante ist
    //     unsere einzige — Preis, SKU und Barcode nachziehen.
    const std = create.productCreate.product.variants.nodes[0]
    if (!std) throw new ShopifyError('Shopify hat keine Standardvariante angelegt', true)
    const v = varianten[0]
    const upd = await shopifyGraphQL<{
      productVariantsBulkUpdate: { userErrors: { message: string }[] }
    }>(
      `mutation varianteAktualisieren($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkUpdate(productId: $productId, variants: $variants) {
           userErrors { message }
         }
       }`,
      {
        productId: produktGid,
        variants: [
          {
            id: std.id,
            price: preis(v),
            ...(v.barcode ? { barcode: v.barcode } : {}),
            inventoryItem: { sku: v.sku, tracked: true },
          },
        ],
      },
    )
    const updFehler = upd.productVariantsBulkUpdate.userErrors
    if (updFehler.length) {
      throw new ShopifyError(`Variante abgelehnt: ${updFehler.map((f) => f.message).join('; ')}`, false)
    }
    await sql`update product_variants
              set shopify_variant_id = ${std.id},
                  shopify_inventory_item_gid = ${std.inventoryItem.id}
              where id = ${v.id}`
  }

  await sql`select log_event('product_template', ${templateId}, 'note',
    'In Shopify angelegt und verknüpft.', 'system')`
  // Bestand sofort melden, damit der Shop nicht mit 0 startet.
  await sql`select enqueue_job('shopify_inventory_push', '{}'::jsonb, 'inventar-abgleich')`

  return { produktGid, varianten: varianten.length }
}
