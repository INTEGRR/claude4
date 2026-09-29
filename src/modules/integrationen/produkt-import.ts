import { sql, tx } from '@/db/client'
import { shopifyGraphQL } from './shopify'
import {
  type ShopVarianteRoh,
  bundleRolle,
  echteOptionen,
  imDurchgang,
  ordneVariantenZu,
  preisAufteilung,
  teileZweitangebote,
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
 * Eine SKU ist genau ein Artikel. Führt ein zweites Shop-Angebot dieselbe
 * SKU (Bundle-Bestandteil, Aktions-Edition), wird es nicht doppelt angelegt:
 * Bestellungen finden den Artikel über die SKU (Zweitangebot). Damit der
 * Artikel dem normalen Produkt gehört und nicht der Bundle-Liste, laufen
 * zwei Durchgänge: erst die eigenständigen Produkte, dann die Bundle-
 * Bestandteile. Bundles selbst (Shopifys Bundles-App) sind kein Artikel —
 * ihre Bestellungen bringen die Bestandteile als eigene Positionen.
 *
 * Läuft als Job in Häppchen (25 Produkte je Seite), beliebig wiederholbar.
 */

interface ShopProdukt {
  id: string
  title: string
  descriptionHtml: string | null
  hasVariantsThatRequiresComponents?: boolean | null
  productParents?: { nodes: { id: string }[] } | null
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
           hasVariantsThatRequiresComponents
           productParents(first: 1) { nodes { id } }
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
  /** Shop-Varianten, deren SKU schon einem Artikel gehört (Zweitangebote). */
  zweitangebote: number
  /** Bundles der Bundles-App — kein eigener Artikel. */
  bundles: number
  probleme: string[]
  nextCursor: string | null
}

type Verarbeitung = {
  ergebnis: 'verknuepft' | 'angelegt' | 'uebersprungen'
  zweitangebote: number
}

/**
 * Eine Seite Produkte in einem Durchgang: 1 = eigenständige Produkte,
 * 2 = Bundle-Bestandteile (siehe Kopfkommentar). Bundles zählt nur
 * Durchgang 1, damit sie im Ergebnis nicht doppelt erscheinen.
 */
export async function importProdukteChunk(
  cursor: string | null,
  durchgang: 1 | 2 = 1,
): Promise<ProduktImportErgebnis> {
  const { produkte, endCursor } = await fetchProductsPage(cursor)
  let verknuepft = 0
  let angelegt = 0
  let uebersprungen = 0
  let zweitangebote = 0
  let bundles = 0
  const probleme: string[] = []

  for (const p of produkte) {
    const rolle = bundleRolle(p)
    if (rolle === 'bundle' && durchgang === 1) bundles++
    if (!imDurchgang(rolle, durchgang)) continue
    try {
      const v = await verarbeiteProdukt(p)
      zweitangebote += v.zweitangebote
      if (v.ergebnis === 'verknuepft') verknuepft++
      else if (v.ergebnis === 'angelegt') angelegt++
      else uebersprungen++
    } catch (err) {
      probleme.push(`${p.title}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`)
    }
  }

  const [alt] = await sql<{ value: { verknuepft?: number; angelegt?: number; zweitangebote?: number; bundles?: number } }[]>`
    select value from shopify_sync_state where key = 'backfill_products'`
  await sql`
    insert into shopify_sync_state (key, value)
    values ('backfill_products', ${sql.json({
      verknuepft: (alt?.value?.verknuepft ?? 0) + verknuepft,
      angelegt: (alt?.value?.angelegt ?? 0) + angelegt,
      zweitangebote: (alt?.value?.zweitangebote ?? 0) + zweitangebote,
      bundles: (alt?.value?.bundles ?? 0) + bundles,
      fertig: endCursor === null && durchgang === 2,
    })})
    on conflict (key) do update set value = excluded.value, updated_at = now()`

  return { verknuepft, angelegt, uebersprungen, zweitangebote, bundles, probleme, nextCursor: endCursor }
}

/**
 * SKUs und Barcodes der Shop-Varianten, die im ERP schon einem Artikel
 * gehören — Grundlage für die Zweitangebote.
 */
async function vergebeneKennungen(
  varianten: ShopVarianteRoh[],
): Promise<{ skus: Set<string>; barcodes: Set<string> }> {
  const skus = varianten.map((v) => v.sku?.trim()).filter((x): x is string => Boolean(x))
  const barcodes = varianten.map((v) => v.barcode?.trim()).filter((x): x is string => Boolean(x))
  if (skus.length === 0 && barcodes.length === 0) return { skus: new Set(), barcodes: new Set() }
  const zeilen = await sql<{ sku: string | null; barcode: string | null }[]>`
    select sku, barcode from product_variants
    where sku = any(${skus}::text[]) or barcode = any(${barcodes}::text[])`
  return {
    skus: new Set(zeilen.map((z) => z.sku).filter((x): x is string => x !== null && skus.includes(x))),
    barcodes: new Set(zeilen.map((z) => z.barcode).filter((x): x is string => x !== null && barcodes.includes(x))),
  }
}

async function verarbeiteProdukt(p: ShopProdukt): Promise<Verarbeitung> {
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
  if (verknuepfte.length === shopVarianten.length) return { ergebnis: 'uebersprungen', zweitangebote: 0 }
  const schonVerknuepft = new Set(verknuepfte.map((r) => r.shopify_variant_id))

  // Stufe 1: über SKU oder Barcode an bestehende ERP-Varianten koppeln.
  const inventoryItemJeGid = new Map(p.variants.nodes.map((v) => [v.id, v.inventoryItem.id]))
  const getroffen = new Set<string>()
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
      getroffen.add(sv.id)
    }
  }
  // Was jetzt noch offen ist und dessen SKU einem anderen Artikel gehört,
  // ist ein Zweitangebot — es wird nie angelegt.
  const offen = shopVarianten.filter((sv) => !schonVerknuepft.has(sv.id) && !getroffen.has(sv.id))
  const { neu, zweit } = teileZweitangebote(offen, await vergebeneKennungen(offen))
  if (getroffen.size > 0) return { ergebnis: 'verknuepft', zweitangebote: zweit.length }
  if (schonVerknuepft.size > 0) {
    // Das Produkt steht schon im ERP; übrig sind Zweitangebote oder neue
    // Shop-Varianten ohne Gegenstück (die meldet der laufende Abgleich).
    return { ergebnis: neu.length === 0 ? 'uebersprungen' : 'verknuepft', zweitangebote: zweit.length }
  }
  if (neu.length === 0) return { ergebnis: 'uebersprungen', zweitangebote: zweit.length }

  // Stufe 2: im ERP anlegen — Optionen werden Attribute, Werte inklusive.
  const zweitIds = new Set(zweit.map((v) => v.id))
  return tx(async (t): Promise<Verarbeitung> => {
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
      if (zweitIds.has(paar.shop.id)) {
        // Zweitangebot: die Kombination existiert als Attribut, der Artikel
        // aber schon anderswo — archivieren statt die SKU doppelt zu vergeben.
        await t`update product_variants set active = false where id = ${paar.erpId}`
        continue
      }
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
    if (zweit.length > 0) {
      await t`select log_event('product_template', ${tpl.id}, 'note',
        ${`${zweit.length} Variante(n) sind schon Artikel eines anderen Shop-Angebots (Zweitangebot, z. B. Bundle-Bestandteil) und hier archiviert — Bestellungen landen über die SKU beim vorhandenen Artikel: ${zweit.map((v) => v.sku ?? v.id).join(', ')}`},
        'shopify')`
    }
    await t`select log_event('product_template', ${tpl.id}, 'note',
      'Aus Shopify übernommen.', 'shopify')`
    return { ergebnis: 'angelegt', zweitangebote: zweit.length }
  })
}

