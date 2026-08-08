import 'server-only'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sql } from '@/db/client'
import {
  DhlError,
  cancelShipment,
  createReturnLabel,
  createShipment,
  dhlConfig,
  dhlConfigured,
  productForCountry,
  toAlpha3,
  trackShipment,
  trackingUrl,
} from './dhl'

/**
 * Labels werden bei uns gespeichert, weil DHL sie nur rund drei Tage vorhält.
 *
 * Die verlässliche Ablage ist die Datenbank (Spalte label_pdf) — sie
 * überlebt auch eine zustandslose Umgebung wie Vercel, wo nur /tmp
 * beschreibbar ist und beim nächsten Aufruf leer sein kann. Zusätzlich legen
 * wir die Datei ab, wenn ein dauerhaftes Verzeichnis konfiguriert ist; das
 * ist der Docker-Betrieb mit gemountetem Volume.
 */
const STORAGE_DIR = process.env.STORAGE_DIR
const DATEIABLAGE = Boolean(STORAGE_DIR) || !process.env.VERCEL

async function storeLabel(name: string, base64: string): Promise<string | null> {
  if (!DATEIABLAGE) return null
  const dir = path.join(STORAGE_DIR ?? path.join(process.cwd(), 'storage'), 'labels')
  try {
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await writeFile(file, Buffer.from(base64, 'base64'))
    return path.relative(process.cwd(), file)
  } catch {
    // Kein Schreibrecht: das PDF liegt ohnehin in der Datenbank, der Versand
    // darf daran nicht scheitern.
    return null
  }
}

interface CompanySettings {
  name: string
  street: string
  house: string
  zip: string
  city: string
  country: string
  email?: string
  phone?: string
}

async function companySettings(): Promise<CompanySettings> {
  const [row] = await sql<{ value: CompanySettings }[]>`
    select value from settings where key = 'company'`
  return row.value
}

export interface CreateLabelResult {
  shipmentId: string
  shipmentNumber: string
  labelPath: string | null
  warnings: string[]
}

/**
 * Erstellt ein DHL-Label für eine Lieferung. Läuft bewusst synchron (nicht
 * über die Outbox): am Packtisch wird das Label sofort gebraucht.
 */
