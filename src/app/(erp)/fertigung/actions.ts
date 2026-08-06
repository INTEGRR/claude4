'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { parseQtyMap } from '@/modules/shared/form'

function fail(err: unknown): never {
  throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
}

export async function createMo(formData: FormData) {
  const user = await requireWrite('fertigung')
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) throw new Error('Bitte ein Produkt auswählen')
  if (!(qty > 0)) throw new Error('Die Menge muss größer als 0 sein')

  let id: string
  try {
    const [row] = await sql<{ create_manufacturing_order: string }[]>`
      select create_manufacturing_order(${variantId}, ${qty}, null, null, ${user.name})`
    id = row.create_manufacturing_order
  } catch (err) {
    fail(err)
  }
  redirect(`/fertigung/${id}`)
}

export async function confirmMo(moId: string) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select mo_confirm(${moId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
}

export async function startMo(moId: string) {
  const user = await requireWrite('fertigung')
  await sql`select mo_start(${moId}, ${user.name})`
  revalidatePath(`/fertigung/${moId}`)
}

export async function checkAvailability(moId: string) {
  await requireWrite('fertigung')
  await sql`select mo_check_availability(${moId})`
  revalidatePath(`/fertigung/${moId}`)
}

/** Fertigmeldung inkl. abweichender Ist-Mengen aus dem Formular. */
export async function produceMo(moId: string, formData: FormData) {
  const user = await requireWrite('fertigung')
  const qtyRaw = formData.get('qty')
  const qty = qtyRaw ? Number(qtyRaw) : null
  const backorder = formData.get('backorder') !== 'no'

  const consumed = parseQtyMap(formData, 'consumed_')

  try {
    await sql`select mo_produce(${moId}, ${qty}, ${sql.json(consumed)}, ${backorder}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
  revalidatePath('/fertigung')
  revalidatePath('/versand')
}

export async function cancelMo(moId: string) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select mo_cancel(${moId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
}

// --- Demontage -------------------------------------------------------------

export async function createUnbuild(formData: FormData) {
  const user = await requireWrite('fertigung')
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) throw new Error('Bitte ein Produkt auswählen')
  if (!(qty > 0)) throw new Error('Die Menge muss größer als 0 sein')

  const [bom] = await sql<{ resolve_bom: string | null }[]>`select resolve_bom(${variantId})`
  if (!bom.resolve_bom) throw new Error('Für dieses Produkt existiert keine Stückliste')

  const [stock] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  const [row] = await sql<{ id: string }[]>`
    insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
    values (next_sequence('unbuild'), ${variantId}, ${bom.resolve_bom}, ${qty},
            ${stock.id}, ${stock.id})
    returning id`

  await sql`select log_event('unbuild_order', ${row.id}, 'state', 'Demontageauftrag angelegt', ${user.name})`
  revalidatePath('/fertigung/demontage')
}

export async function applyUnbuild(unbuildId: string, force: boolean) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select unbuild_apply(${unbuildId}, ${force}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath('/fertigung/demontage')
}

// --- Stücklisten -----------------------------------------------------------

export async function createBom(formData: FormData) {
  await requireWrite('fertigung')
  const templateId = String(formData.get('template_id') ?? '')
  const qty = Number(formData.get('qty') ?? 1)
  if (!templateId) throw new Error('Bitte ein Produkt auswählen')

  const [tpl] = await sql<{ uom_id: string }[]>`
    select uom_id from product_templates where id = ${templateId}`
  if (!tpl) throw new Error('Produkt nicht gefunden')

  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${templateId}, ${qty}, ${tpl.uom_id})
    returning id`
  redirect(`/fertigung/stuecklisten/${bom.id}`)
}

export async function addBomLine(bomId: string, formData: FormData) {
  await requireWrite('fertigung')
  const variantId = String(formData.get('component_variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) throw new Error('Bitte eine Komponente auswählen')
  if (!(qty > 0)) throw new Error('Die Menge muss größer als 0 sein')

  const [info] = await sql<{ uom_id: string }[]>`
    select pt.uom_id from product_variants pv
    join product_templates pt on pt.id = pv.template_id where pv.id = ${variantId}`

  const [line] = await sql<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_lines where bom_id = ${bomId}), 10),
            ${variantId}, ${qty}, ${info.uom_id})
    returning id`

  // "Auf Varianten anwenden": ausgewählte Attributwerte übernehmen.
  const ptavIds = formData.getAll('ptav_ids').map(String).filter(Boolean)
  for (const ptavId of ptavIds) {
    await sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
              values (${line.id}, ${ptavId}) on conflict do nothing`
  }

  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

export async function removeBomLine(bomId: string, lineId: string) {
  await requireWrite('fertigung')
  await sql`delete from bom_lines where id = ${lineId} and bom_id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

export async function setBomConsumption(bomId: string, formData: FormData) {
  await requireWrite('fertigung')
  const value = String(formData.get('consumption') ?? 'warning')
  await sql`update boms set consumption = ${value}::consumption_rule where id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}
