'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { parseLotSpec, parseQtyMap } from '@/modules/shared/form'
import { queueFulfillmentForPicking } from '@/modules/versand/service'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'

/** Validiert einen Transfer inkl. abweichender Ist-Mengen und Rückstand. */
export async function validatePicking(pickingId: string, formData: FormData) {
  await requireWrite('lager')

  const done = parseQtyMap(formData, 'done_')
  const backorder = formData.get('backorder') !== 'no'

  try {
    // Explizit erfasste Lose/Seriennummern vor der Buchung zuordnen
    // (leere Felder überlassen die Zuteilung der Automatik in move_done).
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('lots_') || typeof value !== 'string' || !value.trim()) continue
      const moveId = key.slice('lots_'.length)
      const [row] = await sql<{ tracking: 'lot' | 'serial' | 'none' }[]>`
        select product_tracking(variant_id) as tracking from stock_moves where id = ${moveId}`
      if (!row || row.tracking === 'none') continue
      const lots = parseLotSpec(value, row.tracking)
      await sql`select set_move_lots(${moveId}, ${sql.json(lots as never)})`
      // Erfasste Lose bestimmen die Ist-Menge, wenn keine explizit angegeben ist.
      if (!(moveId in done)) done[moveId] = lots.reduce((sum, l) => sum + l.qty, 0)
    }

    await sql`select picking_validate(${pickingId}, ${sql.json(done)}, ${backorder})`
  } catch (err) {
    return actionFail(err)
  }

  // Nach dem Warenausgang die Sendung an Shopify melden (läuft über die Outbox).
  try {
    await queueFulfillmentForPicking(pickingId)
  } catch (err) {
    // Die Rückmeldung darf den Warenausgang nie blockieren — aber sie
    // muss eine Spur hinterlassen.
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Shopify-Rückmeldung konnte nicht eingereiht werden: ${err instanceof Error ? err.message : String(err)}`})`
      .catch(() => undefined)
  }

  revalidatePath(`/lager/${pickingId}`)
  revalidatePath('/lager')
  revalidatePath('/versand')
}

export async function confirmPicking(pickingId: string) {
  await requireWrite('lager')
  await sql`select picking_confirm(${pickingId})`
  revalidatePath(`/lager/${pickingId}`)
}

export async function checkAvailability(pickingId: string) {
  await requireWrite('lager')
  await sql`select picking_check_availability(${pickingId})`
  revalidatePath(`/lager/${pickingId}`)
}

export async function cancelPicking(pickingId: string) {
  await requireWrite('lager')
  try {
    await sql`select picking_cancel(${pickingId})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/lager/${pickingId}`)
  revalidatePath('/lager')
}

