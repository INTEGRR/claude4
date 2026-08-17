import { sql } from '@/db/client'
import { money, qty } from '@/modules/shared/format'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Einkaufs-Aktionen — Fachlogik unverändert aus einkauf/actions.ts. */

export async function bestellungAnlegen(p: { vendor_id: string }): Promise<AktionsErgebnis> {
  const [order] = await sql<{ id: string; number: string }[]>`
    insert into purchase_orders (number, vendor_id)
    values (next_sequence('purchase'), ${p.vendor_id}) returning id, number`
  return {
    text: `Bestellung ${order.number} angelegt.`,
    link: `/einkauf/${order.id}`,
    recordId: order.id,
  }
}

export async function positionHinzufuegen(
  p: { variant_id: string; qty: number; price_unit?: number; discount?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select purchase_order_guard_editable(${orderId})`

  const [order] = await sql<{ vendor_id: string }[]>`
    select vendor_id from purchase_orders where id = ${orderId}`

  const [info] = await sql<{ purchase_uom: string; name: string; cost: number }[]>`
    select coalesce(pt.purchase_uom_id, pt.uom_id) as purchase_uom,
           variant_display_name(pv.id) as name, pt.standard_cost as cost
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`
  if (!info) throw new Error('Produkt nicht gefunden')

  // Preis + Rabatt aus der Lieferantenpreisliste, sonst Standardkosten.
  const [vendorPrice] = await sql<{ price: number | null; discount: number | null }[]>`
    select (best_vendor_price(${p.variant_id}, ${order.vendor_id}, ${p.qty})).price as price,
           (best_vendor_price(${p.variant_id}, ${order.vendor_id}, ${p.qty})).discount as discount`

  const price = p.price_unit ?? Number(vendorPrice?.price ?? info.cost ?? 0)
  const discount = p.discount ?? Number(vendorPrice?.discount ?? 0)

  await sql`
    insert into purchase_order_lines
      (order_id, sequence, variant_id, name, qty, uom_id, price_unit, discount, tax_id, tax_rate)
    select ${orderId},
           coalesce((select max(sequence) + 10 from purchase_order_lines where order_id = ${orderId}), 10),
           ${p.variant_id}, ${info.name}, ${p.qty}, ${info.purchase_uom}, ${price}, ${discount},
           pt.purchase_tax_id,
           coalesce((select amount from taxes where id = pt.purchase_tax_id), 19)
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`

  return { recordId: orderId }
}

export async function positionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select purchase_order_guard_editable(${orderId})`
  await sql`delete from purchase_order_lines where id = ${p.line_id} and order_id = ${orderId}`
  return { recordId: orderId }
}

export async function kopfAendern(
  p: {
    user_id?: string
    payment_term_id?: string
    incoterm_code?: string
    priority: boolean
    receipt_reminder_email: boolean
    reminder_date_before_receipt: number
    eta?: string
    eta_bestaetigt?: string
    carrier?: string
    tracking_nummer?: string
    tracking_url?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update purchase_orders set
      user_id = ${p.user_id ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      incoterm_code = ${p.incoterm_code ?? null},
      priority = ${p.priority ? '1' : '0'},
      receipt_reminder_email = ${p.receipt_reminder_email},
      reminder_date_before_receipt = ${p.reminder_date_before_receipt},
      expected_arrival = ${p.eta ?? null},
      eta_confirmed = ${p.eta_bestaetigt ?? null},
      carrier = ${p.carrier ?? null},
      tracking_number = ${p.tracking_nummer ?? null},
      tracking_url = ${p.tracking_url ?? null}
    where id = ${ctx.recordId!} and state <> 'cancel'`
  // Der Termin ist EINMAL gepflegt und wandert an die offenen
  // Wareneingangs-Transfers — der Lagerist plant nach scheduled_date.
  await sql`select purchase_order_eta_sync(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select confirm_purchase_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select cancel_purchase_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function sperren(
  p: { locked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select ${p.locked ? sql`purchase_order_lock` : sql`purchase_order_unlock`}(
    ${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/** Stellt die Bestellung als E-Mail mit Positionsliste in die Outbox. */
export async function emailSenden(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  const [order] = await sql<
    { number: string; vendor: string; email: string | null }[]
  >`
    select po.number, p.name as vendor, p.email
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
    ${`E-Mail an ${order.email} eingereiht`}, ${ctx.actor})`

  return { text: `E-Mail an ${order.email} eingereiht.`, recordId: orderId }
}

// --- Rechnungen ------------------------------------------------------------

export async function rechnungErstellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ create_vendor_bill: string }[]>`
    select create_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return {
    text: 'Rechnung im Entwurf erstellt.',
    link: `/einkauf/rechnungen/${row.create_vendor_bill}`,
    recordId: row.create_vendor_bill,
  }
}

export async function rechnungDetails(
  p: {
    bill_date?: string
    vendor_bill_reference?: string
    payment_term_id?: string
    payment_reference?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update vendor_bills set
      bill_date = ${p.bill_date ?? null}::date,
      vendor_bill_reference = ${p.vendor_bill_reference ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      payment_reference = ${p.payment_reference ?? null}
    where id = ${ctx.recordId!} and state = 'draft'`
  return { recordId: ctx.recordId }
}

export async function rechnungPruefen(
  p: { checked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update vendor_bills set checked = ${p.checked} where id = ${ctx.recordId!}`
  await sql`select log_event('vendor_bill', ${ctx.recordId!}, 'note',
    ${p.checked ? 'Als geprüft markiert' : 'Prüfmarkierung entfernt'}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select post_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungZahlen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select pay_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ cancel_vendor_bill: string | null }[]>`
    select cancel_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  if (row.cancel_vendor_bill) {
    return {
      text: 'Stornorechnung erstellt.',
      link: `/einkauf/rechnungen/${row.cancel_vendor_bill}`,
      recordId: row.cancel_vendor_bill,
    }
  }
  return { recordId: ctx.recordId }
}

// --- Einstandsnebenkosten + Kurse ------------------------------------------

export async function nebenkostenErfassen(
  p: {
    amount: number
    currency: string
    cost_type: string
    basis: string
    is_estimate: boolean
    vendor_id?: string
    note?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into landed_costs
      (number, picking_id, cost_type, basis, amount, currency, exchange_rate,
       is_estimate, vendor_id, note)
    values (
      next_sequence('landed'), ${ctx.recordId!},
      ${p.cost_type}::landed_cost_type, ${p.basis}::landed_cost_basis,
      ${p.amount}, ${p.currency},
      exchange_rate_at(${p.currency}, current_date),
      ${p.is_estimate}, ${p.vendor_id ?? null}, ${p.note ?? null})`
  return { recordId: ctx.recordId }
}

export async function nebenkostenBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select landed_cost_post(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function nebenkostenStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select landed_cost_cancel(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function wechselkursErfassen(p: {
  currency: string
  rate: number
  valid_from?: string
}): Promise<AktionsErgebnis> {
  await sql`
    insert into exchange_rates (currency, rate, valid_from, source)
    values (${p.currency}, ${p.rate}, ${p.valid_from ?? null}::date, 'manuell')
    on conflict (currency, valid_from) do update
      set rate = excluded.rate, source = 'manuell'`
  return { text: `Kurs ${p.currency} = ${p.rate} erfasst.` }
}
