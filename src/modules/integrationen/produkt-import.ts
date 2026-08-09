import { sql, tx } from '@/db/client'
import { shopifyGraphQL } from './shopify'
import {
  type ShopVarianteRoh,
  echteOptionen,
  ordneVariantenZu,
  preisAufteilung,
} from './produkt-import-logik'

/**
 * Bereits in Shopify existierende Produkte ins ERP holen.
 *
 * Zwei Stufen je Produkt:
 *   1. Verknüpfen — gibt es die Varianten im ERP schon (gleiche SKU oder
 *      gleicher Barcode), werden nur die Shopify-IDs angeschrieben.
 *   2. Anlegen — gibt es nichts, entsteht das Produkt im ERP: Shopify-
 *      Optionen werden zu Attributen, generate_variants baut die Varianten,
 *      und die Zuordnung läuft über die Attributwerte.
 *
 * Läuft als Job in Häppchen (25 Produkte je Seite), beliebig wiederholbar.
 */

interface ShopProdukt {
  id: string
  title: string
  descriptionHtml: string | null
  options: { name: string; values: string[] }[]
  variants: {
    nodes: {
      id: string
      sku: string | null
      barcode: string | null
      price: string
      selectedOptions: { name: string; value: string }[]
      inventoryItem: { id: string }
    }[]
  }
}

