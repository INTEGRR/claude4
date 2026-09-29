import { sql } from '@/db/client'
import { parseLotSpec } from '@/modules/shared/form'
import { consumePackagingForPicking, queueFulfillmentForPicking } from '@/modules/versand/service'
import { varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/**
 * Ausführung der Lager-Aktionen. Die Fachlogik stammt unverändert aus
 * lager/actions.ts — sie ruft dieselben SQL-Funktionen; neu ist nur, dass
 * sie hier adressierbar ist (HTTP-Route, Prozesstest, generierte Maske)
 * statt allein am Formular zu hängen.
 */

const HAUPTLAGER = async (): Promise<string> => {
  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  return loc.id
}

export async function transferBuchen(
  p: { mengen: Record<string, number>; lose: Record<string, string>; backorder: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  const mengen = { ...p.mengen }

  // Explizit erfasste Lose/Seriennummern vor der Buchung zuordnen
  // (leere Felder überlassen die Zuteilung der Automatik in move_done).
  for (const [moveId, wert] of Object.entries(p.lose)) {
    if (!wert.trim()) continue
    const [row] = await sql<{ tracking: 'lot' | 'serial' | 'none' }[]>`
      select product_tracking(variant_id) as tracking from stock_moves where id = ${moveId}`
    if (!row || row.tracking === 'none') continue
    const lots = parseLotSpec(wert, row.tracking)
    await sql`select set_move_lots(${moveId}, ${sql.json(lots as never)})`
    // Erfasste Lose bestimmen die Ist-Menge, wenn keine explizit angegeben ist.
    if (!(moveId in mengen)) mengen[moveId] = lots.reduce((sum, l) => sum + l.qty, 0)
  }

  await sql`select picking_validate(${pickingId}, ${sql.json(mengen)}, ${p.backorder})`

  // Die Kartonage verlässt das Haus mit der Ware — jetzt wird sie verbraucht.
  await consumePackagingForPicking(pickingId).catch(() => undefined)

  // Nach dem Warenausgang die Sendung an Shopify melden (läuft über die
  // Outbox). Die Rückmeldung darf den Warenausgang nie blockieren — aber sie
  // muss eine Spur hinterlassen.
  try {
    await queueFulfillmentForPicking(pickingId)
  } catch (err) {
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Shopify-Rückmeldung konnte nicht eingereiht werden: ${err instanceof Error ? err.message : String(err)}`})`
      .catch(() => undefined)
  }

  return { recordId: pickingId }
}

export async function transferBestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_confirm(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function verfuegbarkeitPruefen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_check_availability(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function transferStornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_cancel(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function transferRetoure(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ picking_return: string }[]>`select picking_return(${ctx.recordId!})`
  return { recordId: row.picking_return }
}

export async function transferDetails(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update stock_pickings set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

// --- Inventur / Ausschuss ---------------------------------------------------

export async function zaehlungErfassen(
  p: { variant_id: string; counted_qty: number },
): Promise<AktionsErgebnis> {
  const loc = await HAUPTLAGER()
  const [current] = await sql<{ on_hand: number }[]>`
    select coalesce(on_hand, 0) as on_hand from stock_quants
    where location_id = ${loc} and variant_id = ${p.variant_id}`
  const [row] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${loc}, ${p.variant_id}, ${p.counted_qty}, ${current?.on_hand ?? 0})
    returning id`
  return { recordId: row.id }
}

export async function zaehlungBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select inventory_apply(${ctx.recordId!}, ${ctx.actor})`
  const [zaehlung] = await sql<{ variant_id: string }[]>`
    select variant_id from inventory_counts where id = ${ctx.recordId!}`
  const bereit = zaehlung ? await wartendeLieferungenReservieren(zaehlung.variant_id) : 0
  return {
    recordId: ctx.recordId,
    text: bereit > 0
      ? `Differenz gebucht — ${bereit} wartende Lieferung(en) jetzt versandbereit.`
      : undefined,
  }
}

/**
 * Wartende Lieferungen eines Artikels neu reservieren — nach einer Zählung
 * mit Mehrbestand. inventory_apply reserviert selbst nichts (anders als die
 * Fertigmeldung); ohne diesen Schritt blieben Lieferungen trotz Ware auf
 * „wartet" und tauchten nie im Versand auf. Älteste Lieferung zuerst, nur
 * Bewegungen im Zustand „confirmed" (wartet auf Ware) — „waiting" wartet auf
 * einen Vorgänger wie die Fertigung und bleibt unberührt.
 *
 * Rückgabe: Anzahl der Lieferungen, die danach versandbereit sind.
 */
export async function wartendeLieferungenReservieren(variantId: string): Promise<number> {
  const bewegungen = await sql<{ id: string; picking_id: string }[]>`
    select m.id, m.picking_id
    from stock_moves m
    join stock_pickings p on p.id = m.picking_id
    join operation_types ot on ot.id = p.operation_type_id
    where m.variant_id = ${variantId} and m.state = 'confirmed'
      and ot.kind = 'delivery' and p.state not in ('done', 'cancel')
    order by p.scheduled_date, p.created_at, m.id`
  const lieferungen = [...new Set(bewegungen.map((b) => b.picking_id))]
  for (const b of bewegungen) await sql`select move_reserve(${b.id})`
  for (const id of lieferungen) await sql`select picking_recompute_state(${id})`
  if (lieferungen.length === 0) return 0
  const [{ bereit }] = await sql<{ bereit: number }[]>`
    select count(*)::int as bereit from stock_pickings
    where id in ${sql(lieferungen)} and state = 'assigned'`
  return bereit
}

export async function zaehlungLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`delete from inventory_counts where id = ${ctx.recordId!} and applied_at is null`
  return {}
}

export async function ausschussBuchen(
  p: { variant_id: string; qty: number; reason?: string },
): Promise<AktionsErgebnis> {
  const loc = await HAUPTLAGER()
  await sql`select scrap(${p.variant_id}, ${p.qty}, ${loc}, ${p.reason ?? null})`
  return {}
}

// --- Meldebestände ----------------------------------------------------------

export async function meldebestandAnlegen(p: {
  variant_id: string
  min_qty: number
  max_qty: number
  qty_multiple: number
  route?: string
}): Promise<AktionsErgebnis> {
  const produkt = await varianteAufloesen(sql, p.variant_id)
  const loc = await HAUPTLAGER()
  // Zwei Regeln je Produkt hieße zwei widersprüchliche Beschaffungs-
  // Vorschläge — ändern statt doppelt anlegen.
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from stock_orderpoints
    where variant_id = ${produkt.id} and location_id = ${loc}`
  if (vorhanden) {
    throw new Error(
      `Für ${produkt.name} gibt es bereits einen Meldebestand — bitte dort ändern statt neu anlegen.`,
    )
  }
  const [row] = await sql<{ id: string }[]>`
    insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, qty_multiple, route)
    values (${produkt.id}, ${loc}, ${p.min_qty}, ${p.max_qty}, ${p.qty_multiple},
            ${p.route ?? null})
    returning id`
  return { text: `Meldebestand für ${produkt.name} angelegt.`, recordId: row.id }
}

export async function meldebestandLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`delete from stock_orderpoints where id = ${ctx.recordId!}`
  return {}
}

export async function meldebestandSchlummern(
  p: { tage: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update stock_orderpoints
            set snoozed_until = current_date + ${p.tage}::int
            where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function meldebestandWecken(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`update stock_orderpoints set snoozed_until = null where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

/*
 * Legt Bestellung oder Fertigungsauftrag an. Der entstandene Beleg zählt als
 * offener Zulauf, der Vorschlag verschwindet also aus der Liste (0053) — die
 * Rückmeldung muss trotzdem sagen, welcher Beleg entstanden ist, damit der
 * Weg dorthin klickbar bleibt.
 */
export async function beschaffungAusfuehren(
  p: { menge?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ orderpoint_execute: string }[]>`
    select orderpoint_execute(${ctx.recordId!}, ${ctx.actor}, ${p.menge ?? null})`
  const beleg = row.orderpoint_execute

  const istFertigung = beleg.startsWith('MO/')
  const [ziel] = istFertigung
    ? await sql<{ id: string }[]>`select id from manufacturing_orders where number = ${beleg}`
    : await sql<{ id: string }[]>`select id from purchase_orders where number = ${beleg}`

  return {
    text: istFertigung
      ? `Fertigungsauftrag ${beleg} angelegt und bestätigt.`
      : `Position in Bestellung ${beleg} aufgenommen (Entwurf).`,
    link: ziel ? (istFertigung ? `/fertigung/${ziel.id}` : `/einkauf/${ziel.id}`) : undefined,
    recordId: ziel?.id,
  }
}

export async function eroeffnungsbewertung(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select valuation_initialize(null, ${ctx.actor})`
  return {}
}