export async function returnPicking(pickingId: string) {
  await requireWrite('lager')
  let newId: string
  try {
    const [row] = await sql<{ picking_return: string }[]>`select picking_return(${pickingId})`
    newId = row.picking_return
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/lager')
  revalidatePath(`/lager/${newId}`)
}

// --- Inventur --------------------------------------------------------------

export async function createCount(formData: FormData) {
  await requireWrite('lager')
  const variantId = String(formData.get('variant_id') ?? '')
  const counted = Number(formData.get('counted_qty') ?? NaN)
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  if (!Number.isFinite(counted) || counted < 0) return actionError('Bitte eine gültige Menge erfassen')

  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  const [current] = await sql<{ on_hand: number }[]>`
    select coalesce(on_hand, 0) as on_hand from stock_quants
    where location_id = ${loc.id} and variant_id = ${variantId}`

  await sql`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${loc.id}, ${variantId}, ${counted}, ${current?.on_hand ?? 0})`
  revalidatePath('/lager/inventur')
}

export async function applyCount(countId: string) {
  const user = await requireWrite('lager')
  try {
    await sql`select inventory_apply(${countId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/lager/inventur')
  revalidatePath('/lager/bestand')
}

export async function deleteCount(countId: string) {
  await requireWrite('lager')
  await sql`delete from inventory_counts where id = ${countId} and applied_at is null`
  revalidatePath('/lager/inventur')
}

// --- Ausschuss -------------------------------------------------------------

export async function scrapProduct(formData: FormData) {
  await requireWrite('lager')
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  const reason = String(formData.get('reason') ?? '').trim() || null
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  if (!(qty > 0)) return actionError('Die Menge muss größer als 0 sein')

  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  try {
    await sql`select scrap(${variantId}, ${qty}, ${loc.id}, ${reason})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/lager/bestand')
}

/** Verantwortlichen und Priorität des Transfers setzen (stock.picking). */
export async function updatePickingDetails(pickingId: string, formData: FormData) {
  await requireWrite('lager')
  await sql`
    update stock_pickings set
      user_id = ${String(formData.get('user_id') ?? '') || null},
      priority = ${formData.get('priority') === 'on' ? '1' : '0'}
    where id = ${pickingId}`
  revalidatePath(`/lager/${pickingId}`)
}

// --- Meldebestände (Reordering Rules) --------------------------------------

export async function createOrderpoint(formData: FormData) {
  await requireWrite('lager')
  const variantId = String(formData.get('variant_id') ?? '')
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  const min = Number(formData.get('min_qty') ?? 0)
  const max = Number(formData.get('max_qty') ?? 0)
  if (max < min) return actionError('Der Maximalbestand darf den Mindestbestand nicht unterschreiten')

  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  try {
    await sql`
      insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, qty_multiple, route)
      values (${variantId}, ${loc.id}, ${min}, ${max},
              ${Number(formData.get('qty_multiple') ?? 1) || 1},
              ${String(formData.get('route') ?? '') || null})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/lager/beschaffung')
}

export async function deleteOrderpoint(orderpointId: string) {
  await requireWrite('lager')
  await sql`delete from stock_orderpoints where id = ${orderpointId}`
  revalidatePath('/lager/beschaffung')
}

/** Vorschlag für einige Tage stummschalten (Odoo: snoozed_until). */
/*
 * Keine Rückmeldung am Knopf: Mit dem Schlummern verschwindet die Zeile aus
 * den Vorschlägen und nimmt die Meldung mit. Stattdessen steht oben auf der
 * Seite dauerhaft, wie viele Regeln schlummern — das überlebt den Neuaufbau
 * und ist auch morgen noch zu sehen.
 */
export async function snoozeOrderpoint(orderpointId: string, days: number) {
  await requireWrite('lager')
  await sql`update stock_orderpoints
            set snoozed_until = current_date + ${days}::int
            where id = ${orderpointId}`
  revalidatePath('/lager/beschaffung')
}

/*
 * Legt Bestellung oder Fertigungsauftrag an. Beides entsteht als Entwurf und
 * verändert die Prognose noch nicht — der Vorschlag bleibt also stehen.
 * Deshalb muss die Rückmeldung sagen, welcher Beleg entstanden ist; sonst
 * sieht es aus, als hätte der Knopf nichts getan.
 */
export async function executeOrderpoint(orderpointId: string) {
  const user = await requireWrite('lager')
  let beleg: string
  try {
    const [row] = await sql<{ orderpoint_execute: string }[]>`
      select orderpoint_execute(${orderpointId}, ${user.name})`
    beleg = row.orderpoint_execute
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/lager/beschaffung')
  revalidatePath('/einkauf')
  revalidatePath('/fertigung')

  const istFertigung = beleg.startsWith('MO/')
  const [ziel] = istFertigung
    ? await sql<{ id: string }[]>`select id from manufacturing_orders where number = ${beleg}`
    : await sql<{ id: string }[]>`select id from purchase_orders where number = ${beleg}`

  return actionInfo(
    istFertigung
      ? `Fertigungsauftrag ${beleg} angelegt und bestätigt.`
      : `Position in Bestellung ${beleg} aufgenommen (Entwurf).`,
    ziel ? (istFertigung ? `/fertigung/${ziel.id}` : `/einkauf/${ziel.id}`) : undefined,
  )
}

/** Schlummern beenden — sonst bliebe die Regel unauffindbar stumm. */
export async function wakeOrderpoint(orderpointId: string) {
  await requireWrite('lager')
  await sql`update stock_orderpoints set snoozed_until = null where id = ${orderpointId}`
  revalidatePath('/lager/beschaffung')
}

/**
 * Eröffnungsbewertung: bewertet Altbestand, der vor Einführung der
 * Wertschicht entstanden ist, zum hinterlegten Einstandspreis.
 */
export async function initializeValuation() {
  const user = await requireWrite('lager')
  await sql`select valuation_initialize(null, ${user.name})`
  revalidatePath('/lager/bewertung')
  revalidatePath('/auswertungen')
}
