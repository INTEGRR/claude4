'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { parseQtyMap } from '@/modules/shared/form'
import { queueFulfillmentForPicking } from '@/modules/versand/service'

function fail(err: unknown): never {
  throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
}

/** Validiert einen Transfer inkl. abweichender Ist-Mengen und Rückstand. */
export async function validatePicking(pickingId: string, formData: FormData) {
  await requireWrite('lager')

  const done = parseQtyMap(formData, 'done_')
  const backorder = formData.get('backorder') !== 'no'

  try {
    await sql`select picking_validate(${pickingId}, ${sql.json(done)}, ${backorder})`
  } catch (err) {
    fail(err)
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
    fail(err)
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
    fail(err)
  }
  revalidatePath('/lager')
  revalidatePath(`/lager/${newId}`)
}

// --- Inventur --------------------------------------------------------------

export async function createCount(formData: FormData) {
  await requireWrite('lager')
  const variantId = String(formData.get('variant_id') ?? '')
  const counted = Number(formData.get('counted_qty') ?? NaN)
  if (!variantId) throw new Error('Bitte ein Produkt auswählen')
  if (!Number.isFinite(counted) || counted < 0) throw new Error('Bitte eine gültige Menge erfassen')

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
    fail(err)
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
  if (!variantId) throw new Error('Bitte ein Produkt auswählen')
  if (!(qty > 0)) throw new Error('Die Menge muss größer als 0 sein')

  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  try {
    await sql`select scrap(${variantId}, ${qty}, ${loc.id}, ${reason})`
  } catch (err) {
    fail(err)
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
