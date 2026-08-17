import { sql } from '@/db/client'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { type ProduktEingabe, produktAnlegen } from '../../ki/produkt-anlegen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Produkt-Aktionen — dieselbe Fachlogik wie die KI-Aktion. */

export async function produktAnlegenAktion(
  p: ProduktEingabe,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ergebnis = await produktAnlegen(sql, p, ctx.actor)
  return {
    text:
      `Produkt „${p.name}" angelegt — ${ergebnis.varianten} Variante(n)` +
      (ergebnis.benannt > 0 ? `, ${ergebnis.benannt} mit Artikelnummer` : '') +
      '.',
    link: `/produkte/${ergebnis.templateId}`,
    recordId: ergebnis.templateId,
  }
}

/**
 * Nach dem Speichern: ist das Produkt mit Shopify verknüpft, wandern die
 * Änderungen als Job in den Shop (Outbox; der Wrapper stößt den Runner an).
 */
async function shopifyNachziehen(templateId: string): Promise<void> {
  if (!shopifyConfigured()) return
  const [verknuepft] = await sql<{ eins: number }[]>`
    select 1 as eins from product_variants
    where template_id = ${templateId} and shopify_variant_id is not null limit 1`
  if (!verknuepft) return
  await sql`select enqueue_job('shopify_product_push',
    ${sql.json({ template_id: templateId })}, ${`produkt-push:${templateId}`})`
}

export async function produktErfassen(p: {
  name: string
  uom_id: string
  list_price: number
  standard_cost: number
  weight_g: number
  can_be_sold: boolean
  can_be_purchased: boolean
  route_buy: boolean
  route_manufacture: boolean
  route_mto: boolean
  sku?: string
}): Promise<AktionsErgebnis> {
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (
      name, uom_id, list_price, standard_cost, weight_g,
      can_be_sold, can_be_purchased, route_buy, route_manufacture, route_mto)
    values (
      ${p.name}, ${p.uom_id}, ${p.list_price}, ${p.standard_cost}, ${p.weight_g},
      ${p.can_be_sold}, ${p.can_be_purchased},
      ${p.route_buy}, ${p.route_manufacture}, ${p.route_mto})
    returning id`

  await sql`select generate_variants(${tpl.id})`

  if (p.sku) {
    await sql`update product_variants set sku = ${p.sku}
              where template_id = ${tpl.id} and active and sku is null`
  }

  return { text: `Produkt „${p.name}" angelegt.`, link: `/produkte/${tpl.id}`, recordId: tpl.id }
}

