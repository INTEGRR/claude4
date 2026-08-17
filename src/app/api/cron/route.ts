import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { processPendingWebhooks, reconcileOrders } from '@/modules/integrationen/import'
import { runDueJobs } from '@/modules/integrationen/jobs'
import { pruneMonitorData } from '@/modules/integrationen/transaktionen'
import { pruneTrackingData, syncTracking } from '@/modules/versand/service'
import { pruneSessions } from '@/modules/auth'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { dhlConfigured } from '@/modules/versand/dhl'

export const maxDuration = 60

/**
 * Sammelendpunkt für geplante Aufgaben. Aufruf über Vercel Cron:
 *
 *   /api/cron?task=webhooks      jede Minute   - Shopify-Events verarbeiten
 *   /api/cron?task=jobs          jede Minute   - Outbox abarbeiten
 *   /api/cron?task=reconcile     alle 15 Min   - Abgleich mit Shopify
 *   /api/cron?task=tracking      stündlich     - DHL-Sendungsstatus
 *   /api/cron?task=analytics     nachts        - Kennzahlen neu berechnen
 *   /api/cron?task=housekeeping  täglich       - Aufräumen
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Nicht berechtigt' }, { status: 401 })
    }
  }

  const task = new URL(request.url).searchParams.get('task') ?? 'jobs'

  try {
    switch (task) {
      case 'webhooks': {
        if (!shopifyConfigured()) return NextResponse.json({ skipped: 'Shopify nicht konfiguriert' })
        return NextResponse.json({ task, ...(await processPendingWebhooks()) })
      }
      case 'jobs':
        return NextResponse.json({ task, ...(await runDueJobs()) })

      case 'reconcile': {
        if (!shopifyConfigured()) return NextResponse.json({ skipped: 'Shopify nicht konfiguriert' })
        const orders = await reconcileOrders()
        // Bestandsmeldung über die Outbox statt direkt: der Job hat Retry und
        // Backoff, und der Dedupe-Schlüssel verhindert Stapelbildung.
        await sql`select enqueue_job('shopify_inventory_push', '{}'::jsonb, 'inventar-abgleich')`
        return NextResponse.json({ task, ...orders, inventar: 'eingereiht' })
      }
      case 'tracking': {
        if (!dhlConfigured()) return NextResponse.json({ skipped: 'DHL nicht konfiguriert' })
        return NextResponse.json({ task, ...(await syncTracking()) })
      }
      case 'analytics': {
        const [row] = await sql<{ refresh_analytics: string }[]>`select refresh_analytics('cron')`
        return NextResponse.json({ task, dauer: row.refresh_analytics })
      }
      case 'housekeeping':
        return NextResponse.json({
          task,
          sessions: await pruneSessions(),
          tracking: await pruneTrackingData(),
          monitor: await pruneMonitorData(),
        })
      case 'finanzen': {
        // Tageslauf: abgelaufene Verträge beenden, USt-Vorschlag für den
        // Vormonat anlegen (idempotent, Logik in finanz_tageslauf/0060).
        const [row] = await sql<{ finanz_tageslauf: Record<string, unknown> }[]>`
          select finanz_tageslauf('cron')`
        return NextResponse.json({ task, ...row.finanz_tageslauf })
      }
      default:
        return NextResponse.json({ error: `Unbekannte Aufgabe: ${task}` }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json(
      { task, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
