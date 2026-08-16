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

// --- Kartonagen (Versand-Konfiguration) --------------------------------------

export async function kartonageSpeichern(p: {
  id?: string
  name: string
  variant_id: string
  capacity: number
  max_content_g: number
  kleinpaket: boolean
  sequence: number
}): Promise<AktionsErgebnis> {
  if (p.id) {
    await sql`
      update packagings set
        name = ${p.name}, variant_id = ${p.variant_id}, capacity = ${p.capacity},
        max_content_g = ${p.max_content_g}, kleinpaket = ${p.kleinpaket},
        sequence = ${p.sequence}
      where id = ${p.id}`
  } else {
    await sql`
      insert into packagings (name, variant_id, capacity, max_content_g, kleinpaket, sequence)
      values (${p.name}, ${p.variant_id}, ${p.capacity}, ${p.max_content_g},
              ${p.kleinpaket}, ${p.sequence})`
  }
  return { text: 'Kartonage gespeichert.' }
}

export async function kartonageSchalten(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update packagings set active = not active where id = ${ctx.recordId!}`
  return {}
}

export async function kartonageLoeschen(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from packagings where id = ${ctx.recordId!}`
  return {}
}

// --- Versandregeln -----------------------------------------------------------

export async function versandregelSpeichern(p: {
  id?: string
  name: string
  sequence: number
  min_weight_g: number | null
  max_weight_g: number | null
  zone: string | null
  skus: string[] | null
  sku_scope: string
  require_kleinpaket_fit: boolean
  dhl_product: string | null
  billing_number: string | null
  insurance_from_value: number | null
}): Promise<AktionsErgebnis> {
  if (p.id) {
    await sql`
      update shipping_rules set
        name = ${p.name}, sequence = ${p.sequence},
        min_weight_g = ${p.min_weight_g}, max_weight_g = ${p.max_weight_g},
        zone = ${p.zone}, skus = ${p.skus}, sku_scope = ${p.sku_scope},
        require_kleinpaket_fit = ${p.require_kleinpaket_fit},
        dhl_product = ${p.dhl_product}, billing_number = ${p.billing_number},
        insurance_from_value = ${p.insurance_from_value}
      where id = ${p.id}`
  } else {
    await sql`
      insert into shipping_rules
        (name, sequence, min_weight_g, max_weight_g, zone, skus, sku_scope,
         require_kleinpaket_fit, dhl_product, billing_number, insurance_from_value)
      values
        (${p.name}, ${p.sequence}, ${p.min_weight_g}, ${p.max_weight_g}, ${p.zone},
         ${p.skus}, ${p.sku_scope}, ${p.require_kleinpaket_fit}, ${p.dhl_product},
         ${p.billing_number}, ${p.insurance_from_value})`
  }
  return { text: 'Regel gespeichert.' }
}

export async function versandregelSchalten(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update shipping_rules set active = not active where id = ${ctx.recordId!}`
  return {}
}

export async function versandregelLoeschen(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from shipping_rules where id = ${ctx.recordId!}`
  return {}
}

export async function versandregelVerschieben(
  p: { richtung: 'hoch' | 'runter' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const regeln = await sql<{ id: string; sequence: number }[]>`
    select id, sequence from shipping_rules order by sequence, name`
  const index = regeln.findIndex((r) => r.id === id)
  const nachbar = p.richtung === 'hoch' ? index - 1 : index + 1
  if (index < 0 || nachbar < 0 || nachbar >= regeln.length) return {}

  // Gleiche sequence-Werte machen den Tausch wirkungslos — dann neu
  // durchnummerieren und noch einmal.
  if (regeln[index].sequence === regeln[nachbar].sequence) {
    for (const [i, r] of regeln.entries()) {
      await sql`update shipping_rules set sequence = ${(i + 1) * 10} where id = ${r.id}`
    }
    return versandregelVerschieben(p, ctx)
  }
  await sql`update shipping_rules set sequence = ${regeln[nachbar].sequence}
            where id = ${regeln[index].id}`
  await sql`update shipping_rules set sequence = ${regeln[index].sequence}
            where id = ${regeln[nachbar].id}`
  return {}
}
