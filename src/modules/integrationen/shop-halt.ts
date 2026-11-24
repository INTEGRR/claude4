import 'server-only'
import type { TransactionSql } from 'postgres'
import { sql, tx } from '@/db/client'
import { fetchOrder, fetchOrderHalt, shopifyConfigured } from './shopify'
import { type ShopHalt, haltAenderung, haltAusShop, haltText } from './shop-halt-logik'

/**
 * Fulfillment-Halt aus Shopify (0134, Entscheidungslog 2026-11-24).
 *
 * Gesetzt und aufgehoben wird der Halt NUR im Shop. KRNL liest ihn mit —
 * über die Halt-Webhooks, bei jedem Bestell-Import und noch einmal frisch
 * unmittelbar vor jedem Label — und sperrt so lange den Versand.
 */

/**
 * Der Halt einer Bestellung, frisch aus dem Shop.
 * null = nicht angehalten, undefined = nicht feststellbar (Shop nicht
 * erreichbar) — dann bleibt der gespeicherte Stand unangetastet.
 *
 * Die Einzelheiten (Grund, Notiz) brauchen das Recht auf Fulfillment-
 * Aufträge. Fehlt es, entscheidet der Anzeige-Status der Bestellung.
 */
async function haltVomShop(orderGid: string, anzeigeStatus?: string | null): Promise<ShopHalt | null | undefined> {
  try {
    const r = await fetchOrderHalt(orderGid)
    if (r) return haltAusShop(r.displayFulfillmentStatus, r.auftraege)
  } catch {
    // Recht fehlt oder Shop gestört: unten mit dem Anzeige-Status weiter.
  }
  if (anzeigeStatus !== undefined) return haltAusShop(anzeigeStatus, null)
  try {
    const order = await fetchOrder(orderGid)
    return order ? haltAusShop(order.displayFulfillmentStatus, null) : undefined
  } catch {
    return undefined
  }
}

/**
 * Für den Bestell-Import: muss der Halt geprüft werden, und wie steht er?
 * Der Normalfall (weder Shop noch KRNL kennen einen Halt) kostet keinen
 * zusätzlichen Shop-Aufruf — am Release-Tag zählt jeder. `frisch` erzwingt
 * die Prüfung (Halt-Webhook: der Anzeige-Status der Bestellung zeigt einen
 * Teil-Halt nicht sicher).
 */
export async function shopHaltLesen(
  order: { id: string; displayFulfillmentStatus: string | null },
  frisch = false,
): Promise<ShopHalt | null | undefined> {
  if (!frisch && order.displayFulfillmentStatus !== 'ON_HOLD') {
    const [vor] = await sql<{ halt: boolean }[]>`
      select shopify_halt as halt from sales_orders where shopify_order_id = ${order.id}`
    if (!vor?.halt) return undefined
  }
  return haltVomShop(order.id, order.displayFulfillmentStatus)
}

/**
 * Schreibt den Halt an den Auftrag, wenn sich etwas geändert hat, und hält
 * es im Verlauf fest. `undefined` = nicht geprüft, nichts tun. Rückgabe:
 * Meldung für Webhook und Monitor, null wenn alles beim Alten blieb.
 */
export async function haltNachziehen(
  t: TransactionSql,
  auftragId: string,
  halt: ShopHalt | null | undefined,
): Promise<string | null> {
  if (halt === undefined) return null
  const [vor] = await t<{ halt: boolean; grund: string | null; notiz: string | null }[]>`
    select shopify_halt as halt, shopify_halt_grund as grund, shopify_halt_notiz as notiz
    from sales_orders where id = ${auftragId} for update`
  if (!vor) return null
  const art = haltAenderung(vor, halt)
  if (!art) return null

  if (!halt) {
    // Grund und Notiz bleiben stehen — als Packhinweis („Kabel beilegen").
    await t`update sales_orders set shopify_halt = false, shopify_halt_seit = null where id = ${auftragId}`
    await t`select log_event('sales_order', ${auftragId}, 'note',
      'Halt in Shopify aufgehoben — der Versand ist wieder frei.', 'shopify')`
    return 'Halt in Shopify aufgehoben'
  }
  await t`
    update sales_orders
       set shopify_halt = true, shopify_halt_grund = ${halt.grund}, shopify_halt_notiz = ${halt.notiz},
           shopify_halt_seit = coalesce(shopify_halt_seit, now())
     where id = ${auftragId}`
  await t`select log_event('sales_order', ${auftragId}, 'note',
    ${`In Shopify angehalten (${haltText(halt)}) — Versand gesperrt, bis der Shop freigibt.`}, 'shopify')`
  return art === 'gesetzt'
    ? `in Shopify angehalten (${haltText(halt)})`
    : `Halt in Shopify geändert (${haltText(halt)})`
}

/**
 * Unmittelbar vor dem Label: den Halt FRISCH im Shop nachsehen. Fängt beide
 * Lücken eines verlorenen Webhooks — der Halt wurde eben erst gesetzt (kein
 * Paket geht am Halt vorbei) oder eben erst aufgehoben (niemand wartet auf
 * den nächsten Abgleich). Ist der Shop nicht erreichbar, gilt der
 * gespeicherte Stand. Wirft mit Grund und Notiz, wenn angehalten.
 */
export async function versandHaltPruefen(pickingId: string): Promise<void> {
  const [so] = await sql<{ id: string; shopify_order_id: string | null }[]>`
    select so.id, so.shopify_order_id
    from stock_pickings p
    join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    where p.id = ${pickingId}`
  if (!so?.shopify_order_id) return
  if (shopifyConfigured()) {
    const halt = await haltVomShop(so.shopify_order_id)
    if (halt !== undefined) await tx((t) => haltNachziehen(t, so.id, halt))
  }
  const [jetzt] = await sql<
    { halt: boolean; grund: string | null; notiz: string | null; name: string }[]
  >`
    select shopify_halt as halt, shopify_halt_grund as grund, shopify_halt_notiz as notiz,
           coalesce(shopify_order_name, number) as name
    from sales_orders where id = ${so.id}`
  if (jetzt?.halt) {
    throw new Error(`${jetzt.name} ist in Shopify angehalten (${haltText(jetzt)}) — erst dort freigeben, dann versenden.`)
  }
}
