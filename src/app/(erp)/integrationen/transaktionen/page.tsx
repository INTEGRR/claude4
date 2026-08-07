import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Transaktionsprotokoll: jede API-Interaktion mit Shopify, DHL und dem
 * Mailversand — filterbar, mit aufklappbarem Request/Response-Detail.
 */

const SYSTEME = [
  { key: undefined, label: 'Alle Systeme' },
  { key: 'shopify', label: 'Shopify' },
  { key: 'dhl', label: 'DHL' },
  { key: 'mail', label: 'E-Mail' },
] as const

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default async function TransaktionenPage({
  searchParams,
}: {
  searchParams: Promise<{ system?: string; nur?: string; q?: string }>
}) {
  await requireArea('integrationen')
  const { system, nur, q } = await searchParams
  const nurFehler = nur === 'fehler'

  const rows = await sql<
    {
      id: string
      system: string
      kind: string
      reference: string | null
      request: unknown
      response: unknown
      ok: boolean
      status_code: number | null
      error: string | null
      duration_ms: number | null
      created_at: string
    }[]
  >`
    select id, system, kind, reference, request, response, ok, status_code, error,
           duration_ms, created_at
    from api_transactions
    where (${system ?? null}::text is null or system = ${system ?? null})
      and (${!nurFehler} or not ok)
      and (${q ?? null}::text is null
           or reference ilike ${'%' + (q ?? '') + '%'}
           or kind ilike ${'%' + (q ?? '') + '%'})
    order by created_at desc
    limit 200`

  const linkFor = (params: Record<string, string | undefined>) => {
    const merged = { system, nur, q, ...params }
    const query = Object.entries(merged)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join('&')
    return `/integrationen/transaktionen${query ? `?${query}` : ''}`
  }

  return (
    <>
      <PageHeader
        title="Transaktionsprotokoll"
        subtitle="Jeder API-Aufruf nach draußen — mit Request, Antwort, Dauer und Fehler"
        actions={<Link className="btn" href="/integrationen">Zurück zum Monitor</Link>}
      />

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {SYSTEME.map((s) => (
            <Link
              key={s.label}
              href={linkFor({ system: s.key })}
              className={`btn small${(system ?? undefined) === s.key ? ' primary' : ''}`}
            >
              {s.label}
            </Link>
          ))}
          <Link
            href={linkFor({ nur: nurFehler ? undefined : 'fehler' })}
            className={`btn small${nurFehler ? ' danger' : ''}`}
          >
            Nur Fehler
          </Link>
          <form style={{ marginLeft: 'auto' }}>
            {system && <input type="hidden" name="system" value={system} />}
            {nurFehler && <input type="hidden" name="nur" value="fehler" />}
            <input
              type="search"
              name="q"
              placeholder="Referenz oder Art suchen"
              defaultValue={q ?? ''}
              style={{ width: 240 }}
            />
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>
            Keine Transaktionen{nurFehler ? ' mit Fehlern' : ''} gefunden. Protokolliert wird ab
            jetzt jeder Aufruf nach draußen.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>System</th>
                  <th>Art</th>
                  <th>Referenz</th>
                  <th>Status</th>
                  <th className="num">Dauer</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap small">{dateTime(t.created_at)}</td>
                    <td><span className="badge neutral">{t.system}</span></td>
                    <td className="mono small">{t.kind}</td>
                    <td className="mono small">{t.reference ?? '—'}</td>
                    <td>
                      <span className={`badge ${t.ok ? 'success' : 'danger'}`}>
                        {t.ok ? 'ok' : 'Fehler'}
                        {t.status_code ? ` · ${t.status_code}` : ''}
                      </span>
                    </td>
                    <td className="num small">{t.duration_ms != null ? `${t.duration_ms} ms` : '—'}</td>
                    <td style={{ maxWidth: 480 }}>
                      {t.error && <div className="small" style={{ color: 'var(--danger)' }}>{t.error}</div>}
                      <details>
                        <summary className="small muted" style={{ cursor: 'pointer' }}>
                          Request / Antwort
                        </summary>
                        <div className="small muted" style={{ marginTop: 6 }}>Request</div>
                        <pre className="tx-json">{formatJson(t.request)}</pre>
                        <div className="small muted">Antwort</div>
                        <pre className="tx-json">{formatJson(t.response)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div className="small muted" style={{ padding: '8px 12px' }}>
          Zeigt die letzten 200 Einträge. Transaktionen werden nach 30 Tagen automatisch
          aufgeräumt (täglicher Housekeeping-Lauf).
        </div>
      </Card>
    </>
  )
}
