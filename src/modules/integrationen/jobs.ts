import 'server-only'
import { sql } from '@/db/client'
import {
  ShopifyError,
  ShopifyNurLesen,
  ShopifyProbelauf,
  addOrderTags,
  cancelOrder,
  createFulfillment,
  fetchFulfillmentOrders,
  updateTrackingInfo,
} from './shopify'
import { htmlSicher, sendMail } from './mail'
import type { JobKind } from '@/modules/prozesse/jobs-katalog'

/** Nachschlag über den (aus der DB stammenden) Job-Typ als String. */
function handlerFuer(kind: string): Handler | undefined {
  return (handlers as Record<string, Handler>)[kind]
}

/**
 * Outbox-Runner: alle ausgehenden Aufrufe (Shopify, E-Mail) laufen als Job mit
 * Retry, damit ein fremder Dienst nie eine Datenbanktransaktion blockiert.
 */

type Handler = (payload: Record<string, unknown>) => Promise<string>

const BACKOFF_MINUTES = [1, 5, 15, 60, 180]

/**
 * `satisfies Record<JobKind, …>`: jeder Job aus dem Katalog
 * (prozesse/jobs-katalog.ts) muss einen Handler haben und umgekehrt —
 * ein neuer Job ohne Katalogeintrag bricht den Typecheck, nicht erst
 * die Outbox um drei Uhr nachts.
 */
