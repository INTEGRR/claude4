import { sql } from '@/db/client'
import {
  cancelShipmentById,
  consumePackagingForPicking,
  createLabelForPicking,
  createReturnLabelForPartner,
  queueFulfillmentForPicking,
  syncTracking,
} from '@/modules/versand/service'
import { versandbereitMitVorschlag } from '@/modules/versand/regeln'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Versand-Aktionen — Fachlogik aus versand/actions.ts. */

export async function labelErstellen(
  p: { weight_g?: number; dhl_product?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  try {
    const result = await createLabelForPicking(pickingId, {
      weightG: p.weight_g,
      product: p.dhl_product,
    })
    if (result.warnings.length > 0) {
      await sql`select log_event('stock_picking', ${pickingId}, 'note',
        ${`DHL-Hinweise zur Adresse: ${result.warnings.join(' | ')}`}, 'system')`
    }
    return {
      text: `Label ${result.shipmentNumber} erstellt (${result.product}).`,
      recordId: result.shipmentId,
    }
  } catch (err) {
    // Fehler dauerhaft am Beleg festhalten — nicht nur flüchtig in der UI.
    const message = err instanceof Error ? err.message : String(err)
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`DHL-Label fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    throw err
  }
}

export async function labelStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await cancelShipmentById(ctx.recordId!)
  return {}
}

export async function trackingAktualisieren(): Promise<AktionsErgebnis> {
  const r = await syncTracking(10)
  return { text: `${r.checked} Sendung(en) geprüft, ${r.updated} aktualisiert.` }
}

/** Höchstzahl je Massendruck-Lauf — DHL-Aufrufe laufen nacheinander. */
const MASSENDRUCK_LIMIT = 25

export async function massendruck(p: {
  einzel: boolean
  sku: string
  land: string
  produkt: string
  ausbuchen: boolean
}): Promise<AktionsErgebnis> {
  const rows = await versandbereitMitVorschlag({
    nurEinzelposition: p.einzel,
    sku: p.sku,
    land: p.land,
    produkt: p.produkt,
  })
  const offen = rows.filter((r) => Number(r.shipment_count) === 0)
  if (offen.length === 0) throw new Error('Kein Treffer ohne vorhandenes Label.')

  const stapel = offen.slice(0, MASSENDRUCK_LIMIT)
  const shipmentIds: string[] = []
  const fehler: string[] = []

  for (const r of stapel) {
    try {
      const result = await createLabelForPicking(r.picking_id)
      shipmentIds.push(result.shipmentId)
      if (p.ausbuchen) {
        await sql`select picking_validate(${r.picking_id}, ${sql.json({})}, false)`
        await consumePackagingForPicking(r.picking_id)
        await queueFulfillmentForPicking(r.picking_id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fehler.push(`${r.picking_number}: ${message}`)
      await sql`select log_event('stock_picking', ${r.picking_id}, 'error',
        ${`Massendruck fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    }
  }

  const rest = offen.length - stapel.length
  const teile = [
    `${shipmentIds.length} Label${shipmentIds.length === 1 ? '' : 's'} erstellt`,
    p.ausbuchen ? 'Lieferungen ausgebucht' : null,
    rest > 0 ? `${rest} weitere warten (Grenze ${MASSENDRUCK_LIMIT} je Lauf)` : null,
    fehler.length ? `${fehler.length} Fehler: ${fehler.slice(0, 3).join(' | ')}` : null,
  ].filter(Boolean)

  if (shipmentIds.length === 0) throw new Error(teile.join(' — '))
  return { text: teile.join(' — ') + '.', link: `/api/label/sammel?ids=${shipmentIds.join(',')}` }
}

export async function retourenlabelErstellen(p: {
  partner_id: string
  reference?: string
}): Promise<AktionsErgebnis> {
  await createReturnLabelForPartner(p.partner_id, { reference: p.reference })
  return { text: 'Retourenlabel erstellt und an den Kunden gemailt.' }
}
