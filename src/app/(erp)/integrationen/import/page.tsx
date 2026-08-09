import { revalidatePath } from 'next/cache'
import Link from 'next/link'
import { sql } from '@/db/client'
import { requireAdmin, requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, money } from '@/modules/shared/format'
import { actionError, actionInfo } from '@/modules/shared/action'
import { type ShopifyOrder, fetchOrdersPage, shopifyConfigured } from '@/modules/integrationen/shopify'
import { runDueJobs } from '@/modules/integrationen/jobs'

export const dynamic = 'force-dynamic'

/**
 * Import-Übersicht: Bestellungen direkt aus Shopify durchsehen und gezielt
 * oder gesammelt übernehmen. Die Liste ist der LIVE-Stand des Shops — was im
 * ERP schon existiert, steht als Belegnummer daneben.
 */

const STATUS_FILTER: Record<string, { q: string; label: string }> = {
  offen: { q: 'status:open', label: 'Offen' },
  unversandt: { q: 'status:open fulfillment_status:unshipped', label: 'Offen & unversandt' },
  versandt: { q: 'fulfillment_status:shipped', label: 'Versandt' },
  storniert: { q: 'status:cancelled', label: 'Storniert' },
  alle: { q: '', label: 'Alle' },
}

const ZEITRAUM: Record<string, { tage: number | null; label: string }> = {
  '90': { tage: 90, label: 'letzte 90 Tage' },
  '365': { tage: 365, label: 'letzte 12 Monate' },
  '1095': { tage: 1095, label: 'letzte 3 Jahre' },
  alle: { tage: null, label: 'gesamte Historie' },
}

function baueAnfrage(status: string, zeitraum: string, text: string): string {
  const teile: string[] = []
  const s = STATUS_FILTER[status] ?? STATUS_FILTER.offen
  if (s.q) teile.push(s.q)
  const z = ZEITRAUM[zeitraum] ?? ZEITRAUM.alle
  if (z.tage) {
    teile.push(`created_at:>'${new Date(Date.now() - z.tage * 86400_000).toISOString()}'`)
  }
  if (text.trim()) teile.push(text.trim())
  return teile.join(' ')
}

