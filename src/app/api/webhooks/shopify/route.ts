import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { shopifyConfig, verifyWebhookHmac } from '@/modules/integrationen/shopify'

/**
 * Shopify-Webhook-Endpunkt.
 *
 * Grundsatz: nur prüfen und speichern, dann sofort 200 zurückgeben. Shopify
 * bricht nach 5 Sekunden ab und wiederholt bis zu achtmal; die eigentliche
 * Verarbeitung übernimmt der Cron-Job.
 */
export async function POST(request: Request) {
  // Der ROHE Body wird für den HMAC gebraucht - vorher nichts parsen.
  const raw = await request.text()
  const hmac = request.headers.get('x-shopify-hmac-sha256')

  // Webhooks der eigenen App signiert Shopify mit dem Client Secret; ein
  // eigenes SHOPIFY_WEBHOOK_SECRET braucht es nur für Admin-Seiten-Webhooks.
  // shopifyConfig() kennt diese Rangfolge.
  if (!verifyWebhookHmac(raw, hmac, shopifyConfig().webhookSecret || undefined)) {
    return NextResponse.json({ error: 'Ungültige Signatur' }, { status: 401 })
  }

  const webhookId = request.headers.get('x-shopify-webhook-id')
  const topic = request.headers.get('x-shopify-topic') ?? 'unbekannt'
  if (!webhookId) {
    return NextResponse.json({ error: 'Kein Webhook-Identifier' }, { status: 400 })
  }

  let payload: { id?: unknown; admin_graphql_api_id?: unknown }
  try {
    payload = JSON.parse(raw) as typeof payload
  } catch {
    return NextResponse.json({ error: 'Ungültiges JSON' }, { status: 400 })
  }

  // Webhooks liefern numerische IDs, die Admin-API arbeitet mit GIDs.
  const numericId = payload.admin_graphql_api_id ?? payload.id
  const orderGid =
    typeof numericId === 'string' && numericId.startsWith('gid://')
      ? numericId
      : numericId != null
        ? `gid://shopify/Order/${String(numericId)}`
        : null

  // Gleiche Webhook-ID => genau ein Datensatz (Shopify kann doppelt zustellen).
  await sql`
    insert into shopify_webhook_events (webhook_id, topic, shopify_order_id, payload)
    values (${webhookId}, ${topic}, ${orderGid}, ${raw}::jsonb)
    on conflict (webhook_id) do nothing`

  return NextResponse.json({ ok: true })
}
