'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { parseQtyMap } from '@/modules/shared/form'

function fail(err: unknown): never {
  throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
}

export async function createRepair(formData: FormData) {
  await requireUser()
  const partnerId = String(formData.get('partner_id') ?? '')
  const variantId = String(formData.get('variant_id') ?? '')
  if (!partnerId) throw new Error('Bitte einen Kunden auswählen')
  if (!variantId) throw new Error('Bitte das zu reparierende Produkt auswählen')

  const [repair] = await sql<{ id: string }[]>`
    insert into repair_orders (number, partner_id, variant_id, qty, under_warranty, note)
    values (next_sequence('repair'), ${partnerId}, ${variantId},
            ${Number(formData.get('qty') ?? 1)},
            ${formData.get('under_warranty') === 'on'},
            ${String(formData.get('note') ?? '') || null})
    returning id`

  redirect(`/reparatur/${repair.id}`)
}

export async function addPart(repairId: string, formData: FormData) {
  await requireUser()
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  const partType = String(formData.get('part_type') ?? 'add')
  if (!variantId) throw new Error('Bitte ein Teil auswählen')
  if (!(qty > 0)) throw new Error('Die Menge muss größer als 0 sein')

  const [info] = await sql<{ uom_id: string; price: number }[]>`
    select pt.uom_id, pt.list_price as price
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variantId}`

  await sql`
    insert into repair_parts (repair_id, sequence, part_type, variant_id, qty, uom_id, price_unit)
    values (${repairId},
            coalesce((select max(sequence) + 10 from repair_parts where repair_id = ${repairId}), 10),
            ${partType}::repair_part_type, ${variantId}, ${qty}, ${info.uom_id}, ${info.price})`

  revalidatePath(`/reparatur/${repairId}`)
}

export async function removePart(repairId: string, partId: string) {
  await requireUser()
  const [part] = await sql<{ move_id: string | null }[]>`
    select move_id from repair_parts where id = ${partId} and repair_id = ${repairId}`
  if (part?.move_id) {
    await sql`select move_cancel(${part.move_id})`
  }
  await sql`delete from repair_parts where id = ${partId} and repair_id = ${repairId}`
  revalidatePath(`/reparatur/${repairId}`)
}

export async function confirmRepair(repairId: string) {
  const user = await requireUser()
  try {
    await sql`select repair_confirm(${repairId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/reparatur/${repairId}`)
}

export async function startRepair(repairId: string) {
  const user = await requireUser()
  await sql`select repair_start(${repairId}, ${user.name})`
  revalidatePath(`/reparatur/${repairId}`)
}

export async function endRepair(repairId: string, formData: FormData) {
  const user = await requireUser()

  const done = parseQtyMap(formData, 'done_')

  try {
    await sql`select repair_end(${repairId}, ${sql.json(done)}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/reparatur/${repairId}`)
  revalidatePath('/lager/bestand')
}

export async function cancelRepair(repairId: string) {
  const user = await requireUser()
  try {
    await sql`select repair_cancel(${repairId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/reparatur/${repairId}`)
}

export async function createQuotation(repairId: string) {
  const user = await requireUser()
  let orderId: string
  try {
    const [row] = await sql<{ repair_create_quotation: string }[]>`
      select repair_create_quotation(${repairId}, ${user.name})`
    orderId = row.repair_create_quotation
  } catch (err) {
    fail(err)
  }
  redirect(`/verkauf/${orderId}`)
}
