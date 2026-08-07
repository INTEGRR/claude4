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

/** Roh-JSON als dunkle Datenfläche mit Kopfzeile statt als nackter Block. */
function Json({
  titel,
  wert,
  zusatz,
}: {
  titel: string
  wert: unknown
  zusatz?: string | number
}) {
  return (
    <div className="display-panel" style={{ margin: '6px 0' }}>
      <div className="display-head">
        <span>{titel}</span>
        <span>{zusatz || ''}</span>
      </div>
      <pre className="tx-json" style={{ background: 'transparent', border: 0, padding: 0, margin: 0 }}>
        {formatJson(wert)}
      </pre>
    </div>
  )
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
        <div className="actions" style={{ padding: 12 }}>
          {SYSTEME.map((s) => {
            const aktiv = (system ?? undefined) === s.key
            return (
              <Link
                key={s.label}
                href={linkFor({ system: s.key })}
                aria-current={aktiv ? 'true' : undefined}
                className={`btn small${aktiv ? ' primary' : ''}`}
              >
                {s.label}
              </Link>
            )
          })}
          {/* Ein gesetzter Filter ist aktive Navigation, kein zerstörender Vorgang. */}
          <Link
            href={linkFor({ nur: nurFehler ? undefined : 'fehler' })}
            aria-current={nurFehler ? 'true' : undefined}
            className={`btn small${nurFehler ? ' primary' : ''}`}
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
                    <td className="nowrap small mono">{dateTime(t.created_at)}</td>
                    <td><span className="badge neutral">{t.system}</span></td>
                    <td className="mono small">{t.kind}</td>
                    <td className="mono small">{t.reference ?? '—'}</td>
                    <td>
                      <span className={`badge ${t.ok ? 'success' : 'danger'}`}>
                        {t.ok ? 'ok' : 'Fehler'}
                        {t.status_code ? ` · ${t.status_code}` : ''}
                      </span>
                    </td>
                    <td className="num small mono">
                      {t.duration_ms != null ? `${t.duration_ms} ms` : '—'}
                    </td>
                    <td style={{ maxWidth: 480 }}>
                      {t.error && <div className="small" style={{ color: 'var(--danger)' }}>{t.error}</div>}
                      <details>
                        <summary className="mono-label" style={{ cursor: 'pointer', marginTop: 6 }}>
                          Request / Antwort
                        </summary>
                        {/* Roh-JSON ist eine Datenfläche: Display mit Typenschild-Kopf. */}
                        <Json titel="Request" wert={t.request} zusatz={t.system} />
                        <Json
                          titel="Antwort"
                          wert={t.response}
                          zusatz={[
                            t.status_code != null ? String(t.status_code) : null,
                            t.duration_ms != null ? `${t.duration_ms} ms` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        />
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