async function fetchProductsPage(
  after: string | null,
): Promise<{ produkte: ShopProdukt[]; endCursor: string | null }> {
  const data = await shopifyGraphQL<{
    products: { nodes: ShopProdukt[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
  }>(
    `query($after: String) {
       products(first: 25, after: $after, sortKey: CREATED_AT) {
         nodes {
           id title descriptionHtml
           options { name values }
           variants(first: 100) {
             nodes { id sku barcode price selectedOptions { name value } inventoryItem { id } }
           }
         }
         pageInfo { hasNextPage endCursor }
       }
     }`,
    { after },
  )
  return {
    produkte: data.products.nodes,
    endCursor: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
  }
}

export interface ProduktImportErgebnis {
  verknuepft: number
  angelegt: number
  uebersprungen: number
  probleme: string[]
  nextCursor: string | null
}

export async function importProdukteChunk(cursor: string | null): Promise<ProduktImportErgebnis> {
  const { produkte, endCursor } = await fetchProductsPage(cursor)
  let verknuepft = 0
  let angelegt = 0
  let uebersprungen = 0
  const probleme: string[] = []

  for (const p of produkte) {
    try {
      const ergebnis = await verarbeiteProdukt(p)
      if (ergebnis === 'verknuepft') verknuepft++
      else if (ergebnis === 'angelegt') angelegt++
      else uebersprungen++
    } catch (err) {
      probleme.push(`${p.title}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
    }
  }

  const [alt] = await sql<{ value: { verknuepft?: number; angelegt?: number } }[]>`
    select value from shopify_sync_state where key = 'backfill_products'`
  await sql`
    insert into shopify_sync_state (key, value)
    values ('backfill_products', ${sql.json({
      verknuepft: (alt?.value?.verknuepft ?? 0) + verknuepft,
      angelegt: (alt?.value?.angelegt ?? 0) + angelegt,
      fertig: endCursor === null,
    })})
    on conflict (key) do update set value = excluded.value, updated_at = now()`

  return { verknuepft, angelegt, uebersprungen, probleme, nextCursor: endCursor }
}

async function verarbeiteProdukt(p: ShopProdukt): Promise<'verknuepft' | 'angelegt' | 'uebersprungen'> {
  const shopVarianten: ShopVarianteRoh[] = p.variants.nodes.map((v) => ({
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price,
    optionen: v.selectedOptions,
  }))
  const gids = shopVarianten.map((v) => v.id)

  // Schon vollständig verknüpft? Dann ist nichts zu tun.
  const verknuepfte = await sql<{ shopify_variant_id: string }[]>`
    select shopify_variant_id from product_variants
    where shopify_variant_id in ${sql(gids)}`
  if (verknuepfte.length === shopVarianten.length) return 'uebersprungen'
  const schonVerknuepft = new Set(verknuepfte.map((r) => r.shopify_variant_id))

  // Stufe 1: über SKU oder Barcode an bestehende ERP-Varianten koppeln.
  const inventoryItemJeGid = new Map(p.variants.nodes.map((v) => [v.id, v.inventoryItem.id]))
  let getroffen = 0
  for (const sv of shopVarianten) {
    if (schonVerknuepft.has(sv.id)) continue
    const [treffer] = await sql<{ id: string }[]>`
      select id from product_variants
      where shopify_variant_id is null
        and ((${sv.sku}::text is not null and sku = ${sv.sku})
          or (${sv.barcode}::text is not null and barcode = ${sv.barcode}))
      limit 1`
    if (treffer) {
      await sql`update product_variants
                set shopify_variant_id = ${sv.id},
                    shopify_inventory_item_gid = ${inventoryItemJeGid.get(sv.id) ?? null}
                where id = ${treffer.id}`
      getroffen++
    }
  }
  if (getroffen > 0 || schonVerknuepft.size > 0) return 'verknuepft'

  // Stufe 2: im ERP anlegen — Optionen werden Attribute, Werte inklusive.
  return tx(async (t): Promise<'angelegt'> => {
    const optionen = echteOptionen(p.options)
    const { basis, extra } = preisAufteilung(shopVarianten)

    const [tpl] = await t<{ id: string }[]>`
      insert into product_templates (name, uom_id, list_price, description_sale, can_be_sold)
      values (
        ${p.title},
        (select id from uoms where name = 'Stück' limit 1),
        ${basis}, ${p.descriptionHtml}, true)
      returning id`

    for (const [i, opt] of optionen.entries()) {
      const [attr] = await t<{ id: string }[]>`
        insert into product_attributes (name) values (${opt.name})
        on conflict (name) do update set name = excluded.name
        returning id`
      const [line] = await t<{ id: string }[]>`
        insert into product_template_attribute_lines (template_id, attribute_id, sequence)
        values (${tpl.id}, ${attr.id}, ${(i + 1) * 10}) returning id`
      for (const [j, wert] of opt.values.entries()) {
        const [av] = await t<{ id: string }[]>`
          insert into product_attribute_values (attribute_id, name, sequence)
          values (${attr.id}, ${wert}, ${(j + 1) * 10})
          on conflict (attribute_id, name) do update set name = excluded.name
          returning id`
        await t`insert into product_template_attribute_values (line_id, value_id)
                values (${line.id}, ${av.id}) on conflict do nothing`
      }
    }

    await t`select generate_variants(${tpl.id})`

    const erp = await t<{ id: string; attribut: string | null; wert: string | null }[]>`
      select pv.id, a.name as attribut, av.name as wert
      from product_variants pv
      left join product_variant_attribute_values pvav on pvav.variant_id = pv.id
      left join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
      left join product_template_attribute_lines l on l.id = ptav.line_id
      left join product_attributes a on a.id = l.attribute_id
      left join product_attribute_values av on av.id = ptav.value_id
      where pv.template_id = ${tpl.id} and pv.active`
    const erpVarianten = new Map<string, { attribut: string; wert: string }[]>()
    for (const zeile of erp) {
      if (!erpVarianten.has(zeile.id)) erpVarianten.set(zeile.id, [])
      if (zeile.attribut && zeile.wert) {
        erpVarianten.get(zeile.id)!.push({ attribut: zeile.attribut, wert: zeile.wert })
      }
    }

    const { paare, ohnePartner } = ordneVariantenZu(
      [...erpVarianten.entries()].map(([id, werte]) => ({ id, werte })),
      shopVarianten,
    )
    for (const paar of paare) {
      const item = p.variants.nodes.find((v) => v.id === paar.shop.id)
      await t`update product_variants
              set sku = coalesce(${paar.shop.sku}, sku),
                  barcode = coalesce(${paar.shop.barcode}, barcode),
                  price_extra = ${extra.get(paar.shop.id) ?? 0},
                  shopify_variant_id = ${paar.shop.id},
                  shopify_inventory_item_gid = ${item?.inventoryItem.id ?? null}
              where id = ${paar.erpId}`
    }
    if (ohnePartner.length > 0) {
      await t`select log_event('product_template', ${tpl.id}, 'error',
        ${`${ohnePartner.length} Shopify-Variante(n) ohne Gegenstück: ${ohnePartner.map((v) => v.sku ?? v.id).join(', ')}`},
        'shopify')`
    }
    await t`select log_event('product_template', ${tpl.id}, 'note',
      'Aus Shopify übernommen.', 'shopify')`
    return 'angelegt'
  })
}
