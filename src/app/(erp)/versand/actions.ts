'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import {
  cancelShipmentById,
  createLabelForPicking,
  createReturnLabelForPartner,
  syncTracking,
} from '@/modules/versand/service'

function fail(err: unknown): never {
  throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
}

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
    fail(err)
  }

  revalidatePath('/versand')
  revalidatePath(`/lager/${pickingId}`)
}

export async function cancelLabel(shipmentId: string) {
  await requireWrite('versand')
  try {
    await cancelShipmentById(shipmentId)
  } catch (err) {
    fail(err)
  }
  revalidatePath('/versand')
}

export async function refreshTracking() {
  await requireWrite('versand')
  try {
    await syncTracking(10)
  } catch (err) {
    fail(err)
  }
  revalidatePath('/versand')
}

export async function createReturnLabel(formData: FormData) {
  await requireWrite('versand')
  const partnerId = String(formData.get('partner_id') ?? '')
  if (!partnerId) throw new Error('Bitte einen Kunden auswählen')

  try {
    await createReturnLabelForPartner(partnerId, {
      reference: String(formData.get('reference') ?? '') || undefined,
    })
  } catch (err) {
    fail(err)
  }
  revalidatePath('/versand/retouren')
}
