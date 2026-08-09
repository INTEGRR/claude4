'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'

export async function createProduct(formData: FormData) {
  await requireWrite('produkte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) return actionError('Bitte einen Namen angeben')

  const uomId = String(formData.get('uom_id') ?? '')
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (
      name, uom_id, list_price, standard_cost, weight_g,
      can_be_sold, can_be_purchased, route_buy, route_manufacture, route_mto)
    values (
      ${name}, ${uomId},
      ${Number(formData.get('list_price') ?? 0)},
      ${Number(formData.get('standard_cost') ?? 0)},
      ${Number(formData.get('weight_g') ?? 0)},
      ${formData.get('can_be_sold') === 'on'},
      ${formData.get('can_be_purchased') === 'on'},
      ${formData.get('route_buy') === 'on'},
      ${formData.get('route_manufacture') === 'on'},
      ${formData.get('route_mto') === 'on'})
    returning id`

  await sql`select generate_variants(${tpl.id})`

  const sku = String(formData.get('sku') ?? '').trim()
  if (sku) {
    await sql`update product_variants set sku = ${sku}
              where template_id = ${tpl.id} and active and sku is null`
  }

  redirect(`/produkte/${tpl.id}`)
}

export async function updateProduct(templateId: string, formData: FormData) {
  await requireWrite('produkte')
  try {
    await sql`
      update product_templates set
        name = ${String(formData.get('name') ?? '').trim()},
        list_price = ${Number(formData.get('list_price') ?? 0)},
        standard_cost = ${Number(formData.get('standard_cost') ?? 0)},
        weight_g = ${Number(formData.get('weight_g') ?? 0)},
        purchase_uom_id = ${String(formData.get('purchase_uom_id') ?? '') || null},
        invoice_policy = ${String(formData.get('invoice_policy') ?? 'order')}::invoice_policy,
        bill_policy = ${String(formData.get('bill_policy') ?? 'received')}::bill_policy,
        can_be_sold = ${formData.get('can_be_sold') === 'on'},
        can_be_purchased = ${formData.get('can_be_purchased') === 'on'},
        route_buy = ${formData.get('route_buy') === 'on'},
        route_manufacture = ${formData.get('route_manufacture') === 'on'},
        route_mto = ${formData.get('route_mto') === 'on'},
        category_id = coalesce(${String(formData.get('category_id') ?? '') || null}::uuid, category_id),
        sale_delay = ${Number(formData.get('sale_delay') ?? 0)},
        hs_code = ${String(formData.get('hs_code') ?? '').trim() || null},
        country_of_origin = ${String(formData.get('country_of_origin') ?? '').trim().toUpperCase() || null},
        sale_tax_id = ${String(formData.get('sale_tax_id') ?? '') || null},
        purchase_tax_id = ${String(formData.get('purchase_tax_id') ?? '') || null},
        description_sale = ${String(formData.get('description_sale') ?? '').trim() || null},
        description_purchase = ${String(formData.get('description_purchase') ?? '').trim() || null},
        description_picking = ${String(formData.get('description_picking') ?? '').trim() || null},
        responsible_id = ${String(formData.get('responsible_id') ?? '') || null},
        tracking = ${String(formData.get('tracking') ?? 'none')}
      where id = ${templateId}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/produkte/${templateId}`)
}

/** Weist der Vorlage ein Attribut mit Werten zu und erzeugt die Varianten. */
export async function addAttribute(templateId: string, formData: FormData) {
  await requireWrite('produkte')
  const attributeId = String(formData.get('attribute_id') ?? '')
  const valueIds = formData.getAll('value_ids').map(String).filter(Boolean)
  if (!attributeId) return actionError('Bitte ein Attribut auswählen')
  if (valueIds.length === 0) return actionError('Bitte mindestens einen Wert auswählen')

  const [line] = await sql<{ id: string }[]>`
    insert into product_template_attribute_lines (template_id, attribute_id)
    values (${templateId}, ${attributeId})
    on conflict (template_id, attribute_id) do update set attribute_id = excluded.attribute_id
    returning id`

  for (const valueId of valueIds) {
    await sql`insert into product_template_attribute_values (line_id, value_id)
              values (${line.id}, ${valueId}) on conflict do nothing`
  }

  await sql`select generate_variants(${templateId})`
  revalidatePath(`/produkte/${templateId}`)
}

export async function setVariantCodes(variantId: string, formData: FormData) {
  await requireWrite('produkte')
  const sku = String(formData.get('sku') ?? '').trim() || null
  const barcode = String(formData.get('barcode') ?? '').trim() || null
  const shopifyId = String(formData.get('shopify_variant_id') ?? '').trim() || null

  try {
    await sql`
      update product_variants
      set sku = ${sku}, barcode = ${barcode}, shopify_variant_id = ${shopifyId}
      where id = ${variantId}`
  } catch (err) {
    // Eindeutigkeitsverletzungen verständlich melden.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('product_variants_sku_key')) return actionError('Diese Artikelnummer ist bereits vergeben')
    if (message.includes('product_variants_barcode_key')) return actionError('Dieser Barcode ist bereits vergeben')
    return actionFail(err)
  }

  const [variant] = await sql<{ template_id: string }[]>`
    select template_id from product_variants where id = ${variantId}`
  revalidatePath(`/produkte/${variant.template_id}`)
  revalidatePath(`/produkte/variante/${variantId}`)
}

// --- Attribute (Stammdaten) ------------------------------------------------

export async function createAttribute(formData: FormData) {
  await requireWrite('produkte')
  const name = String(formData.get('name') ?? '').trim()
  const values = String(formData.get('values') ?? '')
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
  if (!name) return actionError('Bitte einen Namen angeben')
  if (values.length === 0) return actionError('Bitte mindestens einen Wert angeben (kommagetrennt)')

  const [attr] = await sql<{ id: string }[]>`
    insert into product_attributes (name) values (${name})
    on conflict (name) do update set name = excluded.name
    returning id`

  for (const [index, value] of values.entries()) {
    await sql`insert into product_attribute_values (attribute_id, name, sequence)
              values (${attr.id}, ${value}, ${(index + 1) * 10})
              on conflict (attribute_id, name) do nothing`
  }

  revalidatePath('/produkte/attribute')
}

/**
 * Legt das Produkt samt Varianten in Shopify an und verknüpft beide Seiten.
 * Danach laufen Bestandsabgleich und Bestellzuordnung automatisch.
 */
export async function produktZuShopify(templateId: string) {
  await requireWrite('produkte')
  try {
    const { pushProduktZuShopify } = await import('@/modules/integrationen/produkt-push')
    const r = await pushProduktZuShopify(templateId)
    revalidatePath(`/produkte/${templateId}`)
    return actionInfo(
      `In Shopify angelegt (${r.varianten} Variante(n)) — der Bestand wird gleich gemeldet.`,
    )
  } catch (err) {
    return actionFail(err)
  }
}