async function uebernehmen(gid: string) {
  'use server'
  await requireAdmin()
  try {
    const { importOrderByGid } = await import('@/modules/integrationen/import')
    const r = await importOrderByGid(gid)
    revalidatePath('/integrationen/import')
    return actionInfo(r.message, r.salesOrderId ? `/verkauf/${r.salesOrderId}` : undefined)
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
}

async function alleUebernehmen(formData: FormData) {
  'use server'
  await requireAdmin()
  const q = String(formData.get('q') ?? '')
  try {
    await sql`select enqueue_job('shopify_order_backfill',
      ${sql.json({ q })}, ${`bestell-import:${q.slice(0, 40)}:start`})`
    await runDueJobs()
  } catch (err) {
    return actionError((err instanceof Error ? err.message : String(err)).replace(/^error: /, ''))
  }
  revalidatePath('/integrationen/import')
  return actionInfo('Übernahme läuft im Hintergrund — Fortschritt auf dem Ereignis-Monitor.')
}

/** Shopify-Zustände in Betriebsdeutsch. */
const ZAHLUNG: Record<string, string> = {
  PAID: 'bezahlt', PENDING: 'ausstehend', AUTHORIZED: 'autorisiert',
  REFUNDED: 'erstattet', PARTIALLY_REFUNDED: 'teilerstattet', VOIDED: 'aufgehoben',
}
const VERSAND: Record<string, string> = {
  FULFILLED: 'versandt', UNFULFILLED: 'offen', PARTIALLY_FULFILLED: 'teilweise',
  ON_HOLD: 'angehalten', SCHEDULED: 'geplant',
}

export default async function ImportUebersicht({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; zeitraum?: string; q?: string; after?: string }>
}) {
  await requireArea('integrationen')
  const params = await searchParams
  const status = params.status ?? 'offen'
  const zeitraum = params.zeitraum ?? 'alle'
  const text = params.q ?? ''
  const anfrage = baueAnfrage(status, zeitraum, text)

  let orders: ShopifyOrder[] = []
  let endCursor: string | null = null
  let fehler: string | null = null

  if (!shopifyConfigured()) {
    fehler = 'Shopify ist nicht konfiguriert — Zugangsdaten fehlen (siehe Ereignis-Monitor).'
  } else {
    try {
      const seite = await fetchOrdersPage(anfrage, params.after ?? null)
      orders = seite.orders
      endCursor = seite.endCursor
    } catch (err) {
      fehler = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    }
  }

  // Was davon existiert schon im ERP?
  const vorhandene = orders.length
    ? await sql<{ shopify_order_id: string; id: string; number: string; state: string }[]>`
        select shopify_order_id, id, number, state from sales_orders
        where shopify_order_id in ${sql(orders.map((o) => o.id))}`
    : []
  const imErp = new Map(vorhandene.map((v) => [v.shopify_order_id, v]))
  const fehlend = orders.filter((o) => !imErp.has(o.id)).length

  const filterLink = (aenderung: Record<string, string>) => {
    const p = new URLSearchParams({ status, zeitraum, ...(text ? { q: text } : {}), ...aenderung })
    return `/integrationen/import?${p.toString()}`
  }

  return (
    <>
      <PageHeader
        title="Shopify-Import"
        subtitle="Live-Blick in den Shop: durchsehen, filtern, gezielt oder gesammelt übernehmen"
        actions={<Link className="btn" href="/integrationen">Zurück zum Monitor</Link>}
      />

      <Card title="Filter">
        <form method="get" className="row">
          <label className="field">
            <span>Status</span>
            <select name="status" defaultValue={status}>
              {Object.entries(STATUS_FILTER).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Zeitraum</span>
            <select name="zeitraum" defaultValue={zeitraum}>
              {Object.entries(ZEITRAUM).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 2 }}>
            <span>Suche (Name, E-Mail, #Nummer)</span>
            <input type="search" name="q" defaultValue={text} placeholder="z. B. #1042 oder mustermann" />
          </label>
          <div className="shrink field">
            <button className="primary" type="submit">Anzeigen</button>
          </div>
        </form>
        <div className="small muted" style={{ marginTop: 8 }}>
          Anfrage an Shopify: <code className="mono">{anfrage || '(alles)'}</code>
        </div>
      </Card>

      {fehler && (
        <div className="notice danger">
          <span className="led warn" style={{ marginRight: 6 }} />
          {fehler}
        </div>
      )}

      {!fehler && orders.length === 0 && (
        <Empty>
          Keine Treffer. Falls ältere Bestellungen fehlen: ohne den Scope{' '}
          <code className="mono">read_all_orders</code> liefert Shopify nur die letzten 60 Tage —
          ältere erscheinen dann gar nicht. Scope in der App ergänzen und neu installieren.
        </Empty>
      )}

      {orders.length > 0 && (
        <Card
          title={`${orders.length} Bestellung(en) auf dieser Seite — ${fehlend} noch nicht im ERP`}
          actions={
            fehlend > 0 ? (
              <ActionForm action={alleUebernehmen}>
                <input type="hidden" name="q" value={anfrage} />
                <button className="small primary" type="submit">
                  Alle Treffer übernehmen
                </button>
              </ActionForm>
            ) : undefined
          }
          tight
        >
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Shopify</th>
                  <th>Datum</th>
                  <th>Kunde</th>
                  <th className="num">Betrag</th>
                  <th>Zahlung</th>
                  <th>Versand</th>
                  <th>Im ERP</th>
                  <th className="num">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const erp = imErp.get(o.id)
                  const kunde =
                    o.shippingAddress?.name ||
                    [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') ||
                    o.email || '—'
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.name}</td>
                      <td className="mono small nowrap">{dateTime(o.createdAt)}</td>
                      <td>{kunde}</td>
                      <td className="num">
                        {money(o.totalPriceSet.shopMoney.amount, o.totalPriceSet.shopMoney.currencyCode)}
                      </td>
                      <td>
                        <span className="badge neutral">
                          {ZAHLUNG[o.displayFinancialStatus ?? ''] ?? o.displayFinancialStatus ?? '—'}
                        </span>
                      </td>
                      <td>
                        <span className="badge neutral">
                          {o.cancelledAt ? 'storniert' : (VERSAND[o.displayFulfillmentStatus ?? ''] ?? '—')}
                        </span>
                      </td>
                      <td>
                        {erp ? (
                          <Link className="mono" href={`/verkauf/${erp.id}`}>{erp.number}</Link>
                        ) : (
                          <span className="muted small">fehlt</span>
                        )}
                      </td>
                      <td className="num">
                        {!erp && (
                          <ActionButton className="small" action={uebernehmen.bind(null, o.id)}>
                            Übernehmen
                          </ActionButton>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          <div className="small muted" style={{ padding: '10px 14px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>
              Übernahmeregeln: offen + bezahlt → bestätigt (Lieferung/Fertigung entstehen) ·
              offen + unbezahlt → Entwurf · bereits versandt → historischer Beleg ohne Logistik ·
              storniert → wird als storniert geführt.
            </span>
            {endCursor && (
              <Link href={filterLink({ after: endCursor })}>Weitere 50 laden →</Link>
            )}
          </div>
        </Card>
      )}
    </>
  )
}