export async function createLabelForPicking(
  pickingId: string,
  opts: { weightG?: number; product?: string } = {},
): Promise<CreateLabelResult> {
  if (!dhlConfigured()) {
    throw new DhlError(
      'DHL ist nicht konfiguriert. Bitte API-Key, GKP-Zugang und Abrechnungsnummer in den Einstellungen hinterlegen.',
    )
  }

  const [picking] = await sql<
    {
      id: string
      number: string
      state: string
      sales_order_id: string | null
      sales_order_number: string | null
      ship_name: string | null
      ship_street: string | null
      ship_house_number: string | null
      ship_street2: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
      ship_email: string | null
      ship_phone: string | null
      partner_name: string | null
      partner_street: string | null
      partner_house: string | null
      partner_zip: string | null
      partner_city: string | null
      partner_country: string | null
      partner_email: string | null
      weight_g: number
    }[]
  >`
    select p.id, p.number, p.state,
           so.id as sales_order_id, so.number as sales_order_number,
           so.ship_name, so.ship_street, so.ship_house_number, so.ship_street2,
           so.ship_zip, so.ship_city, so.ship_country_code, so.ship_email, so.ship_phone,
           part.name as partner_name, part.street as partner_street,
           part.house_number as partner_house, part.zip as partner_zip,
           part.city as partner_city, part.country_code as partner_country,
           part.email as partner_email,
           (select coalesce(sum(pt.weight_g * m.qty), 0)::int
              from stock_moves m
              join product_variants pv on pv.id = m.variant_id
              join product_templates pt on pt.id = pv.template_id
             where m.picking_id = p.id and m.state <> 'cancel') as weight_g
    from stock_pickings p
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners part on part.id = p.partner_id
    where p.id = ${pickingId}`

  if (!picking) throw new Error('Lieferung nicht gefunden')
  if (picking.state === 'done') throw new Error('Die Lieferung ist bereits abgeschlossen')
  if (picking.state === 'cancel') throw new Error('Die Lieferung ist storniert')

  const [open] = await sql<{ count: number }[]>`
    select count(*)::int as count from shipments
    where picking_id = ${pickingId} and state not in ('cancelled', 'failure')`
  if (Number(open.count) > 0) {
    throw new Error('Für diese Lieferung existiert bereits ein Label. Bitte zuerst stornieren.')
  }

  // Adresse aus dem Auftrag (eingefroren beim Import), sonst aus dem Kontakt.
  const name = picking.ship_name ?? picking.partner_name ?? ''
  const street = picking.ship_street ?? picking.partner_street ?? ''
  const houseNumber = picking.ship_house_number ?? picking.partner_house ?? ''
  const zip = picking.ship_zip ?? picking.partner_zip ?? ''
  const city = picking.ship_city ?? picking.partner_city ?? ''
  const countryAlpha2 = picking.ship_country_code ?? picking.partner_country ?? 'DE'

  if (!name || !street || !zip || !city) {
    throw new Error('Die Lieferadresse ist unvollständig (Name, Straße, PLZ und Ort werden benötigt).')
  }

  const company = await companySettings()
  const [settings] = await sql<{ print_format: string; default_product: string }[]>`
    select value ->> 'print_format' as print_format,
           value ->> 'default_product' as default_product
    from settings where key = 'dhl'`

  const weightG = Math.max(opts.weightG ?? Number(picking.weight_g) ?? 0, 1)
  const product = opts.product ?? productForCountry(countryAlpha2)
  const reference = picking.sales_order_number ?? picking.number

  const result = await createShipment({
    product,
    reference,
    weightG,
    printFormat: settings?.print_format ?? '910-300-700',
    shipper: {
      name: company.name,
      street: company.street,
      houseNumber: company.house,
      zip: company.zip,
      city: company.city,
      country: toAlpha3(company.country),
      email: company.email,
      phone: company.phone,
    },
    consignee: {
      name,
      street,
      houseNumber,
      addition: picking.ship_street2 ?? undefined,
      zip,
      city,
      country: toAlpha3(countryAlpha2),
      email: picking.ship_email ?? picking.partner_email ?? undefined,
      phone: picking.ship_phone ?? undefined,
    },
  })

  const labelPath = result.labelBase64
    ? await storeLabel(`${result.shipmentNumber}.pdf`, result.labelBase64)
    : null

  const [shipment] = await sql<{ id: string }[]>`
    insert into shipments (
      picking_id, sales_order_id, dhl_product, billing_number, weight_g,
      shipment_number, tracking_url, label_path, label_pdf, label_format, dhl_warnings)
    values (
      ${pickingId}, ${picking.sales_order_id}, ${product}, ${dhlConfig().billingNumber},
      ${weightG}, ${result.shipmentNumber}, ${result.trackingUrl}, ${labelPath},
      ${result.labelBase64 ? Buffer.from(result.labelBase64, 'base64') : null},
      ${settings?.print_format ?? '910-300-700'},
      ${result.warnings.length ? sql.json(result.warnings) : null})
    returning id`

  await sql`select log_event('stock_picking', ${pickingId}, 'note',
    ${`DHL-Label erstellt: ${result.shipmentNumber}`}, 'system')`

  return {
    shipmentId: shipment.id,
    shipmentNumber: result.shipmentNumber,
    labelPath,
    warnings: result.warnings,
  }
}

/** Storniert eine Sendung bei DHL (nur vor dem Tagesabschluss möglich). */
export async function cancelShipmentById(shipmentId: string): Promise<void> {
  const [shipment] = await sql<{ shipment_number: string; state: string; picking_id: string }[]>`
    select shipment_number, state, picking_id from shipments where id = ${shipmentId}`
  if (!shipment) throw new Error('Sendung nicht gefunden')
  if (shipment.state === 'cancelled') return
  if (shipment.state === 'delivered') throw new Error('Zugestellte Sendungen können nicht storniert werden')

  await cancelShipment(shipment.shipment_number)
  await sql`update shipments set state = 'cancelled' where id = ${shipmentId}`
  await sql`select log_event('stock_picking', ${shipment.picking_id}, 'note',
    ${`DHL-Sendung ${shipment.shipment_number} storniert`}, 'system')`
}

/**
 * Nach der Validierung der Lieferung: Fulfillment an Shopify melden.
 * Wird als Job eingereiht, damit ein Shopify-Ausfall den Warenausgang nicht
 * blockiert.
 */
export async function queueFulfillmentForPicking(pickingId: string): Promise<void> {
  const shipments = await sql<{ id: string }[]>`
    select s.id from shipments s
    join sales_orders so on so.id = s.sales_order_id
    where s.picking_id = ${pickingId}
      and s.state not in ('cancelled')
      and s.shopify_fulfillment_id is null
      and so.shopify_order_id is not null`

  for (const shipment of shipments) {
    await sql`select enqueue_job('shopify_fulfillment_create',
      ${sql.json({ shipment_id: shipment.id })}, ${`fulfillment:${shipment.id}`})`
  }
}

