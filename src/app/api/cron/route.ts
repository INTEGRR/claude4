import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { processPendingWebhooks, reconcileOrders } from '@/modules/integrationen/import'
import { runDueJobs } from '@/modules/integrationen/jobs'
import { pruneMonitorData } from '@/modules/integrationen/transaktionen'
import {
  benachrichtigungenAufraeumen,
  fehlgeschlageneJobsMelden,
} from '@/modules/integrationen/benachrichtigungen'
import { benachrichtigungenVersenden } from '@/modules/integrationen/benachrichtigungen-versand'
import { datenbankAusfallMelden, wacheAusfuehren } from '@/modules/integrationen/wache-sonden'
import { pruneTrackingData, syncTracking } from '@/modules/versand/service'
import { pruneLoginVersuche, pruneSessions, pruneGeraete } from '@/modules/auth'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { dhlConfigured } from '@/modules/versand/dhl'

export const maxDuration = 60

/**
 * Sammelendpunkt für geplante Aufgaben. Aufruf über Vercel Cron:
 *
 *   /api/cron?task=webhooks      jede Minute   - Shopify-Events verarbeiten
 *   /api/cron?task=jobs          jede Minute   - Outbox abarbeiten, Telegram senden
 *   /api/cron?task=reconcile     alle 15 Min   - Abgleich mit Shopify
 *   /api/cron?task=tracking      stündlich     - DHL-Sendungsstatus
 *   /api/cron?task=analytics     nachts        - Kennzahlen neu berechnen
 *   /api/cron?task=housekeeping  täglich       - Aufräumen
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  // Auf Vercel ist der Endpunkt öffentlich erreichbar — ohne CRON_SECRET
  // bleibt er ZU, statt still offen zu stehen. Im Docker-Betrieb (hinter
  // VPN, Aufruf vom Host) ist das Secret optional, siehe betrieb.md.
  if (!secret && process.env.VERCEL) {
    return NextResponse.json({ error: 'CRON_SECRET fehlt' }, { status: 401 })
  }
  if (secret) {
    const geliefert = Buffer.from(request.headers.get('authorization') ?? '')
    const erwartet = Buffer.from(`Bearer ${secret}`)
    if (geliefert.length !== erwartet.length || !timingSafeEqual(geliefert, erwartet)) {
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
      case 'jobs': {
        const jobs = await runDueJobs()
        // Telegram: endgültig gescheiterte Jobs melden, dann die Outbox der
        // Benachrichtigungen senden (Anmeldungen, Fehlversuche, Dienste).
        const gemeldet = await fehlgeschlageneJobsMelden(sql)
        const benachrichtigungen = await benachrichtigungenVersenden()
        return NextResponse.json({ task, ...jobs, jobs_gemeldet: gemeldet, benachrichtigungen })
      }

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
      case 'wache': {
        // Dienste-Wächter: erst die Datenbank selbst — ohne sie gibt es keine
        // Outbox, dann Direktversand mit Zeitfenster (wache.ts).
        try {
          await sql`select 1`
        } catch (err) {
          const gemeldet = await datenbankAusfallMelden(err)
          return NextResponse.json(
            { task, error: 'Datenbank nicht erreichbar', telegram: gemeldet },
            { status: 503 },
          )
        }
        const lauf = await wacheAusfuehren()
        const benachrichtigungen = await benachrichtigungenVersenden()
        return NextResponse.json({ task, ...lauf, benachrichtigungen })
      }
      case 'analytics': {
        const [row] = await sql<{ refresh_analytics: string }[]>`select refresh_analytics('cron')`
        return NextResponse.json({ task, dauer: row.refresh_analytics })
      }
      case 'housekeeping': {
        // Daten-TÜV über die Outbox (Retry + Monitor-Sichtbarkeit inklusive);
        // Befunde erscheinen als fehlgeschlagener Job — siehe daten-tuev.ts.
        await sql`select enqueue_job('daten_tuev', '{}'::jsonb, 'daten-tuev')`
        return NextResponse.json({
          task,
          sessions: await pruneSessions(),
          logins: await pruneLoginVersuche(),
          geraete: await pruneGeraete(),
          tracking: await pruneTrackingData(),
          monitor: await pruneMonitorData(),
          benachrichtigungen: await benachrichtigungenAufraeumen(sql),
          tuev: 'eingereiht',
        })
      }
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
