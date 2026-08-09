import 'server-only'
import { sql } from '@/db/client'
import {
  ShopifyError,
  addOrderTags,
  createFulfillment,
  fetchFulfillmentOrders,
  updateTrackingInfo,
} from './shopify'
import { sendMail } from './mail'

/**
 * Outbox-Runner: alle ausgehenden Aufrufe (Shopify, E-Mail) laufen als Job mit
 * Retry, damit ein fremder Dienst nie eine Datenbanktransaktion blockiert.
 */

type Handler = (payload: Record<string, unknown>) => Promise<string>

const BACKOFF_MINUTES = [1, 5, 15, 60, 180]

const handlers: Record<string, Handler> = {
  /** Meldet die Sendung an Shopify: Fulfillment mit Tracking + Kundenmail. */
  async shopify_fulfillment_create(payload) {
    const shipmentId = String(payload.shipment_id)
    const [shipment] = await sql<
      {
        id: string
        shipment_number: string
        tracking_url: string
        carrier: string
        shopify_order_id: string | null
        shopify_fulfillment_id: string | null
        picking_id: string
      }[]
    >`
      select s.id, s.shipment_number, s.tracking_url, s.carrier,
             so.shopify_order_id, s.shopify_fulfillment_id, s.picking_id
      from shipments s
      left join sales_orders so on so.id = s.sales_order_id
      where s.id = ${shipmentId}`

    if (!shipment) return 'Sendung nicht mehr vorhanden'
    if (!shipment.shopify_order_id) return 'Kein Shopify-Auftrag - keine Rückmeldung nötig'
    if (!shipment.shipment_number) return 'Sendung hat keine Trackingnummer'

    const tracking = {
      company: shipment.carrier === 'dhl' ? 'DHL' : shipment.carrier,
      number: shipment.shipment_number,
      url: shipment.tracking_url,
    }

    // Bereits gemeldet: nur die Trackingdaten aktualisieren.
    if (shipment.shopify_fulfillment_id) {
      await updateTrackingInfo(shipment.shopify_fulfillment_id, tracking)
      return 'Trackingdaten in Shopify aktualisiert'
    }

    const fulfillmentOrders = await fetchFulfillmentOrders(shipment.shopify_order_id)
    const open = fulfillmentOrders.filter((fo) =>
      fo.supportedActions.some((a) => a.action === 'CREATE_FULFILLMENT'),
    )
    if (open.length === 0) return 'Shopify hat keine offenen Fulfillments - übersprungen'

    // Welche Mengen wurden tatsächlich geliefert? Danach richtet sich, ob es
    // ein Voll- oder Teil-Fulfillment wird.
    const delivered = await sql<{ sku: string | null; qty: number }[]>`
      select pv.sku, sum(m.qty_done) as qty
      from stock_moves m
      join product_variants pv on pv.id = m.variant_id
      where m.picking_id = ${shipment.picking_id} and m.state = 'done'
      group by pv.sku`
    const deliveredBySku = new Map(delivered.map((d) => [d.sku, Number(d.qty)]))

    const ids: string[] = []
    for (const fo of open) {
      const lineItems = fo.lineItems.nodes
        .map((li) => {
          const available = deliveredBySku.get(li.lineItem.sku) ?? 0
          const qty = Math.min(available, li.remainingQuantity)
          return qty > 0 ? { id: li.id, quantity: qty } : null
        })
        .filter((x): x is { id: string; quantity: number } => x !== null)

      // Deckt die Lieferung alles ab, ohne Positionsangabe fulfillen.
      const isFull = fo.lineItems.nodes.every(
        (li) => (deliveredBySku.get(li.lineItem.sku) ?? 0) >= li.remainingQuantity,
      )
      if (!isFull && lineItems.length === 0) continue

      ids.push(await createFulfillment(fo.id, tracking, isFull ? undefined : lineItems))
    }

    if (ids.length === 0) return 'Keine passenden Positionen zum Fulfillment gefunden'

    await sql`update shipments set shopify_fulfillment_id = ${ids[0]} where id = ${shipmentId}`
    return `Fulfillment in Shopify angelegt (${ids.length}), Kunde wurde benachrichtigt`
  },

  /** Optionaler Status-Tag an der Shopify-Order (Feature standardmäßig aus). */
  async shopify_tag_add(payload) {
    const orderId = String(payload.sales_order_id)
    const [order] = await sql<{ shopify_order_id: string | null }[]>`
      select shopify_order_id from sales_orders where id = ${orderId}`
    if (!order?.shopify_order_id) return 'Kein Shopify-Auftrag'

    const tags = (payload.tags as string[]) ?? []
    if (tags.length === 0) return 'Keine Tags angegeben'

    await addOrderTags(order.shopify_order_id, tags)
    await sql`
      update sales_orders
      set shopify_tags_pushed = array(select distinct unnest(shopify_tags_pushed || ${tags}))
      where id = ${orderId}`
    return `Tags gesetzt: ${tags.join(', ')}`
  },

  /** Bestellung als PDF-Anhang an den Lieferanten. */
  async send_po_email(payload) {
    const orderId = String(payload.purchase_order_id)
    const [order] = await sql<
      { number: string; email: string | null; vendor: string }[]
    >`
      select po.number, p.email, p.name as vendor
      from purchase_orders po join partners p on p.id = po.vendor_id
      where po.id = ${orderId}`
    if (!order) return 'Bestellung nicht gefunden'
    if (!order.email) throw new Error(`Lieferant ${order.vendor} hat keine E-Mail-Adresse`)

    const [company] = await sql<{ name: string }[]>`
      select value ->> 'name' as name from settings where key = 'company'`

    await sendMail({
      to: order.email,
      subject: `Bestellung ${order.number} — ${company?.name ?? 'Bestellung'}`,
      html: String(payload.html ?? ''),
      attachments: payload.pdf_base64
        ? [{ filename: `${order.number}.pdf`, content: String(payload.pdf_base64) }]
        : undefined,
    })

    await sql`update purchase_orders set state = 'sent' where id = ${orderId} and state = 'draft'`
    await sql`select log_event('purchase_order', ${orderId}, 'email',
      ${`Bestellung an ${order.email} gesendet`}, 'system')`
    return `An ${order.email} gesendet`
  },

  /**
   * Verfügbare Mengen an Shopify melden. Der Handler überträgt immer alle
   * gekoppelten Varianten — der Dedupe-Schlüssel „inventar-abgleich" bündelt
   * beliebig viele Auslöser (Cron, Webhook-Abweichung, Handklick) zu einem
   * einzigen Durchlauf.
   */
  async shopify_inventory_push() {
    const { pushInventar } = await import('./inventar')
    const r = await pushInventar()
    const zusatz = r.ohneZuordnung > 0 ? `, ${r.ohneZuordnung} ohne InventoryItem` : ''
    return `Bestand gemeldet: ${r.uebertragen} von ${r.geprueft} Variante(n) geändert${zusatz}`
  },

  /**
   * Erstübernahme der Kunden, ein Häppchen je Lauf (100 Stück). Solange es
   * weitere Seiten gibt, reiht sich der Job mit dem nächsten Cursor selbst
   * wieder ein — der Schlüssel trägt den Cursor, damit der noch laufende
   * Job den Nachfolger nicht wegdedupliziert.
   */
  async shopify_customer_import(payload) {
    const { importCustomersChunk } = await import('./import')
    const cursor = payload.cursor ? String(payload.cursor) : null
    const r = await importCustomersChunk(cursor)
    if (r.nextCursor) {
      await sql`select enqueue_job('shopify_customer_import',
        ${sql.json({ cursor: r.nextCursor })}, ${`kunden-import:${r.nextCursor}`})`
      return `${r.imported} Kunde(n) neu übernommen — nächste Seite eingereiht`
    }
    return `${r.imported} Kunde(n) neu übernommen — Übernahme abgeschlossen`
  },

  /** Produkte aus Shopify verknüpfen/übernehmen, ein Häppchen je Lauf. */
  async shopify_product_import(payload) {
    const { importProdukteChunk } = await import('./produkt-import')
    const cursor = payload.cursor ? String(payload.cursor) : null
    const r = await importProdukteChunk(cursor)
    if (r.nextCursor) {
      await sql`select enqueue_job('shopify_product_import',
        ${sql.json({ cursor: r.nextCursor })}, ${`produkt-import:${r.nextCursor}`})`
    }
    const problem = r.probleme.length ? ` — Probleme: ${r.probleme.join(' | ')}` : ''
    return (
      `${r.verknuepft} verknüpft, ${r.angelegt} im ERP angelegt, ${r.uebersprungen} unverändert` +
      (r.nextCursor ? ' — nächste Seite eingereiht' : ' — Übernahme abgeschlossen') + problem
    )
  },

  /** Erstübernahme der Bestellungen (Suchanfrage), ein Häppchen je Lauf. */
  async shopify_order_backfill(payload) {
    const { backfillOrdersChunk } = await import('./import')
    // Alte Jobs tragen noch ein Startdatum (seit); neue eine fertige Anfrage.
    const q = payload.q ? String(payload.q) : `created_at:>'${String(payload.seit)}'`
    const cursor = payload.cursor ? String(payload.cursor) : null
    const r = await backfillOrdersChunk(q, cursor)
    if (r.nextCursor) {
      await sql`select enqueue_job('shopify_order_backfill',
        ${sql.json({ q, cursor: r.nextCursor })}, ${`bestell-import:${r.nextCursor}`})`
      return `${r.imported} Bestellung(en) übernommen — nächste Seite eingereiht`
    }
    return `${r.imported} Bestellung(en) übernommen — Übernahme abgeschlossen`
  },

  /** Retourenlabel an den Kunden. */
  async send_return_label_email(payload) {
    const labelId = String(payload.return_label_id)
    const [label] = await sql<
      { shipment_number: string; qr_link: string | null; email: string | null; name: string }[]
    >`
      select rl.shipment_number, rl.qr_link, p.email, p.name
      from return_labels rl join partners p on p.id = rl.partner_id
      where rl.id = ${labelId}`
    if (!label) return 'Retourenlabel nicht gefunden'
    if (!label.email) throw new Error(`${label.name} hat keine E-Mail-Adresse`)

    await sendMail({
      to: label.email,
      subject: `Ihr Retourenlabel (${label.shipment_number})`,
      html:
        `<p>Hallo ${label.name},</p>` +
        `<p>anbei Ihr Retourenlabel. Sendungsnummer: <strong>${label.shipment_number}</strong>.</p>` +
        (label.qr_link
          ? `<p>Alternativ ohne Ausdruck per QR-Code: <a href="${label.qr_link}">QR-Code öffnen</a></p>`
          : ''),
      attachments: payload.pdf_base64
        ? [{ filename: `Retourenlabel-${label.shipment_number}.pdf`, content: String(payload.pdf_base64) }]
        : undefined,
    })

    await sql`update return_labels set emailed_at = now() where id = ${labelId}`
    return `Retourenlabel an ${label.email} gesendet`
  },
}