/**
 * Tracking-Abgleich. Achtung DHL-Limit: initial 250 Abfragen/Tag und eine
 * Abfrage alle 5 Sekunden - deshalb kleine Stapel und Pause zwischen Abfragen.
 */
export async function syncTracking(limit = 20): Promise<{ checked: number; updated: number }> {
  const shipments = await sql<{ id: string; shipment_number: string; state: string }[]>`
    select id, shipment_number, state from shipments
    where state in ('created', 'manifested', 'transit')
      and shipment_number is not null
      and (last_tracking_check is null or last_tracking_check < now() - interval '2 hours')
    order by last_tracking_check nulls first
    limit ${limit}`

  let updated = 0
  for (const [index, shipment] of shipments.entries()) {
    if (index > 0) await new Promise((r) => setTimeout(r, 5500))

    try {
      const result = await trackShipment(shipment.shipment_number)
      if (!result) {
        await sql`update shipments set last_tracking_check = now() where id = ${shipment.id}`
        continue
      }

      const state =
        result.status === 'delivered'
          ? 'delivered'
          : result.status === 'transit'
            ? 'transit'
            : result.status === 'failure'
              ? 'failure'
              : shipment.state

      await sql`
        update shipments set
          state = ${state}::shipment_state,
          last_tracking_event = ${sql.json({ ...result })},
          last_tracking_check = now(),
          delivered_at = case when ${result.status} = 'delivered' then now() else delivered_at end
        where id = ${shipment.id}`
      if (state !== shipment.state) updated++
    } catch (err) {
      if (err instanceof DhlError && err.status === 429) break // Limit erreicht
      await sql`update shipments set last_tracking_check = now() where id = ${shipment.id}`
    }
  }

  return { checked: shipments.length, updated }
}

/**
 * Löscht Trackingdaten 30 Tage nach Zustellung - Auflage aus dem
 * DHL-Nutzungsvertrag.
 */
export async function pruneTrackingData(): Promise<number> {
  const rows = await sql`
    update shipments set last_tracking_event = null
    where state = 'delivered' and delivered_at < now() - interval '30 days'
      and last_tracking_event is not null
    returning id`
  return rows.length
}

/** Retourenlabel für einen Kunden erzeugen und per E-Mail schicken. */
export async function createReturnLabelForPartner(
  partnerId: string,
  opts: { repairOrderId?: string; salesOrderId?: string; reference?: string } = {},
): Promise<{ id: string; shipmentNumber: string }> {
  if (!dhlConfigured()) throw new DhlError('DHL ist nicht konfiguriert')

  const [partner] = await sql<
    {
      name: string
      street: string | null
      house_number: string | null
      zip: string | null
      city: string | null
      country_code: string
      email: string | null
    }[]
  >`select name, street, house_number, zip, city, country_code, email
     from partners where id = ${partnerId}`
  if (!partner) throw new Error('Kontakt nicht gefunden')
  if (!partner.street || !partner.zip || !partner.city) {
    throw new Error('Die Adresse des Kunden ist unvollständig')
  }

  const result = await createReturnLabel(
    {
      name: partner.name,
      street: partner.street,
      houseNumber: partner.house_number ?? '',
      zip: partner.zip,
      city: partner.city,
      country: toAlpha3(partner.country_code),
      email: partner.email ?? undefined,
    },
    opts.reference ?? 'Retoure',
  )

  const labelPath = result.labelBase64
    ? await storeLabel(`retoure-${result.shipmentNumber}.pdf`, result.labelBase64)
    : null

  const [row] = await sql<{ id: string }[]>`
    insert into return_labels (
      repair_order_id, sales_order_id, partner_id, shipment_number,
      label_path, label_pdf, qr_link)
    values (${opts.repairOrderId ?? null}, ${opts.salesOrderId ?? null}, ${partnerId},
            ${result.shipmentNumber},
            ${labelPath},
            ${result.labelBase64 ? Buffer.from(result.labelBase64, 'base64') : null},
            ${result.qrLink ?? null})
    returning id`

  await sql`select enqueue_job('send_return_label_email',
    ${sql.json({ return_label_id: row.id, pdf_base64: result.labelBase64 ?? null })},
    ${`return-label:${row.id}`})`

  return { id: row.id, shipmentNumber: result.shipmentNumber }
}

export { trackingUrl }
