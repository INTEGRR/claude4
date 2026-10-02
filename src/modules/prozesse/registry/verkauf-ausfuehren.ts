import { sql } from '@/db/client'
import { stornoNachlauf } from '@/modules/verkauf/storno-nachlauf'
import { partnerAufloesen, varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext, PositionsZeile } from './typen.ts'

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

/**
 * BUG/00012: Am Telefon ist der Kunde oft neu — dann scheiterte der Auftrag
 * bisher daran, dass die Kontaktanlage eine andere Seite war. Kontakt und
 * Angebot entstehen jetzt in EINER Aktion: eine Torwächter-Prüfung, ein
 * Protokolleintrag, ein Weg. Die Kontaktanlage selbst bleibt die aus
 * kontakte-ausfuehren — kein zweiter Dialekt.
 */
export async function auftragFuerNeuenKunden(
  p: {
    name?: string
    vorname?: string
    nachname?: string
    is_company: boolean
    email?: string
    phone?: string
    street?: string
    house_number?: string
    zip?: string
    city?: string
    country_code: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { partnerAnlegen } = await import('./kontakte-ausfuehren.ts')
  const kunde = await partnerAnlegen(
    { ...p, is_customer: true, is_vendor: false, vat: undefined },
    ctx,
  )
  const auftrag = await auftragAnlegen({ partner_id: kunde.recordId! })
  return { ...auftrag, text: `${kunde.text} ${auftrag.text}` }
}

/**
 * Kombi-Aktion für KI und API: Kopf + Zeilen in einem Aufruf. Sie KOMPONIERT
 * die bestehenden Aktionen (auftragAnlegen, positionHinzufuegen) — dadurch
 * kommen Lieferadresse, Einheit, Listenpreis und Statusneuberechnung gratis
 * und es gibt keinen zweiten Zeilen-Dialekt.
 */
export async function auftragMitPositionen(
  p: { kunde: string; positionen: PositionsZeile[]; hinweis?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Alle Kennungen VOR dem Kopf-Insert auflösen — scheitert eine, entsteht
  // gar kein Beleg statt ein halber.
  const kunde = await partnerAufloesen(sql, p.kunde, 'kunde')
  const varianten = []
  for (const pos of p.positionen) varianten.push(await varianteAufloesen(sql, pos.produkt))

  const kopf = await auftragAnlegen({ partner_id: kunde.id })
  const orderId = kopf.recordId!
  if (p.hinweis) await sql`update sales_orders set note = ${p.hinweis} where id = ${orderId}`

  for (const [i, pos] of p.positionen.entries()) {
    await positionHinzufuegen(
      { variant_id: varianten[i].id, qty: pos.menge, price_unit: pos.preis },
      { ...ctx, recordId: orderId },
    )
  }

  const [order] = await sql<{ number: string }[]>`
    select number from sales_orders where id = ${orderId}`
  return {
    text: `Angebot ${order.number} für ${kunde.name} mit ${p.positionen.length} Position(en) angelegt.`,
    link: `/verkauf/${orderId}`,
    recordId: orderId,
  }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select confirm_sales_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/** Der Satz, mit dem KRNL Storno und Reaktivierung von Shop-Aufträgen ablehnt. */
export const SHOP_STORNO_HINWEIS =
  'Shop-Bestellungen storniert Shopify: bitte im Shopify-Admin stornieren (mit Erstattung) — ' +
  'KRNL übernimmt den Storno dann automatisch samt Lieferung, Fertigung und DHL-Label.'

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [auftrag] = await sql<{ source: string }[]>`
    select source from sales_orders where id = ${ctx.recordId!}`

  // Storno führt Shopify (Entscheidungslog 2026-10-02): kein Storno aus KRNL,
  // keine Meldung an den Shop. Der Shop-Webhook storniert hier.
  if (auftrag?.source === 'shopify') throw new Error(SHOP_STORNO_HINWEIS)

  await sql`select cancel_sales_order(${ctx.recordId!}, ${ctx.actor})`
  const nachlauf = await stornoNachlauf(ctx.recordId!, ctx.actor)
  return {
    recordId: ctx.recordId,
    text: nachlauf.aufgaben
      ? 'Storniert — ein Paket ist schon ausgebucht, aber nicht übergeben: Aufgabe fürs Lager angelegt.'
      : undefined,
  }
}

export async function zurueckAufAngebot(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Ein in Shopify stornierter Auftrag lebt hier nicht wieder auf — Shopify führt.
  const [auftrag] = await sql<{ source: string }[]>`
    select source from sales_orders where id = ${ctx.recordId!}`
  if (auftrag?.source === 'shopify') throw new Error(SHOP_STORNO_HINWEIS)

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
