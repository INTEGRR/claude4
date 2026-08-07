'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { actionError, actionFail } from '@/modules/shared/action'

/**
 * Server Actions des Verkaufsmoduls. Die Fachlogik liegt in den
 * Postgres-Funktionen; hier stehen nur Authentifizierung, Eingabeprüfung
 * und Fehleraufbereitung.
 */

export async function confirmOrder(orderId: string) {
  const user = await requireWrite('verkauf')
  try {
    await sql`select confirm_sales_order(${orderId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/verkauf/${orderId}`)
  revalidatePath('/verkauf')
}

export async function cancelOrder(orderId: string) {
  const user = await requireWrite('verkauf')
  try {
    await sql`select cancel_sales_order(${orderId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/verkauf/${orderId}`)
  revalidatePath('/verkauf')
}

/** Kopffelder: Verkäufer, Kundenreferenz, Termine, Zahlungsbedingung, Incoterm. */
export async function updateOrderHeader(orderId: string, formData: FormData) {
  await requireWrite('verkauf')
  const commitment = String(formData.get('commitment_date') ?? '')
  const validity = String(formData.get('validity_date') ?? '')
  await sql`
    update sales_orders set
      user_id = ${String(formData.get('user_id') ?? '') || null},
      client_order_ref = ${String(formData.get('client_order_ref') ?? '').trim() || null},
      commitment_date = ${commitment ? new Date(commitment).toISOString() : null},
      validity_date = ${validity || null},
      payment_term_id = ${String(formData.get('payment_term_id') ?? '') || null},
      incoterm_code = ${String(formData.get('incoterm_code') ?? '') || null},
      incoterm_location = ${String(formData.get('incoterm_location') ?? '').trim() || null}
    where id = ${orderId} and state <> 'cancel' and not locked`
  revalidatePath(`/verkauf/${orderId}`)
}

export async function setLocked(orderId: string, locked: boolean) {
  const user = await requireWrite('verkauf')
  await sql`update sales_orders set locked = ${locked} where id = ${orderId} and state = 'sale'`
  await sql`select log_event('sales_order', ${orderId}, 'state',
    ${locked ? 'Auftrag gesperrt' : 'Auftrag entsperrt'}, ${user.name})`
  revalidatePath(`/verkauf/${orderId}`)
}

export async function resetToDraft(orderId: string) {
  const user = await requireWrite('verkauf')
  await sql`update sales_orders set state = 'draft', locked = false
            where id = ${orderId} and state in ('cancel', 'sent')`
  await sql`select log_event('sales_order', ${orderId}, 'state', 'Auf Angebot zurückgesetzt', ${user.name})`
  revalidatePath(`/verkauf/${orderId}`)
}

export async function createOrder(formData: FormData) {
  await requireWrite('verkauf')
  const partnerId = String(formData.get('partner_id') ?? '')
  if (!partnerId) return actionError('Bitte einen Kunden auswählen')

  const [order] = await sql<{ id: string }[]>`
    insert into sales_orders (number, partner_id)
    values (next_sequence('sale'), ${partnerId})
    returning id`

  // Lieferadresse aus dem Kontakt vorbelegen.
  await sql`
    update sales_orders so set
      ship_name = p.name, ship_street = p.street, ship_house_number = p.house_number,
      ship_street2 = p.street2, ship_zip = p.zip, ship_city = p.city,
      ship_country_code = p.country_code, ship_phone = p.phone, ship_email = p.email
    from partners p where p.id = so.partner_id and so.id = ${order.id}`

  redirect(`/verkauf/${order.id}`)
}

export async function addLine(orderId: string, formData: FormData) {
  await requireWrite('verkauf')
  await sql`select sales_order_guard_editable(${orderId})`

  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  if (!(qty > 0)) return actionError('Die Menge muss größer als 0 sein')

  const [info] = await sql<{ uom_id: string; name: string; price: number }[]>`
    select pt.uom_id, variant_display_name(pv.id) as name,
           pt.list_price + pv.price_extra as price
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variantId}`
  if (!info) return actionError('Produkt nicht gefunden')

  const priceInput = formData.get('price_unit')
  const price = priceInput !== null && priceInput !== '' ? Number(priceInput) : Number(info.price)

  await sql`
    insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
    values (
      ${orderId},
      coalesce((select max(sequence) + 10 from sales_order_lines where order_id = ${orderId}), 10),
      ${variantId}, ${info.name}, ${qty}, ${info.uom_id}, ${price})`

  await sql`select sales_order_recompute_status(${orderId})`
  revalidatePath(`/verkauf/${orderId}`)
}

export async function removeLine(orderId: string, lineId: string) {
  await requireWrite('verkauf')
  await sql`select sales_order_guard_editable(${orderId})`
  await sql`delete from sales_order_lines where id = ${lineId} and order_id = ${orderId}`
  await sql`select sales_order_recompute_status(${orderId})`
  revalidatePath(`/verkauf/${orderId}`)
}
