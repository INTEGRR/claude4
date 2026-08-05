'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { money, qty } from '@/modules/shared/format'

function fail(err: unknown): never {
  throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
}

export async function createPurchaseOrder(formData: FormData) {
  await requireUser()
  const vendorId = String(formData.get('vendor_id') ?? '')
  if (!vendorId) throw new Error('Bitte einen Lieferanten auswählen')

  const [order] = await sql<{ id: string }[]>`
    insert into purchase_orders (number, vendor_id)
    values (next_sequence('purchase'), ${vendorId}) returning id`
  redirect(`/einkauf/${order.id}`)
}

export async function addPoLine(orderId: string, formData: FormData) {
  await requireUser()
  await sql`select purchase_order_guard_editable(${orderId})`

  const variantId = String(formData.get('variant_id') ?? '')
  const quantity = Number(formData.get('qty') ?? 0)
  if (!variantId) throw new Error('Bitte ein Produkt auswählen')
  if (!(quantity > 0)) throw new Error('Die Menge muss größer als 0 sein')

  const [order] = await sql<{ vendor_id: string }[]>`
    select vendor_id from purchase_orders where id = ${orderId}`

  const [info] = await sql<{ purchase_uom: string; name: string; cost: number }[]>`
    select coalesce(pt.purchase_uom_id, pt.uom_id) as purchase_uom,
           variant_display_name(pv.id) as name, pt.standard_cost as cost
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variantId}`
  if (!info) throw new Error('Produkt nicht gefunden')

  // Preis aus der Lieferantenpreisliste, sonst Standardkosten.
  const [vendorPrice] = await sql<{ price: number | null }[]>`
    select (best_vendor_price(${variantId}, ${order.vendor_id}, ${quantity})).price as price`

  const priceInput = formData.get('price_unit')
  const price =
    priceInput !== null && priceInput !== ''
      ? Number(priceInput)
      : Number(vendorPrice?.price ?? info.cost ?? 0)

  await sql`
    insert into purchase_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
    values (${orderId},
            coalesce((select max(sequence) + 10 from purchase_order_lines where order_id = ${orderId}), 10),
            ${variantId}, ${info.name}, ${quantity}, ${info.purchase_uom}, ${price})`

  revalidatePath(`/einkauf/${orderId}`)
}

export async function removePoLine(orderId: string, lineId: string) {
  await requireUser()
  await sql`select purchase_order_guard_editable(${orderId})`
  await sql`delete from purchase_order_lines where id = ${lineId} and order_id = ${orderId}`
  revalidatePath(`/einkauf/${orderId}`)
}

export async function confirmPo(orderId: string) {
  const user = await requireUser()
  try {
    await sql`select confirm_purchase_order(${orderId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/einkauf/${orderId}`)
  revalidatePath('/einkauf')
  revalidatePath('/lager')
}

export async function cancelPo(orderId: string) {
  const user = await requireUser()
  try {
    await sql`select cancel_purchase_order(${orderId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/einkauf/${orderId}`)
}

export async function lockPo(orderId: string, locked: boolean) {
  const user = await requireUser()
  await sql`select ${locked ? sql`purchase_order_lock` : sql`purchase_order_unlock`}(${orderId}, ${user.name})`
  revalidatePath(`/einkauf/${orderId}`)
}

/** Stellt die Bestellung als E-Mail mit PDF-Anhang in die Outbox. */
export async function sendPoEmail(orderId: string) {
  const user = await requireUser()

  const [order] = await sql<
    { number: string; vendor: string; email: string | null; expected_arrival: string | null }[]
  >`
    select po.number, p.name as vendor, p.email, po.expected_arrival
    from purchase_orders po join partners p on p.id = po.vendor_id where po.id = ${orderId}`
  if (!order) throw new Error('Bestellung nicht gefunden')
  if (!order.email) throw new Error(`Für ${order.vendor} ist keine E-Mail-Adresse hinterlegt`)

  const lines = await sql<{ name: string; qty: number; uom: string; price_unit: number }[]>`
    select l.name, l.qty, u.name as uom, l.price_unit
    from purchase_order_lines l join uoms u on u.id = l.uom_id
    where l.order_id = ${orderId} order by l.sequence`

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  const rows = lines
    .map(
      (l) =>
        `<tr><td>${l.name}</td><td align="right">${qty(l.qty)} ${l.uom}</td>` +
        `<td align="right">${money(l.price_unit)}</td></tr>`,
    )
    .join('')

  const html =
    `<p>Guten Tag,</p><p>anbei unsere Bestellung <strong>${order.number}</strong>.</p>` +
    `<table cellpadding="6" border="1" style="border-collapse:collapse">` +
    `<tr><th align="left">Position</th><th align="right">Menge</th><th align="right">Preis</th></tr>` +
    `${rows}</table>` +
    `<p>Mit freundlichen Grüßen<br>${company?.name ?? ''}</p>`

  await sql`select enqueue_job('send_po_email',
    ${sql.json({ purchase_order_id: orderId, html })}, ${`po-email:${orderId}:${Date.now()}`})`
  await sql`select log_event('purchase_order', ${orderId}, 'email',
    ${`E-Mail an ${order.email} eingereiht`}, ${user.name})`

  revalidatePath(`/einkauf/${orderId}`)
}

// --- Rechnungen ------------------------------------------------------------

export async function createBill(orderId: string) {
  const user = await requireUser()
  let billId: string
  try {
    const [row] = await sql<{ create_vendor_bill: string }[]>`
      select create_vendor_bill(${orderId}, ${user.name})`
    billId = row.create_vendor_bill
  } catch (err) {
    fail(err)
  }
  redirect(`/einkauf/rechnungen/${billId}`)
}

export async function setBillDate(billId: string, formData: FormData) {
  await requireUser()
  const billDate = String(formData.get('bill_date') ?? '')
  const reference = String(formData.get('vendor_bill_reference') ?? '')
  await sql`
    update vendor_bills set
      bill_date = ${billDate || null}::date,
      vendor_bill_reference = ${reference || null}
    where id = ${billId} and state = 'draft'`
  revalidatePath(`/einkauf/rechnungen/${billId}`)
}

export async function postBill(billId: string) {
  const user = await requireUser()
  try {
    await sql`select post_vendor_bill(${billId}, ${user.name})`
  } catch (err) {
    fail(err)
  }
  revalidatePath(`/einkauf/rechnungen/${billId}`)
}

export async function payBill(billId: string) {
  const user = await requireUser()
  await sql`select pay_vendor_bill(${billId}, ${user.name})`
  revalidatePath(`/einkauf/rechnungen/${billId}`)
}

export async function cancelBill(billId: string) {
  const user = await requireUser()
  let creditId: string | null = null
  try {
    const [row] = await sql<{ cancel_vendor_bill: string | null }[]>`
      select cancel_vendor_bill(${billId}, ${user.name})`
    creditId = row.cancel_vendor_bill
  } catch (err) {
    fail(err)
  }
  if (creditId) redirect(`/einkauf/rechnungen/${creditId}`)
  revalidatePath(`/einkauf/rechnungen/${billId}`)
}