export interface RunResult {
  ran: number
  succeeded: number
  failed: number
}

/**
 * Beleg, an dessen Verlauf ein Job-Fehler gehört. So sieht man am
 * Verkaufsauftrag bzw. an der Lieferung, dass die Rückmeldung hakt.
 */
async function originForJob(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ model: string; id: string } | null> {
  if (kind === 'shopify_tag_add' && payload.sales_order_id) {
    return { model: 'sales_order', id: String(payload.sales_order_id) }
  }
  if (kind === 'send_po_email' && payload.purchase_order_id) {
    return { model: 'purchase_order', id: String(payload.purchase_order_id) }
  }
  if (kind === 'shopify_fulfillment_create' && payload.shipment_id) {
    const [row] = await sql<{ picking_id: string }[]>`
      select picking_id from shipments where id = ${String(payload.shipment_id)}`
    if (row) return { model: 'stock_picking', id: row.picking_id }
  }
  return null
}

/** Arbeitet fällige Jobs ab. Wird vom Cron-Endpunkt aufgerufen. */
export async function runDueJobs(limit = 20): Promise<RunResult> {
  // Hängengebliebene Läufe (Prozessabbruch mitten im Handler) zurückholen.
  await sql`select reap_stuck_jobs()`

  // Jobs einzeln sperren, damit parallele Runner sich nicht in die Quere kommen.
  const jobs = await sql<
    { id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }[]
  >`
    update integration_jobs
    set status = 'running', attempts = attempts + 1, started_at = now()
    where id in (
      select id from integration_jobs
      where status = 'pending' and next_run_at <= now()
      order by next_run_at
      limit ${limit}
      for update skip locked
    )
    returning id, kind, payload, attempts, max_attempts`

  let succeeded = 0
  let failed = 0

  for (const job of jobs) {
    const handler = handlers[job.kind]
    if (!handler) {
      await sql`update integration_jobs
                set status = 'failed', last_error = ${`Unbekannter Job-Typ: ${job.kind}`}
                where id = ${job.id}`
      failed++
      continue
    }

    try {
      const message = await handler(job.payload)
      // Schlüssel freigeben: „dedupe" heißt kein zweiter OFFENER Job — ein
      // erledigter darf einen wiederkehrenden Schlüssel nicht ewig blockieren.
      await sql`update integration_jobs
                set status = 'done', last_result = ${message}, last_error = null,
                    dedupe_key = null
                where id = ${job.id}`
      succeeded++
    } catch (err) {
      failed++
      const message = err instanceof Error ? err.message : String(err)
      const permanent =
        (err instanceof ShopifyError && !err.retryable) || job.attempts >= job.max_attempts
      const delay = BACKOFF_MINUTES[Math.min(job.attempts - 1, BACKOFF_MINUTES.length - 1)]

      await sql`
        update integration_jobs set
          status = ${permanent ? 'failed' : 'pending'},
          last_error = ${message},
          next_run_at = now() + make_interval(mins => ${delay}),
          dedupe_key = case when ${permanent} then null else dedupe_key end
        where id = ${job.id}`

      // Fehler auch am betroffenen Beleg sichtbar machen.
      const origin = await originForJob(job.kind, job.payload)
      if (origin) {
        await sql`select log_event(${origin.model}, ${origin.id}, 'error',
          ${`${job.kind} fehlgeschlagen (Versuch ${job.attempts}/${job.max_attempts}): ${message.slice(0, 300)}`})`
      }
    }
  }

  return { ran: jobs.length, succeeded, failed }
}

/** Stellt einen fehlgeschlagenen Job zur erneuten Ausführung ein. */
export async function retryJob(jobId: string): Promise<void> {
  await sql`
    update integration_jobs
    set status = 'pending', attempts = 0, next_run_at = now(), last_error = null
    where id = ${jobId} and status = 'failed'`
}

/** Holt einen hängengebliebenen 'running'-Job von Hand zurück in die Queue. */
export async function resetRunningJob(jobId: string): Promise<void> {
  await sql`
    update integration_jobs
    set status = 'pending', next_run_at = now(), last_error = 'Manuell zurückgesetzt'
    where id = ${jobId} and status = 'running'`
}
