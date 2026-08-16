import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Verkaufs-Aktionen — Fachlogik unverändert aus verkauf/actions.ts. */

export async function auftragAnlegen(p: { partner_id: string }): Promise<AktionsErgebnis> {
  const [order] = await sql<{ id: string; number: string }[]>`
    insert into sales_orders (number, partner_id)
    values (next_sequence('sale'), ${p.partner_id})
    returning id, number`

  // Lieferadresse aus dem Kontakt vorbelegen.
  await sql`
    update sales_orders so set
      ship_name = pa.name, ship_street = pa.street, ship_house_number = pa.house_number,
      ship_street2 = pa.street2, ship_zip = pa.zip, ship_city = pa.city,
      ship_country_code = pa.country_code, ship_phone = pa.phone, ship_email = pa.email
    from partners pa where pa.id = so.partner_id and so.id = ${order.id}`

  return {
    text: `Angebot ${order.number} angelegt.`,
    link: `/verkauf/${order.id}`,
    recordId: order.id,
  }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select confirm_sales_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select cancel_sales_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function zurueckAufAngebot(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update sales_orders set state = 'draft', locked = false
            where id = ${ctx.recordId!} and state in ('cancel', 'sent')`
  await sql`select log_event('sales_order', ${ctx.recordId!}, 'state',
    'Auf Angebot zurückgesetzt', ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function kopfAendern(
  p: {
    user_id?: string
    client_order_ref?: string
    commitment_date?: string
    validity_date?: string
    payment_term_id?: string
    incoterm_code?: string
    incoterm_location?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update sales_orders set
      user_id = ${p.user_id ?? null},
      client_order_ref = ${p.client_order_ref ?? null},
      commitment_date = ${p.commitment_date ? new Date(p.commitment_date).toISOString() : null},
      validity_date = ${p.validity_date ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      incoterm_code = ${p.incoterm_code ?? null},
      incoterm_location = ${p.incoterm_location ?? null}
    where id = ${ctx.recordId!} and state <> 'cancel' and not locked`
  return { recordId: ctx.recordId }
}

export async function sperren(
  p: { locked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update sales_orders set locked = ${p.locked}
            where id = ${ctx.recordId!} and state = 'sale'`
  await sql`select log_event('sales_order', ${ctx.recordId!}, 'state',
    ${p.locked ? 'Auftrag gesperrt' : 'Auftrag entsperrt'}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function positionHinzufuegen(
  p: { variant_id: string; qty: number; price_unit?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select sales_order_guard_editable(${orderId})`

  const [info] = await sql<{ uom_id: string; name: string; price: number }[]>`
    select pt.uom_id, variant_display_name(pv.id) as name,
           pt.list_price + pv.price_extra as price
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`
  if (!info) throw new Error('Produkt nicht gefunden')

  await sql`
    insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
    values (
      ${orderId},
      coalesce((select max(sequence) + 10 from sales_order_lines where order_id = ${orderId}), 10),
      ${p.variant_id}, ${info.name}, ${p.qty}, ${info.uom_id},
      ${p.price_unit ?? Number(info.price)})`

  await sql`select sales_order_recompute_status(${orderId})`
  return { recordId: orderId }
}

export async function positionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select sales_order_guard_editable(${orderId})`
  await sql`delete from sales_order_lines where id = ${p.line_id} and order_id = ${orderId}`
  await sql`select sales_order_recompute_status(${orderId})`
  return { recordId: orderId }
}
