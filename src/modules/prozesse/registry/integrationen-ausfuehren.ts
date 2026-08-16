import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Integrations-Aktionen. */

export async function klaerfallAufloesen(
  p: { variant_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const lineId = ctx.recordId!
  const [line] = await sql<
    { sku: string | null; variant_gid: string | null; shopify_order_id: string | null }[]
  >`
    select sku, variant_gid, shopify_order_id from shopify_unmatched_lines where id = ${lineId}`
  if (!line) throw new Error('Klärfall nicht gefunden.')

  // Zuordnung dauerhaft an der Variante speichern, damit der nächste Import passt.
  if (line.variant_gid) {
    await sql`update product_variants set shopify_variant_id = ${line.variant_gid}
              where id = ${p.variant_id} and shopify_variant_id is null`
  }
  if (line.sku) {
    await sql`update product_variants set sku = ${line.sku}
              where id = ${p.variant_id} and sku is null`
  }

  await sql`update shopify_unmatched_lines
            set resolved_at = now(), resolved_variant = ${p.variant_id}
            where id = ${lineId}`
  await sql`select log_event('shopify_unmatched', ${lineId}::uuid, 'state',
    'Klärfall aufgelöst', ${ctx.actor})`

  // Sofort heilen: Bestellung frisch holen und den Import erneut anwerfen —
  // der zieht die geklärte Position nach (echter Preis) und bestätigt bei
  // Bezahlung. Schlägt der Abruf fehl, holt der nächste Abgleich das nach.
  if (line.shopify_order_id) {
    try {
      const { fetchOrder } = await import('@/modules/integrationen/shopify')
      const { importShopifyOrder } = await import('@/modules/integrationen/import')
      const order = await fetchOrder(line.shopify_order_id)
      if (order) {
        const ergebnis = await importShopifyOrder(order)
        return {
          text: `Klärfall aufgelöst — ${ergebnis.message}.`,
          recordId: ergebnis.salesOrderId ?? undefined,
        }
      }
    } catch {
      // bewusst still: die Auflösung steht, der Abgleich heilt später.
    }
  }
  return { text: 'Klärfall aufgelöst — der nächste Abgleich zieht die Position nach.' }
}
