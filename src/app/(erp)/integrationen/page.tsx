import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { dhlConfigured } from '@/modules/versand/dhl'
import { processPendingWebhooks, reconcileOrders, retryWebhookEvent } from '@/modules/integrationen/import'
import { resetRunningJob, retryJob, runDueJobs } from '@/modules/integrationen/jobs'
import { actionError, actionInfo } from '@/modules/shared/action'

export const dynamic = 'force-dynamic'

async function runJobs() {
  'use server'
  await requireAdmin()
  const r = await runDueJobs()
  revalidatePath('/integrationen')
  return actionInfo(
    r.ran === 0
      ? 'Nichts zu tun — die Outbox ist leer.'
      : `${r.ran} Job(s) ausgeführt: ${r.succeeded} erfolgreich, ${r.failed} fehlgeschlagen.`,
  )
}

async function processWebhooks() {
  'use server'
  await requireAdmin()
  const r = await processPendingWebhooks()
  revalidatePath('/integrationen')
  return actionInfo(
    r.processed + r.failed === 0
      ? 'Keine offenen Webhooks.'
      : `${r.processed} Webhook(s) verarbeitet, ${r.failed} fehlgeschlagen.`,
  )
}

async function runReconcile() {
  'use server'
  await requireAdmin()
  try {
    await reconcileOrders()
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
  revalidatePath('/integrationen')
}

async function pushInventarJetzt() {
  'use server'
  await requireAdmin()
  try {
    const { pushInventar } = await import('@/modules/integrationen/inventar')
    const r = await pushInventar()
    revalidatePath('/integrationen')
    return actionInfo(
      r.uebertragen > 0
        ? `Bestand gemeldet: ${r.uebertragen} von ${r.geprueft} Variante(n) geändert.`
        : `Alles aktuell — ${r.geprueft} Variante(n) geprüft, nichts zu melden.`,
    )
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
}

async function starteProduktUebernahme() {
  'use server'
  await requireAdmin()
  try {
    await sql`insert into shopify_sync_state (key, value)
              values ('backfill_products', ${sql.json({ verknuepft: 0, angelegt: 0, fertig: false })})
              on conflict (key) do update set value = excluded.value, updated_at = now()`
    await sql`select enqueue_job('shopify_product_import', '{}'::jsonb, 'produkt-import:start')`
    await runDueJobs()
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
  revalidatePath('/integrationen')
  return actionInfo('Produktübernahme läuft — Ergebnis auf dieser Karte und in der Outbox.')
}

/** Erstübernahme anstoßen: Kunden und/oder Bestellungen ab Zeitraum. */
async function starteUebernahme(formData: FormData) {
  'use server'
  await requireAdmin()
  const was = String(formData.get('was') ?? 'beides')
  const tage = Number(formData.get('tage') ?? 365)
  const seit = new Date(Date.now() - tage * 24 * 60 * 60 * 1000).toISOString()

  try {
    if (was === 'kunden' || was === 'beides') {
      await sql`update shopify_sync_state set value = ${sql.json({ importiert: 0, fertig: false })}
                where key = 'backfill_customers'`
      await sql`insert into shopify_sync_state (key, value)
                values ('backfill_customers', ${sql.json({ importiert: 0, fertig: false })})
                on conflict (key) do nothing`
      await sql`select enqueue_job('shopify_customer_import', '{}'::jsonb, 'kunden-import:start')`
    }
    if (was === 'bestellungen' || was === 'beides') {
      await sql`update shopify_sync_state set value = ${sql.json({ importiert: 0, fertig: false })}
                where key = 'backfill_orders'`
      await sql`insert into shopify_sync_state (key, value)
                values ('backfill_orders', ${sql.json({ importiert: 0, fertig: false })})
                on conflict (key) do nothing`
      await sql`select enqueue_job('shopify_order_backfill',
        ${sql.json({ seit })}, 'bestell-import:start')`
    }
    // Sofort loslegen statt auf die nächste Cron-Minute zu warten.
    await runDueJobs()
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
  revalidatePath('/integrationen')
  return actionInfo('Übernahme läuft — Fortschritt unten in der Outbox und hier auf der Karte.')
}

async function registriereWebhooks(formData: FormData) {
  'use server'
  await requireAdmin()
  const url = String(formData.get('url') ?? '').trim()
  if (!/^https:\/\//.test(url)) {
    return actionError('Bitte die öffentliche https-Adresse des ERP angeben.')
  }
  try {
    const { registerWebhooks } = await import('@/modules/integrationen/shopify')
    const r = await registerWebhooks(url)
    revalidatePath('/integrationen')
    return actionInfo(
      `Webhooks eingerichtet: ${r.angelegt} neu, ${r.aktualisiert} umgezogen, ${r.unveraendert} passten schon.`,
    )
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
}

async function retry(jobId: string) {
  'use server'
  await requireAdmin()
  await retryJob(jobId)
  revalidatePath('/integrationen')
}

async function resetRunning(jobId: string) {
  'use server'
  await requireAdmin()
  await resetRunningJob(jobId)
  revalidatePath('/integrationen')
}

async function retryWebhook(eventId: string) {
  'use server'
  await requireAdmin()
  await retryWebhookEvent(eventId)
  revalidatePath('/integrationen')
}

/** Ordnet eine unbekannte Shopify-SKU einer Variante zu. */
async function resolveUnmatched(lineId: string, formData: FormData) {
  'use server'
  await requireAdmin()
  const variantId = String(formData.get('variant_id') ?? '')
  if (!variantId) return actionError('Bitte eine Variante auswählen')

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

/** Deutsche Beschriftungen der technischen Queue-Zustände. */
const JOB_STATUS: Record<string, string> = {
  pending: 'wartet',
  running: 'läuft',
  done: 'erledigt',
  failed: 'fehlgeschlagen',
}

const EVENT_STATUS: Record<string, string> = {
  pending: 'wartet',
  running: 'läuft',
  done: 'erledigt',
  failed: 'fehlgeschlagen',
  skipped: 'übersprungen',
}

/**
 * Zustand einer Warteschlange: „läuft" ist ein Betriebszustand und bekommt
 * die Leuchte, alles andere bleibt ein abgeschlossenes Ergebnis (Chip).
 */
function QueueStatus({ status, labels }: { status: string; labels: Record<string, string> }) {
  const wort = labels[status] ?? status
  if (status === 'running') {
    return (
      <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span className="led on" />
        {wort}
      </span>
    )
  }
  const ton = status === 'done' ? 'success' : status === 'failed' ? 'danger' : 'warn'
  return <span className={`badge ${ton}`}>{wort}</span>
}

/** Verbindungszustand einer Anbindung: Leuchte plus Wort, nicht als Kennzahl. */
function Verbindung({ ok }: { ok: boolean }) {
  return (
    <span
      className="mono-label"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}
    >
      <span className={ok ? 'led ok' : 'led off'} />
      {ok ? 'verbunden' : 'nicht konfiguriert'}
    </span>
  )
}

export default async function IntegrationenPage() {
  await requireArea('integrationen')
  const [stats] = await sql<
    {
      pending_events: number
      failed_events: number
      pending_jobs: number
      failed_jobs: number
      running_stuck: number
      unmatched: number
      tx_failed_24h: number
      tx_24h: number
    }[]
  >`
    select
      (select count(*) from shopify_webhook_events where status = 'pending')::int as pending_events,
      (select count(*) from shopify_webhook_events where status = 'failed')::int as failed_events,
      (select count(*) from integration_jobs where status = 'pending')::int as pending_jobs,
      (select count(*) from integration_jobs where status = 'failed')::int as failed_jobs,
      (select count(*) from integration_jobs
        where status = 'running' and started_at < now() - interval '10 minutes')::int as running_stuck,
      (select count(*) from shopify_unmatched_lines where resolved_at is null)::int as unmatched,
      (select count(*) from api_transactions
        where not ok and created_at > now() - interval '24 hours')::int as tx_failed_24h,
      (select count(*) from api_transactions
        where created_at > now() - interval '24 hours')::int as tx_24h`

  const [syncState] = await sql<{ value: string }[]>`
    select value #>> '{}' as value from shopify_sync_state where key = 'last_reconciliation_at'`

  const events = await sql<
    { id: string; topic: string; status: string; error: string | null; received_at: string; order_id: string | null }[]
  >`
    select id, topic, status, error, received_at, shopify_order_id as order_id
    from shopify_webhook_events order by received_at desc limit 20`

  const jobs = await sql<
    {
      id: string
      kind: string
      status: string
      attempts: number
      last_error: string | null
      last_result: string | null
      next_run_at: string
      started_at: string | null
    }[]
  >`
    select id, kind, status, attempts, last_error, last_result, next_run_at, started_at
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

  // Bestandsabgleich: was ist gekoppelt, wann wurde zuletzt gemeldet, und wo
  // glaubt der Shop etwas anderes als das ERP?
  const [inventar] = await sql<
    { gekoppelt: number; gemeldet: number; letzter_push: string | null; standort: string | null }[]
  >`
    select
      (select count(*) from product_variants
        where shopify_variant_id is not null and active)::int as gekoppelt,
      (select count(*) from shopify_inventory_state where pushed_at is not null)::int as gemeldet,
      (select max(pushed_at) from shopify_inventory_state)::text as letzter_push,
      (select value ->> 'name' from shopify_sync_state
        where key = 'inventory_location') as standort`

  const abweichungen = await sql<
    { variant_id: string; sku: string | null; erp_menge: number; shop_menge: number; shop_seen_at: string }[]
  >`
    select variant_id, sku, erp_menge, shop_menge, shop_seen_at
    from shopify_inventory_drift order by sku limit 50`

  // Bei Shopify registrierte Webhooks — best effort, die Seite darf nicht an
  // einem Netzfehler scheitern.
  let webhooksImShop: { topic: string; callbackUrl: string | null }[] | null = null
  if (shopifyConfigured()) {
    try {
      const { fetchWebhooks } = await import('@/modules/integrationen/shopify')
      webhooksImShop = await fetchWebhooks()
    } catch {
      webhooksImShop = null
    }
  }

  // Stand der Erstübernahme (Kunden/Bestellungen) für die Karte.
  const uebernahme = Object.fromEntries(
    (
      await sql<{ key: string; value: { importiert: number; fertig: boolean } }[]>`
        select key, value from shopify_sync_state
        where key in ('backfill_customers', 'backfill_orders', 'backfill_products')`
    ).map((r) => [r.key, r.value]),
  ) as Record<string, { importiert?: number; verknuepft?: number; angelegt?: number; fertig: boolean } | undefined>

  return (
    <>
      <PageHeader
        title="Ereignis-Monitor"
        subtitle="Shopify-Import, ausgehende Aufträge, API-Transaktionen und Zustand der Anbindungen"
        actions={
          <>
            <Link className="btn" href="/integrationen/import">Shopify-Import</Link>
            <Link className="btn" href="/integrationen/transaktionen">Transaktionsprotokoll</Link>
            <ActionButton action={processWebhooks}>Webhooks verarbeiten</ActionButton>
            <ActionButton action={runJobs}>Jobs ausführen</ActionButton>
            <ActionButton action={runReconcile}>Mit Shopify abgleichen</ActionButton>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Shopify"
          value={<Verbindung ok={shopifyConfigured()} />}
          hint={
            <>
              Letzter Abgleich:{' '}
              <span className="mono">{syncState ? dateTime(syncState.value) : '—'}</span>
            </>
          }
        />
        <Stat
          label="DHL"
          value={<Verbindung ok={dhlConfigured()} />}
          hint="Parcel DE Shipping API v2"
        />
        <Stat
          label="Warteschlange"
          value={qty(stats.pending_events + stats.pending_jobs)}
          hint={`${stats.failed_events + stats.failed_jobs} fehlgeschlagen${
            stats.running_stuck > 0 ? ` · ${stats.running_stuck} hängend` : ''
          }`}
        />
        <Stat
          label="API-Transaktionen (24 h)"
          value={qty(stats.tx_24h)}
          hint={`${stats.tx_failed_24h} fehlgeschlagen`}
          href="/integrationen/transaktionen"
        />
      </div>

      {(stats.failed_events + stats.failed_jobs > 0 || stats.tx_failed_24h > 0 || stats.running_stuck > 0) && (
        <div className="notice danger">
          <span className="led on" />{' '}
          {stats.failed_jobs > 0 && <>{stats.failed_jobs} Job(s) endgültig fehlgeschlagen. </>}
          {stats.failed_events > 0 && <>{stats.failed_events} Webhook(s) fehlgeschlagen. </>}
          {stats.running_stuck > 0 && <>{stats.running_stuck} Job(s) hängen in „running". </>}
          {stats.tx_failed_24h > 0 && (
            <>
              {stats.tx_failed_24h} API-Fehler in 24 h —{' '}
              <Link href="/integrationen/transaktionen?nur=fehler">zum Protokoll</Link>.
            </>
          )}
        </div>
      )}

      {!shopifyConfigured() && (
        <div className="notice warn">
          Shopify ist nicht konfiguriert. App im{' '}
          <a href="https://dev.shopify.com" target="_blank" rel="noreferrer">Dev Dashboard</a>{' '}
          anlegen, Scopes geben (<code className="mono">read_orders</code>, <code className="mono">read_all_orders</code>{' '}
          (sonst liefert Shopify nur die letzten 60 Tage!),{' '}
          <code className="mono">write_orders</code>, <code className="mono">read_customers</code>,{' '}
          <code className="mono">read_products</code>,{' '}
          <code className="mono">write_merchant_managed_fulfillment_orders</code>,{' '}
          <code className="mono">read_inventory</code>, <code className="mono">write_inventory</code>,{' '}
          <code className="mono">read_locations</code>) und im eigenen Shop installieren. Dann{' '}
          <code className="mono">SHOPIFY_SHOP_DOMAIN</code>, <code className="mono">SHOPIFY_CLIENT_ID</code>{' '}
          und <code className="mono">SHOPIFY_CLIENT_SECRET</code> (Settings → Credentials) als
          Umgebungsvariablen setzen — das Access Token holt sich das ERP selbst und erneuert es
          automatisch. Webhooks (<code className="mono">orders/*</code>,{' '}
          <code className="mono">inventory_levels/update</code> auf{' '}
          <code className="mono">/api/webhooks/shopify</code>) brauchen eine öffentlich erreichbare
          URL — lokal übernimmt der viertelstündliche Abgleich.
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
                            <button className="small" type="submit">Zuordnen</button>
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

      {shopifyConfigured() && (
        <Card title="Erstübernahme aus Shopify">
          <p className="small muted" style={{ marginTop: 0 }}>
            Gezielt einzelne Bestellungen ansehen und übernehmen: <Link href="/integrationen/import">Shopify-Import</Link>.
            Diese Karte holt dagegen alles auf einmal — Kunden und vergangene Bestellungen in Häppchen über die Outbox. In Shopify bereits
            versandte Bestellungen werden als historische Belege übernommen — <strong>ohne</strong>{' '}
            Lieferungen oder Fertigungsaufträge anzustoßen. Bereits Importiertes wird erkannt und
            übersprungen; die Übernahme darf mehrfach laufen. Im ERP gepflegte Kontaktdaten werden
            nicht überschrieben, nur Lücken gefüllt.
          </p>
          <div style={{ marginBottom: 10 }}>
            <ActionButton action={starteProduktUebernahme}>
              Produkte aus Shopify verknüpfen/übernehmen
            </ActionButton>
            {uebernahme.backfill_products && (
              <span className="small" style={{ marginLeft: 12 }}>
                <span className={`led ${uebernahme.backfill_products.fertig ? 'ok' : 'on'}`} style={{ marginRight: 6 }} />
                {qty(uebernahme.backfill_products.verknuepft ?? 0)} verknüpft,{' '}
                {qty(uebernahme.backfill_products.angelegt ?? 0)} angelegt
                {uebernahme.backfill_products.fertig ? ' — abgeschlossen' : ' — läuft'}
              </span>
            )}
          </div>
          <ActionForm action={starteUebernahme}>
            <div className="row">
              <label className="field">
                <span>Was</span>
                <select name="was" defaultValue="beides">
                  <option value="beides">Kunden und Bestellungen</option>
                  <option value="kunden">Nur Kunden</option>
                  <option value="bestellungen">Nur Bestellungen</option>
                </select>
              </label>
              <label className="field">
                <span>Bestellungen ab</span>
                <select name="tage" defaultValue="365">
                  <option value="90">letzte 90 Tage</option>
                  <option value="365">letzte 12 Monate</option>
                  <option value="1095">letzte 3 Jahre</option>
                  <option value="3650">alles (10 Jahre)</option>
                </select>
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Übernahme starten</button>
              </div>
            </div>
          </ActionForm>
          {(uebernahme.backfill_customers || uebernahme.backfill_orders) && (
            <div className="small" style={{ marginTop: 10, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              {uebernahme.backfill_customers && (
                <span>
                  <span className={`led ${uebernahme.backfill_customers.fertig ? 'ok' : 'on'}`} style={{ marginRight: 6 }} />
                  Kunden: {qty(uebernahme.backfill_customers.importiert)} neu
                  {uebernahme.backfill_customers.fertig ? ' — abgeschlossen' : ' — läuft'}
                </span>
              )}
              {uebernahme.backfill_orders && (
                <span>
                  <span className={`led ${uebernahme.backfill_orders.fertig ? 'ok' : 'on'}`} style={{ marginRight: 6 }} />
                  Bestellungen: {qty(uebernahme.backfill_orders.importiert)} übernommen
                  {uebernahme.backfill_orders.fertig ? ' — abgeschlossen' : ' — läuft'}
                </span>
              )}
            </div>
          )}
        </Card>
      )}

      {shopifyConfigured() && (
        <Card title="Sofortmeldung aus Shopify (Webhooks)">
          <p className="small muted" style={{ marginTop: 0 }}>
            Mit registrierten Webhooks landen neue Bestellungen, Stornos/Erstattungen und
            Bestandsänderungen <strong>sekundenschnell</strong> im ERP — der viertelstündliche
            Abgleich bleibt nur Sicherheitsnetz. Voraussetzung: das ERP ist unter einer
            öffentlichen https-Adresse erreichbar (Vercel oder Tunnel). Auf localhost kann
            Shopify nicht zustellen.
          </p>
          {webhooksImShop === null ? (
            <div className="small muted">Registrierte Webhooks konnten nicht abgerufen werden.</div>
          ) : webhooksImShop.length === 0 ? (
            <div className="notice warn">Noch keine Webhooks registriert — Änderungen kommen nur über den Abgleich.</div>
          ) : (
            <ul className="small mono" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              {webhooksImShop.map((w) => (
                <li key={w.topic}>
                  {w.topic.toLowerCase()} → {w.callbackUrl ?? '—'}
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={registriereWebhooks}>
            <div className="row">
              <label className="field" style={{ flex: 3 }}>
                <span>Öffentliche Adresse des ERP</span>
                <input
                  type="url"
                  name="url"
                  placeholder="https://erp.example.com"
                  defaultValue={process.env.ERP_PUBLIC_URL ?? ''}
                />
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Webhooks registrieren</button>
              </div>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card
        title="Bestandsabgleich mit Shopify"
        actions={
          shopifyConfigured() ? (
            <ActionButton className="small" action={pushInventarJetzt}>
              Bestand jetzt melden
            </ActionButton>
          ) : undefined
        }
      >
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="mono-label">Gekoppelte Varianten</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{qty(inventar.gekoppelt)}</div>
          </div>
          <div>
            <div className="mono-label">Zuletzt gemeldet</div>
            <div className="mono small" style={{ paddingTop: 4 }}>
              {inventar.letzter_push ? dateTime(inventar.letzter_push) : 'noch nie'}
            </div>
          </div>
          <div>
            <div className="mono-label">Shopify-Standort</div>
            <div className="small" style={{ paddingTop: 4 }}>
              {inventar.standort ?? 'wird beim ersten Abgleich ermittelt'}
            </div>
          </div>
        </div>
        {abweichungen.length > 0 ? (
          <>
            <div className="notice warn" style={{ marginTop: 12 }}>
              Der Shop meldet für {abweichungen.length} Variante(n) andere Mengen als das ERP —
              vermutlich Handkorrekturen im Shopify-Admin. Der nächste Abgleich überschreibt sie
              mit dem ERP-Stand.
            </div>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">ERP</th>
                    <th className="num">Shop</th>
                    <th>Gemeldet vom Shop</th>
                  </tr>
                </thead>
                <tbody>
                  {abweichungen.map((a) => (
                    <tr key={a.variant_id}>
                      <td className="mono">{a.sku ?? a.variant_id}</td>
                      <td className="num">{qty(a.erp_menge)}</td>
                      <td className="num">{qty(a.shop_menge)}</td>
                      <td className="mono small">{dateTime(a.shop_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </>
        ) : (
          <div className="small muted" style={{ marginTop: 10 }}>
            Keine Abweichungen bekannt. Der Abgleich läuft viertelstündlich mit; der Webhook{' '}
            <code className="mono">inventory_levels/update</code> meldet Handänderungen im Shop.
          </div>
        )}
      </Card>

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
                      <QueueStatus status={j.status} labels={JOB_STATUS} />
                      {j.status === 'running' && j.started_at && (
                        <span className="muted small mono"> seit {dateTime(j.started_at)}</span>
                      )}
                    </td>
                    <td className="num">{j.attempts}</td>
                    <td className="small" style={{ maxWidth: 380 }}>
                      {j.last_error ? (
                        // Freitext bleibt Freitext — der Chip ist dem Statuswort vorbehalten.
                        <span style={{ color: 'var(--danger)' }}>{j.last_error}</span>
                      ) : (
                        j.last_result ?? '—'
                      )}
                    </td>
                    <td className="nowrap small mono">{dateTime(j.next_run_at)}</td>
                    <td className="num">
                      {j.status === 'failed' && (
                        <ActionButton className="small" action={retry.bind(null, j.id)}>
                          Erneut
                        </ActionButton>
                      )}
                      {j.status === 'running' && (
                        <ActionButton
                          className="small"
                          action={resetRunning.bind(null, j.id)}
                          confirm="Diesen Lauf als abgebrochen behandeln und den Job zurück in die Queue stellen?"
                        >
                          Zurücksetzen
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
                  <th>Shopify-Order</th>
                  <th>Status</th>
                  <th>Meldung</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap small mono">{dateTime(e.received_at)}</td>
                    <td className="mono small">{e.topic}</td>
                    <td className="mono small">{e.order_id?.split('/').pop() ?? '—'}</td>
                    <td>
                      <QueueStatus status={e.status} labels={EVENT_STATUS} />
                    </td>
                    <td className="small" style={{ maxWidth: 420 }}>{e.error ?? '—'}</td>
                    <td className="num">
                      {(e.status === 'failed' || e.status === 'skipped') && (
                        <ActionButton className="small" action={retryWebhook.bind(null, e.id)}>
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

      <Card title="Einrichtung">
        <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>
            Shopify-Webhook-Ziel: <code className="mono">/api/webhooks/shopify</code> für die
            Ereignisse <code className="mono">orders/create</code>,{' '}
            <code className="mono">orders/paid</code>, <code className="mono">orders/updated</code>,{' '}
            <code className="mono">orders/cancelled</code>
          </li>
          <li>
            Geplante Aufgaben laufen über <code className="mono">/api/cron?task=…</code> (siehe{' '}
            <code className="mono">vercel.json</code>): Webhooks und Jobs minütlich, Abgleich alle 15
            Minuten, Sendungsverfolgung stündlich
          </li>
          <li>
            Zugangsdaten werden als Umgebungsvariablen gesetzt — Vorlage in{' '}
            <code className="mono">.env.example</code>
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
