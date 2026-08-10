'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'
import {
  cancelShipmentById,
  createLabelForPicking,
  createReturnLabelForPartner,
  queueFulfillmentForPicking,
  syncTracking,
} from '@/modules/versand/service'
import { versandbereitMitVorschlag } from '@/modules/versand/regeln'

export async function createLabel(pickingId: string, formData: FormData) {
  await requireWrite('versand')
  const weightRaw = formData.get('weight_g')
  const product = String(formData.get('dhl_product') ?? '') || undefined

  try {
    const result = await createLabelForPicking(pickingId, {
      weightG: weightRaw ? Number(weightRaw) : undefined,
      product,
    })
    if (result.warnings.length > 0) {
      await sql`select log_event('stock_picking', ${pickingId}, 'note',
        ${`DHL-Hinweise zur Adresse: ${result.warnings.join(' | ')}`}, 'system')`
    }
  } catch (err) {
    // Fehler dauerhaft am Beleg festhalten — nicht nur flüchtig in der UI.
    const message = err instanceof Error ? err.message : String(err)
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`DHL-Label fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`
    return actionFail(err)
  }

  revalidatePath('/versand')
  revalidatePath(`/lager/${pickingId}`)
}

/** Höchstzahl je Massendruck-Lauf — DHL-Aufrufe laufen nacheinander. */
const MASSENDRUCK_LIMIT = 25

/**
 * Massendruck: Labels für alle gefilterten versandbereiten Lieferungen nach
 * Regelvorschlag erstellen; wahlweise direkt ausbuchen (Warenausgang +
 * Shopify-Rückmeldung). Die Filter kommen als Formularfelder mit, damit
 * exakt die angezeigte Liste gedruckt wird.
 */
export async function massLabels(formData: FormData) {
  await requireWrite('versand')
  const ausbuchen = formData.get('ausbuchen') === 'on'
  const rows = await versandbereitMitVorschlag({
    nurEinzelposition: formData.get('einzel') === 'on',
    sku: String(formData.get('sku') ?? ''),
    land: String(formData.get('land') ?? ''),
    produkt: String(formData.get('produkt') ?? ''),
  })
  const offen = rows.filter((r) => Number(r.shipment_count) === 0)
  if (offen.length === 0) return actionError('Kein Treffer ohne vorhandenes Label.')

  const stapel = offen.slice(0, MASSENDRUCK_LIMIT)
  const shipmentIds: string[] = []
  const fehler: string[] = []

  for (const r of stapel) {
    try {
      const result = await createLabelForPicking(r.picking_id)
      shipmentIds.push(result.shipmentId)
      if (ausbuchen) {
        await sql`select picking_validate(${r.picking_id}, ${sql.json({})}, false)`
        await queueFulfillmentForPicking(r.picking_id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fehler.push(`${r.picking_number}: ${message}`)
      await sql`select log_event('stock_picking', ${r.picking_id}, 'error',
        ${`Massendruck fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    }
  }

  revalidatePath('/versand')
  revalidatePath('/lager')

  const rest = offen.length - stapel.length
  const teile = [
    `${shipmentIds.length} Label${shipmentIds.length === 1 ? '' : 's'} erstellt`,
    ausbuchen ? 'Lieferungen ausgebucht' : null,
    rest > 0 ? `${rest} weitere warten (Grenze ${MASSENDRUCK_LIMIT} je Lauf)` : null,
    fehler.length ? `${fehler.length} Fehler: ${fehler.slice(0, 3).join(' | ')}` : null,
  ].filter(Boolean)

  if (shipmentIds.length === 0) return actionError(teile.join(' — '))
  return actionInfo(teile.join(' — ') + '.', `/api/label/sammel?ids=${shipmentIds.join(',')}`)
}

export async function cancelLabel(shipmentId: string) {
  await requireWrite('versand')
  try {
    await cancelShipmentById(shipmentId)
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/versand')
}

export async function refreshTracking() {
  await requireWrite('versand')
  try {
    await syncTracking(10)
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/versand')
}

export async function createReturnLabel(formData: FormData) {
  await requireWrite('versand')
  const partnerId = String(formData.get('partner_id') ?? '')
  if (!partnerId) return actionError('Bitte einen Kunden auswählen')

  try {
    await createReturnLabelForPartner(partnerId, {
      reference: String(formData.get('reference') ?? '') || undefined,
    })
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/versand/retouren')
}