export async function produktAendern(
  p: {
    name: string
    list_price: number
    standard_cost: number
    weight_g: number
    purchase_uom_id?: string
    invoice_policy: string
    bill_policy: string
    can_be_sold: boolean
    can_be_purchased: boolean
    route_buy: boolean
    route_manufacture: boolean
    route_mto: boolean
    category_id?: string
    sale_delay: number
    hs_code?: string
    country_of_origin?: string
    sale_tax_id?: string
    purchase_tax_id?: string
    description_sale?: string
    description_purchase?: string
    description_picking?: string
    responsible_id?: string
    tracking: string
    kleinpaket: boolean
    platzbedarf: number
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  await sql`
    update product_templates set
      name = ${p.name},
      list_price = ${p.list_price},
      standard_cost = ${p.standard_cost},
      weight_g = ${p.weight_g},
      purchase_uom_id = ${p.purchase_uom_id ?? null},
      invoice_policy = ${p.invoice_policy}::invoice_policy,
      bill_policy = ${p.bill_policy}::bill_policy,
      can_be_sold = ${p.can_be_sold},
      can_be_purchased = ${p.can_be_purchased},
      route_buy = ${p.route_buy},
      route_manufacture = ${p.route_manufacture},
      route_mto = ${p.route_mto},
      category_id = coalesce(${p.category_id ?? null}::uuid, category_id),
      sale_delay = ${p.sale_delay},
      hs_code = ${p.hs_code ?? null},
      country_of_origin = ${p.country_of_origin ?? null},
      sale_tax_id = ${p.sale_tax_id ?? null},
      purchase_tax_id = ${p.purchase_tax_id ?? null},
      description_sale = ${p.description_sale ?? null},
      description_purchase = ${p.description_purchase ?? null},
      description_picking = ${p.description_picking ?? null},
      responsible_id = ${p.responsible_id ?? null},
      tracking = ${p.tracking},
      kleinpaket = ${p.kleinpaket},
      platzbedarf = ${p.platzbedarf}
    where id = ${templateId}`
  await shopifyNachziehen(templateId)
  return { recordId: templateId }
}

export async function attributZuweisen(
  p: { attribute_id: string; value_ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  const [line] = await sql<{ id: string }[]>`
    insert into product_template_attribute_lines (template_id, attribute_id)
    values (${templateId}, ${p.attribute_id})
    on conflict (template_id, attribute_id) do update set attribute_id = excluded.attribute_id
    returning id`

  for (const valueId of p.value_ids) {
    await sql`insert into product_template_attribute_values (line_id, value_id)
              values (${line.id}, ${valueId}) on conflict do nothing`
  }

  await sql`select generate_variants(${templateId})`
  return { recordId: templateId }
}

export async function varianteCodes(
  p: { sku?: string; barcode?: string; shopify_variant_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const variantId = ctx.recordId!
  try {
    await sql`
      update product_variants
      set sku = ${p.sku ?? null}, barcode = ${p.barcode ?? null},
          shopify_variant_id = ${p.shopify_variant_id ?? null}
      where id = ${variantId}`
  } catch (err) {
    // Eindeutigkeitsverletzungen verständlich melden.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('product_variants_sku_key')) {
      throw new Error('Diese Artikelnummer ist bereits vergeben')
    }
    if (message.includes('product_variants_barcode_key')) {
      throw new Error('Dieser Barcode ist bereits vergeben')
    }
    throw err
  }

  const [variant] = await sql<{ template_id: string }[]>`
    select template_id from product_variants where id = ${variantId}`
  await shopifyNachziehen(variant.template_id)
  return { recordId: variant.template_id }
}

export async function attributAnlegen(p: {
  name: string
  werte: string[]
}): Promise<AktionsErgebnis> {
  const [attr] = await sql<{ id: string }[]>`
    insert into product_attributes (name) values (${p.name})
    on conflict (name) do update set name = excluded.name
    returning id`

  for (const [index, value] of p.werte.entries()) {
    await sql`insert into product_attribute_values (attribute_id, name, sequence)
              values (${attr.id}, ${value}, ${(index + 1) * 10})
              on conflict (attribute_id, name) do nothing`
  }

  return { text: `Attribut „${p.name}" mit ${p.werte.length} Wert(en) angelegt.` }
}

export async function lieferantenpreisAnlegen(
  p: {
    vendor_id: string
    preis: number
    rabatt: number
    moq: number
    lieferzeit_tage: number
    gueltig_von?: string
    gueltig_bis?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [vendor] = await sql<{ name: string }[]>`
    select name from partners where id = ${p.vendor_id} and is_vendor`
  if (!vendor) throw new Error('Der gewählte Kontakt ist kein Lieferant.')

  await sql`
    insert into vendor_prices (vendor_id, template_id, price, discount, min_qty,
                               lead_time_days, date_start, date_end)
    values (${p.vendor_id}, ${ctx.recordId!}, ${p.preis}, ${p.rabatt}, ${p.moq},
            ${p.lieferzeit_tage}, ${p.gueltig_von ?? null}, ${p.gueltig_bis ?? null})`
  await sql`select log_event('product_template', ${ctx.recordId!}, 'note',
    ${`Lieferantenpreis: ${vendor.name} ab ${p.moq} Stück zu ${p.preis.toFixed(2)} €` +
      (p.rabatt > 0 ? ` (−${p.rabatt} %)` : '')}, ${ctx.actor})`
  return {
    text: `Staffel für ${vendor.name} angelegt${p.moq > 0 ? ` (ab ${p.moq})` : ''}.`,
    recordId: ctx.recordId,
  }
}

export async function lieferantenpreisLoeschen(
  p: { preis_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // template_id-Scope: eine fremde Preiszeile lässt sich über diese Aktion
  // nicht löschen, auch nicht mit geratener ID.
  const [zeile] = await sql<{ id: string }[]>`
    delete from vendor_prices
    where id = ${p.preis_id} and template_id = ${ctx.recordId!}
    returning id`
  if (!zeile) throw new Error('Diese Preiszeile gehört nicht zu diesem Produkt.')
  return { text: 'Preiszeile entfernt.', recordId: ctx.recordId }
}

export async function zuShopify(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const { pushProduktZuShopify } = await import('@/modules/integrationen/produkt-push')
  const r = await pushProduktZuShopify(ctx.recordId!)
  return {
    text: `In Shopify angelegt (${r.varianten} Variante(n)) — der Bestand wird gleich gemeldet.`,
    recordId: ctx.recordId,
  }
}
