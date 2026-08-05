import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { dhlConfigured } from '@/modules/versand/dhl'
import { processPendingWebhooks, reconcileOrders } from '@/modules/integrationen/import'
import { retryJob, runDueJobs } from '@/modules/integrationen/jobs'

export const dynamic = 'force-dynamic'

async function runJobs() {
  'use server'
  await requireUser()
  await runDueJobs()
  revalidatePath('/integrationen')
}

async function processWebhooks() {
  'use server'
  await requireUser()
  await processPendingWebhooks()
  revalidatePath('/integrationen')
}

async function runReconcile() {
  'use server'
  await requireUser()
  try {
    await reconcileOrders()
  } catch (err) {
    throw new Error((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
  revalidatePath('/integrationen')
}

async function retry(jobId: string) {
  'use server'
  await requireUser()
  await retryJob(jobId)
  revalidatePath('/integrationen')
}

/** Ordnet eine unbekannte Shopify-SKU einer Variante zu. */
async function resolveUnmatched(lineId: string, formData: FormData) {
  'use server'
  await requireUser()
  const variantId = String(formData.get('variant_id') ?? '')
  if (!variantId) throw new Error('Bitte eine Variante auswählen')

  const [line] = await sql<{ sku: string | null; variant_gid: string | null }[]>`
    select sku, variant_gid from shopify_unmatched_lines where id = ${lineId}`

  // Zuordnung dauerhaft an der Variante speichern, damit der nächste Import passt.
  if (line?.variant_gid) {
    await sql`update product_variants set shopify_variant_id = ${line.variant_gid}
              where id = ${variantId} and shopify_variant_id is null`
  }
  if (line?.sku) {
    await sql`update product_variants set sku = ${line.sku}
              where id = ${variantId} and sku is null`
  }

  await sql`update shopify_unmatched_lines
            set resolved_at = now(), resolved_variant = ${variantId} where id = ${lineId}`
  revalidatePath('/integrationen')
}

export default async function IntegrationenPage() {
  const [stats] = await sql<
    { pending_events: number; failed_events: number; pending_jobs: number; failed_jobs: number; unmatched: number }[]
  >`
    select
      (select count(*) from shopify_webhook_events where status = 'pending')::int as pending_events,
      (select count(*) from shopify_webhook_events where status = 'failed')::int as failed_events,
      (select count(*) from integration_jobs where status = 'pending')::int as pending_jobs,
      (select count(*) from integration_jobs where status = 'failed')::int as failed_jobs,
      (select count(*) from shopify_unmatched_lines where resolved_at is null)::int as unmatched`

  const [syncState] = await sql<{ value: string }[]>`
    select value #>> '{}' as value from shopify_sync_state where key = 'last_reconciliation_at'`

  const events = await sql<
    { id: string; topic: string; status: string; error: string | null; received_at: string; order_id: string | null }[]
  >`
    select id, topic, status, error, received_at, shopify_order_id as order_id
    from shopify_webhook_events order by received_at desc limit 20`

  const jobs = await sql<
    { id: string; kind: string; status: string; attempts: number; last_error: string | null; next_run_at: string }[]
  >`
    select id, kind, status, attempts, last_error, next_run_at
    from integration_jobs order by created_at desc limit 25`

  const unmatched = await sql<
    { id: string; order_name: string | null; sku: string | null; title: string | null; qty: number }[]
  >`
    select id, order_name, sku, title, qty from shopify_unmatched_lines
    where resolved_at is null order by created_at desc limit 25`

  const variants = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) || coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active order by label limit 500`

  return (
    <>
      <PageHeader
        title="Integrationen"
        subtitle="Shopify-Import, ausgehende Aufträge und Zustand der Anbindungen"
        actions={
          <>
            <ActionButton action={processWebhooks}>Webhooks verarbeiten</ActionButton>
            <ActionButton action={runJobs}>Jobs ausführen</ActionButton>
            <ActionButton action={runReconcile}>Mit Shopify abgleichen</ActionButton>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Shopify"
          value={shopifyConfigured() ? 'verbunden' : 'nicht konfiguriert'}
          hint={`Letzter Abgleich: ${syncState ? dateTime(syncState.value) : '—'}`}
        />
        <Stat
          label="DHL"
          value={dhlConfigured() ? 'verbunden' : 'nicht konfiguriert'}
          hint="Parcel DE Shipping API v2"
        />
        <Stat
          label="Offene Vorgänge"
          value={qty(stats.pending_events + stats.pending_jobs)}
          hint={`${stats.failed_events + stats.failed_jobs} fehlgeschlagen`}
        />
      </div>

      {!shopifyConfigured() && (
        <div className="notice warn">
          Shopify ist nicht konfiguriert. Lege im Shopify Dev Dashboard eine Custom App an (Scopes{' '}
          <code>read_orders</code>, <code>write_orders</code>,{' '}
          <code>write_merchant_managed_fulfillment_orders</code>), trage Token und Webhook-Secret als
          Umgebungsvariablen ein und registriere den Webhook auf <code>/api/webhooks/shopify</code>.
        </div>
      )}

      {unmatched.length > 0 && (
        <Card title={`Nicht zugeordnete Shopify-Positionen (${unmatched.length})`} tight>
          <div className="notice warn" style={{ margin: 12 }}>
            Diese Positionen konnten keinem Produkt zugeordnet werden und fehlen in den Aufträgen.
            Nach der Zuordnung wird die Shopify-Variante dauerhaft am Produkt gespeichert.
          </div>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Bestellung</th>
                  <th>Artikel</th>
                  <th>SKU</th>
                  <th className="num">Menge</th>
                  <th style={{ width: 380 }}>Zuordnen</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map((u) => (
                  <tr key={u.id}>
                    <td className="mono small">{u.order_name ?? '—'}</td>
                    <td>{u.title}</td>
                    <td className="mono small">{u.sku ?? '—'}</td>
                    <td className="num">{qty(u.qty)}</td>
                    <td>
                      <ActionForm action={resolveUnmatched.bind(null, u.id)}>
                        <div className="row" style={{ gap: 6 }}>
                          <select name="variant_id" required defaultValue="">
                            <option value="" disabled>— Variante wählen —</option>
                            {variants.map((v) => (
                              <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                          </select>
                          <div className="shrink">
                            <button className="small primary" type="submit">Zuordnen</button>
                          </div>
                        </div>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <Card title="Ausgehende Aufträge (Outbox)" tight>
        {jobs.length === 0 ? (
          <Empty>Keine Jobs.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Status</th>
                  <th className="num">Versuche</th>
                  <th>Meldung</th>
                  <th>Nächster Lauf</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono small">{j.kind}</td>
                    <td>
                      <span
                        className={`badge ${
                          j.status === 'done' ? 'success' : j.status === 'failed' ? 'danger' : 'warn'
                        }`}
                      >
                        {j.status}
                      </span>
                    </td>
                    <td className="num">{j.attempts}</td>
                    <td className="small" style={{ maxWidth: 380 }}>{j.last_error ?? '—'}</td>
                    <td className="nowrap small">{dateTime(j.next_run_at)}</td>
                    <td className="num">
                      {j.status === 'failed' && (
                        <ActionButton className="small" action={retry.bind(null, j.id)}>
                          Erneut
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Eingehende Shopify-Webhooks" tight>
        {events.length === 0 ? (
          <Empty>Noch keine Webhooks empfangen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Empfangen</th>
                  <th>Ereignis</th>
                  <th>Status</th>
                  <th>Meldung</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap small">{dateTime(e.received_at)}</td>
                    <td className="mono small">{e.topic}</td>
                    <td>
                      <span
                        className={`badge ${
                          e.status === 'done' ? 'success' : e.status === 'failed' ? 'danger' : 'warn'
                        }`}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="small" style={{ maxWidth: 420 }}>{e.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Einrichtung">
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            Shopify-Webhook-Ziel: <code>/api/webhooks/shopify</code> für die Ereignisse{' '}
            <code>orders/create</code>, <code>orders/paid</code>, <code>orders/updated</code>,{' '}
            <code>orders/cancelled</code>
          </li>
          <li>
            Geplante Aufgaben laufen über <code>/api/cron?task=…</code> (siehe{' '}
            <code>vercel.json</code>): Webhooks und Jobs minütlich, Abgleich alle 15 Minuten,
            Sendungsverfolgung stündlich
          </li>
          <li>
            Zugangsdaten werden als Umgebungsvariablen gesetzt — Vorlage in <code>.env.example</code>
          </li>
          <li>
            Produkt-Zuordnung: die <Link href="/produkte">SKU der Variante</Link> muss der Shopify-SKU
            entsprechen
          </li>
        </ul>
      </Card>
    </>
  )
}