// --- Laufender Abgleich Shop → ERP -------------------------------------------

/**
 * Holt EIN Produkt frisch aus Shopify und gleicht es ab — Einstieg für den
 * Webhook products/update (und products/create).
 *
 * Verknüpfte Produkte werden aktualisiert: Titel, Beschreibung, Preise
 * (Basis + Aufpreis je Variante), SKU und Barcode folgen dem Shop. Neue
 * Shop-Varianten werden per SKU/Barcode angekoppelt; bleibt eine ohne
 * Gegenstück, steht das als Klärfall am Produkt. Unverknüpfte Produkte
 * laufen durch dieselben zwei Stufen wie die Erstübernahme.
 */
export async function aktualisiereProduktAusShopify(gid: string): Promise<string> {
  const data = await shopifyGraphQL<{ node: ShopProdukt | null }>(
    `query($id: ID!) {
       node(id: $id) {
         ... on Product {
           id title descriptionHtml
           hasVariantsThatRequiresComponents
           productParents(first: 1) { nodes { id } }
           options { name values }
           variants(first: 100) {
             nodes { id sku barcode price selectedOptions { name value } inventoryItem { id } }
           }
         }
       }
     }`,
    { id: gid },
  )
  const p = data.node
  if (!p?.id) return 'Produkt in Shopify nicht gefunden — übersprungen'

  const gids = p.variants.nodes.map((v) => v.id)
  const verknuepfte = await sql<{ id: string; shopify_variant_id: string; template_id: string }[]>`
    select id, shopify_variant_id, template_id from product_variants
    where shopify_variant_id in ${sql(gids)}`

  if (verknuepfte.length === 0) {
    if (bundleRolle(p) === 'bundle') {
      return `„${p.title}" ist ein Bundle — kein eigener Artikel, Bestellungen bringen die Bestandteile`
    }
    const { ergebnis, zweitangebote } = await verarbeiteProdukt(p)
    const zweit = zweitangebote ? `, ${zweitangebote} Zweitangebot(e)` : ''
    return `„${p.title}" ${ergebnis === 'angelegt' ? 'im ERP angelegt' : ergebnis === 'verknuepft' ? 'verknüpft' : 'unverändert'}${zweit}`
  }

  const templateId = verknuepfte[0].template_id
  const shopVarianten: ShopVarianteRoh[] = p.variants.nodes.map((v) => ({
    id: v.id, sku: v.sku, barcode: v.barcode, price: v.price, optionen: v.selectedOptions,
  }))
  const { basis, extra } = preisAufteilung(shopVarianten)
  const erpJeGid = new Map(verknuepfte.map((v) => [v.shopify_variant_id, v.id]))

  await sql`update product_templates
            set name = ${p.title}, list_price = ${basis},
                description_sale = coalesce(${p.descriptionHtml}, description_sale)
            where id = ${templateId}`

  let neuVerknuepft = 0
  const offen: string[] = []
  for (const sv of p.variants.nodes) {
    const erpId = erpJeGid.get(sv.id)
    if (erpId) {
      await sql`update product_variants
                set sku = coalesce(${sv.sku}, sku),
                    barcode = coalesce(${sv.barcode}, barcode),
                    price_extra = ${extra.get(sv.id) ?? 0},
                    shopify_inventory_item_gid = coalesce(shopify_inventory_item_gid, ${sv.inventoryItem.id})
                where id = ${erpId}`
      continue
    }
    // Neue Shop-Variante: per SKU/Barcode ankoppeln.
    const [treffer] = await sql<{ id: string }[]>`
      select id from product_variants
      where template_id = ${templateId} and shopify_variant_id is null
        and ((${sv.sku}::text is not null and sku = ${sv.sku})
          or (${sv.barcode}::text is not null and barcode = ${sv.barcode}))
      limit 1`
    if (treffer) {
      await sql`update product_variants
                set shopify_variant_id = ${sv.id},
                    shopify_inventory_item_gid = ${sv.inventoryItem.id},
                    price_extra = ${extra.get(sv.id) ?? 0}
                where id = ${treffer.id}`
      neuVerknuepft++
    } else {
      offen.push(sv.sku ?? sv.id)
    }
  }

  if (offen.length > 0) {
    await sql`select log_event('product_template', ${templateId}, 'error',
      ${`Shopify-Änderung: ${offen.length} Variante(n) ohne ERP-Gegenstück (${offen.join(', ')}) — im ERP anlegen oder SKU angleichen.`},
      'shopify')`
  }
  await sql`select log_event('product_template', ${templateId}, 'note',
    'Aus Shopify aktualisiert (Titel, Preise, Codes).', 'shopify')`
  return `„${p.title}" aktualisiert${neuVerknuepft ? `, ${neuVerknuepft} Variante(n) neu verknüpft` : ''}${offen.length ? `, ${offen.length} offen` : ''}`
}