const handlers = {
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

  /** Meldet einen ERP-Storno an den Shop: Bestellung stornieren + Restock. */
  async shopify_order_cancel(payload) {
    const orderId = String(payload.sales_order_id)
    const [order] = await sql<{ shopify_order_id: string | null; state: string }[]>`
      select shopify_order_id, state from sales_orders where id = ${orderId}`
    if (!order?.shopify_order_id) return 'Kein Shopify-Auftrag — nichts zu stornieren'
    // Zwischenzeitlich reaktiviert (zurück auf Angebot): den Shop in Ruhe lassen.
    if (order.state !== 'cancel') return 'Auftrag ist nicht mehr storniert — übersprungen'

    await cancelOrder(order.shopify_order_id)
    await sql`select log_event('sales_order', ${orderId}, 'note',
      'Shop-Bestellung storniert (Bestand zurückgebucht) — Rückerstattung bitte manuell im Shop.',
      'shopify')`
    return 'Shop-Bestellung storniert; Rückerstattung bleibt manuell'
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
    const { inventarAbgleichen } = await import('./inventar')
    const r = await inventarAbgleichen()
    if (r.gesperrt) return 'Abgleich läuft bereits — der laufende rechnet eine weitere Runde'
    const zusatz = r.ohneZuordnung > 0 ? `, ${r.ohneZuordnung} ohne InventoryItem` : ''
    const runden = r.runden > 1 ? ` in ${r.runden} Runden` : ''
    return `Bestand gemeldet: ${r.uebertragen} Änderung(en) bei ${r.geprueft} Variante(n)${runden}${zusatz}`
  },

  /**
   * Nächtlicher Daten-TÜV: Invarianten der Kern-Ledger prüfen (Bestand =
   * Moves, Bewertung schlüssig, Reservierungen im Rahmen). Befunde lassen den
   * Job absichtlich FEHLSCHLAGEN — roter Badge und Integrationen-Monitor sind
   * genau der Alarmweg, den das ERP für „braucht Aufmerksamkeit" schon hat.
   */
  async daten_tuev() {
    const { datenTuev } = await import('../lager/daten-tuev')
    const r = await datenTuev(sql)
    if (r.befunde.length > 0) {
      const kopf = r.befunde.slice(0, 5).join(' | ')
      const rest = r.befunde.length > 5 ? ` … +${r.befunde.length - 5} weitere` : ''
      throw new Error(`${r.befunde.length} Integritätsbefund(e): ${kopf}${rest}`)
    }
    const warnung =
      r.warnungen.length > 0
        ? ` — ${r.warnungen.length} Warnung(en): ${r.warnungen.slice(0, 3).join(' | ')}` +
          (r.warnungen.length > 3 ? ` … +${r.warnungen.length - 3} weitere` : '')
        : ''
    return `${r.pruefungen} Invarianten geprüft, keine Befunde${warnung}`
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

  /** Änderungen an einem verknüpften Produkt in den Shop übertragen. */
  async shopify_product_push(payload) {
    const { aktualisiereProduktInShopify } = await import('./produkt-push')
    return aktualisiereProduktInShopify(String(payload.template_id))
  },

  /**
   * Produkte aus Shopify verknüpfen/übernehmen, ein Häppchen je Lauf. Zwei
   * Durchgänge über alle Seiten: erst eigenständige Produkte, dann Bundle-
   * Bestandteile (produkt-import.ts, Kopfkommentar).
   */
  async shopify_product_import(payload) {
    const { importProdukteChunk } = await import('./produkt-import')
    const cursor = payload.cursor ? String(payload.cursor) : null
    const durchgang = payload.durchgang === 2 ? 2 : 1
    const r = await importProdukteChunk(cursor, durchgang)
    if (r.nextCursor) {
      await sql`select enqueue_job('shopify_product_import',
        ${sql.json({ cursor: r.nextCursor, durchgang })}, ${`produkt-import:${durchgang}:${r.nextCursor}`})`
    } else if (durchgang === 1) {
      await sql`select enqueue_job('shopify_product_import',
        ${sql.json({ durchgang: 2 })}, 'produkt-import:2:start')`
    }
    const zusatz = [
      r.zweitangebote ? `${r.zweitangebote} Zweitangebot(e) per SKU verknüpft` : '',
      r.bundles ? `${r.bundles} Bundle(s) ohne eigenen Artikel` : '',
    ].filter(Boolean).join(', ')
    const problem = r.probleme.length ? ` — Probleme: ${r.probleme.join(' | ')}` : ''
    const weiter = r.nextCursor
      ? ' — nächste Seite eingereiht'
      : durchgang === 1 ? ' — weiter mit den Bundle-Bestandteilen' : ' — Übernahme abgeschlossen'
    return (
      `Durchgang ${durchgang}: ${r.verknuepft} verknüpft, ${r.angelegt} im ERP angelegt, ${r.uebersprungen} unverändert` +
      (zusatz ? `, ${zusatz}` : '') + weiter + problem
    )
  },

  /** Erstübernahme der Bestellungen (Suchanfrage), ein Häppchen je Lauf. */
  async shopify_order_backfill(payload) {
    const { backfillOrdersChunk } = await import('./import')
    // Alte Jobs tragen noch ein Startdatum (seit); neue eine fertige Anfrage.
    // Eine leere Anfrage ('') heißt „alle" — nicht auf das Startdatum
    // zurückfallen (bis 0089 wurde daraus created_at:>'undefined').
    const q =
      typeof payload.q === 'string' ? payload.q : `created_at:>'${String(payload.seit)}'`
    const cursor = payload.cursor ? String(payload.cursor) : null
    const r = await backfillOrdersChunk(q, cursor)
    if (r.nextCursor) {
      await sql`select enqueue_job('shopify_order_backfill',
        ${sql.json({ q, cursor: r.nextCursor })}, ${`bestell-import:${r.nextCursor}`})`
      return `${r.imported} Bestellung(en) übernommen — nächste Seite eingereiht`
    }
    return `${r.imported} Bestellung(en) übernommen — Übernahme abgeschlossen`
  },

  /** Freigegebenen Mail-Entwurf über das Einkaufspostfach senden (einkauf/mail-senden.ts). */
  async gmail_senden(payload) {
    const { entwurfSenden } = await import('@/modules/einkauf/mail-senden')
    return entwurfSenden(String(payload.entwurf_id))
  },

  /** Eingegangene Nachricht ins Deutsche übersetzen (einkauf/nachricht-uebersetzen.ts). */
  async mail_uebersetzen(payload) {
    const { nachrichtUebersetzen } = await import('@/modules/einkauf/nachricht-uebersetzen')
    return nachrichtUebersetzen(String(payload.nachricht_id))
  },

  /** EZB-Referenzkurse holen und als EUR je Fremdeinheit speichern (einkauf/ezb-abruf.ts, 0097). */
  async ezb_kurse_abrufen() {
    const { ezbKurseAbrufen } = await import('@/modules/einkauf/ezb-abruf')
    return ezbKurseAbrufen()
  },

  /** Mail-Anhang aus dem Einkaufspostfach in die Drive-Ablage (einkauf/anhang-ablage.ts). */
  async gmail_anhang_ablegen(payload) {
    const { anhangAblegen } = await import('@/modules/einkauf/anhang-ablage')
    return anhangAblegen(String(payload.anhang_id))
  },

  /**
   * Retourenlabel an den Kunden. Hängt das Label an einer Reparatur, nennt
   * die Mail die RMA-Nummer — der Zettel im Paket ist am Wareneingang die
   * zweite Kennung neben dem Barcode.
   */
  async send_return_label_email(payload) {
    const labelId = String(payload.return_label_id)
    const [label] = await sql<
      {
        shipment_number: string
        qr_link: string | null
        email: string | null
        name: string
        rma: string | null
      }[]
    >`
      select rl.shipment_number, rl.qr_link, p.email, p.name, r.number as rma
      from return_labels rl
      join partners p on p.id = rl.partner_id
      left join repair_orders r on r.id = rl.repair_order_id
      where rl.id = ${labelId}`
    if (!label) return 'Retourenlabel nicht gefunden'
    if (!label.email) throw new Error(`${label.name} hat keine E-Mail-Adresse`)

    const betreff = label.rma
      ? `Ihr Retourenlabel für die Reparatur ${label.rma}`
      : `Ihr Retourenlabel (${label.shipment_number})`
    const einleitung = label.rma
      ? `<p>anbei das Retourenlabel für Ihre Reparatur <strong>${htmlSicher(label.rma)}</strong>. ` +
        `Bitte kleben Sie das Label auf das Paket und legen Sie einen Zettel mit der Nummer ` +
        `<strong>${htmlSicher(label.rma)}</strong> und einer kurzen Fehlerbeschreibung bei.</p>`
      : '<p>anbei Ihr Retourenlabel.</p>'

    await sendMail({
      to: label.email,
      subject: betreff,
      html:
        `<p>Hallo ${htmlSicher(label.name)},</p>` +
        einleitung +
        `<p>Sendungsnummer: <strong>${htmlSicher(label.shipment_number)}</strong>.</p>` +
        (label.qr_link
          ? `<p>Alternativ ohne Ausdruck per QR-Code: <a href="${htmlSicher(label.qr_link)}">QR-Code öffnen</a></p>`
          : ''),
      attachments: payload.pdf_base64
        ? [{ filename: `Retourenlabel-${label.shipment_number}.pdf`, content: String(payload.pdf_base64) }]
        : undefined,
    })

    await sql`update return_labels set emailed_at = now() where id = ${labelId}`
    return `Retourenlabel an ${label.email} gesendet${label.rma ? ` (${label.rma})` : ''}`
  },

  /**
   * Eingangsbestätigung einer Reparaturanfrage aus dem Kundenformular. Über
   * die Outbox, damit ein Mail-Ausfall die Anfrage nie verliert. Ohne
   * E-Mail (telefonisch erfasst) gibt es nichts zu senden — kein Fehler.
   */
  async send_repair_request_email(payload) {
    const vorgangId = String(payload.vorgang_id)
    const [v] = await sql<
      { number: string; zusatz: { email?: string; kontakt_name?: string } }[]
    >`select number, zusatz from vorgaenge where id = ${vorgangId}`
    if (!v) return 'Anfrage nicht mehr vorhanden'
    const email = String(v.zusatz?.email ?? '').trim()
    if (!email) return 'Keine E-Mail-Adresse — nichts zu senden'
    const name = String(v.zusatz?.kontakt_name ?? '').trim() || 'Kundin/Kunde'

    await sendMail({
      to: email,
      subject: `Ihre Reparaturanfrage ${v.number} ist eingegangen`,
      html:
        `<p>Hallo ${htmlSicher(name)},</p>` +
        `<p>vielen Dank — Ihre Reparaturanfrage ist bei uns eingegangen und hat die Nummer ` +
        `<strong>${htmlSicher(v.number)}</strong>.</p>` +
        `<p>Wir prüfen die Anfrage und melden uns mit einem Retourenlabel für den Versand ` +
        `des Geräts oder mit einer Rückfrage. Bitte schicken Sie das Gerät erst nach Erhalt des Labels.</p>`,
    })
    return `Eingangsbestätigung an ${email} gesendet`
  },
} satisfies Record<JobKind, Handler>

export interface RunResult {
  ran: number
  succeeded: number
  /** Schreibjobs, die wegen „Shopify nur lesen“ bewusst nicht liefen. */
  uebersprungen: number
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
  if (kind === 'shopify_order_cancel' && payload.sales_order_id) {
    return { model: 'sales_order', id: String(payload.sales_order_id) }
  }
  if (kind === 'send_po_email' && payload.purchase_order_id) {
    return { model: 'purchase_order', id: String(payload.purchase_order_id) }
  }
  if (kind === 'shopify_fulfillment_create' && payload.shipment_id) {
    const [row] = await sql<{ picking_id: string | null }[]>`
      select picking_id from shipments where id = ${String(payload.shipment_id)}`
    if (row?.picking_id) return { model: 'stock_picking', id: row.picking_id }
  }
  if (kind === 'send_return_label_email' && payload.return_label_id) {
    const [row] = await sql<{ repair_order_id: string | null }[]>`
      select repair_order_id from return_labels where id = ${String(payload.return_label_id)}`
    if (row?.repair_order_id) return { model: 'repair_order', id: row.repair_order_id }
  }
  if (kind === 'send_repair_request_email' && payload.vorgang_id) {
    return { model: 'vorgang', id: String(payload.vorgang_id) }
  }
  if (kind === 'gmail_anhang_ablegen' && payload.anhang_id) {
    const [row] = await sql<{ thread_id: string }[]>`
      select n.thread_id from mail_anhaenge a join mail_nachrichten n on n.id = a.nachricht_id
      where a.id = ${String(payload.anhang_id)}`
    if (row) return { model: 'mail_thread', id: row.thread_id }
  }
  if (kind === 'gmail_senden' && payload.entwurf_id) {
    return { model: 'mail_entwurf', id: String(payload.entwurf_id) }
  }
  if (kind === 'mail_uebersetzen' && payload.nachricht_id) {
    const [row] = await sql<{ thread_id: string }[]>`
      select thread_id from mail_nachrichten where id = ${String(payload.nachricht_id)}`
    if (row) return { model: 'mail_thread', id: row.thread_id }
  }
  return null
}

/** Arbeitet fällige Jobs ab. Wird vom Cron-Endpunkt aufgerufen. */
/**
 * Zeitbudget je Lauf (0093): Vercel beendet die Funktion nach 60 s. Jobs,
 * die nach Ablauf des Budgets noch nicht begonnen haben, gehen zurück in die
 * Warteschlange statt mitten im Handler abgeschossen zu werden (Drive-
 * Ablagen und Mail-Anhänge dauern länger als ein Shopify-Aufruf).
 */
export const JOB_BUDGET_MS = 40_000

export async function runDueJobs(limit = 20, budgetMs = JOB_BUDGET_MS): Promise<RunResult> {
  const beginn = Date.now()
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
  let uebersprungen = 0

  for (const [i, job] of jobs.entries()) {
    if (Date.now() - beginn > budgetMs) {
      const rest = jobs.slice(i).map((j) => j.id)
      await sql`update integration_jobs
                set status = 'pending', attempts = greatest(attempts - 1, 0), started_at = null
                where id = any(${rest}::uuid[]) and status = 'running'`
      break
    }
    const handler = handlerFuer(job.kind)
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
      if (err instanceof ShopifyProbelauf) {
        // Probelauf: was gesendet worden wäre, steht im Protokoll (Debug-Box).
        // Wie „nur lesen" erledigt, nicht gescheitert — läuft nach dem
        // Scharfschalten nicht nach.
        uebersprungen++
        await sql`update integration_jobs
                  set status = 'done', last_result = ${err.message}, last_error = null, dedupe_key = null
                  where id = ${job.id}`
        continue
      }
      if (err instanceof ShopifyNurLesen) {
        // Staging: der Shop soll nicht beschrieben werden. Der Job ist damit
        // erledigt, nicht gescheitert — er darf nach dem Umschalten NICHT
        // nachlaufen (die Bestellung ist bis dahin im Altsystem erledigt).
        // Sichtbar bleibt es am Beleg und im Job-Monitor.
        uebersprungen++
        await sql`update integration_jobs
                  set status = 'done', last_result = ${`Übersprungen: ${err.message}`},
                      last_error = null, dedupe_key = null
                  where id = ${job.id}`
        const origin = await originForJob(job.kind, job.payload)
        if (origin) {
          await sql`select log_event(${origin.model}, ${origin.id}, 'info',
            ${`${job.kind} übersprungen — Shopify steht auf „nur lesen"`})`
        }
        continue
      }

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

  return { ran: jobs.length, succeeded, failed, uebersprungen }
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
