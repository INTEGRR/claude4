import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { Card, PageHeader } from '@/components/ui'
import { ProzessPanel } from '@/components/prozess-panel'
import { RecordComments } from '@/components/record-comments'
import { dateTime } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Ein generischer Vorgang: Kopf, Prozess-Panel (Diagramm + nächste Schritte
 * als generierte Formulare) und die eigenen Felder aus dem zusatz-jsonb —
 * die ganze Seite kennt keinen konkreten Prozess beim Namen.
 */
export default async function VorgangDetail({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireArea('verkauf')
  const { id } = await params

  const [v] = await sql<
    {
      id: string
      number: string
      prozess_code: string
      prozess_name: string
      titel: string | null
      state: string
      partner: string | null
      partner_id: string | null
      zusatz: Record<string, unknown>
      created_at: string
    }[]
  >`
    select v.id, v.number, v.prozess_code, p.name as prozess_name,
           v.titel, v.state, pa.name as partner, v.partner_id, v.zusatz, v.created_at
    from vorgaenge v
    join prozesse p on p.code = v.prozess_code
    left join partners pa on pa.id = v.partner_id
    where v.id = ${id}`
  if (!v) notFound()

  // Beschriftungen der eigenen Felder für die Anzeige.
  const felder = await sql<{ name: string; label: string }[]>`
    select name, label from feld_definitionen
    where modell = 'vorgang' order by sequence, name`
  const beschriftung = new Map(felder.map((f) => [f.name, f.label]))
  const zusatzEintraege = Object.entries(v.zusatz ?? {})

  return (
    <>
      <PageHeader
        title={<span className="mono">{v.number}</span>}
        subtitle={
          <>
            {v.prozess_name}
            {v.titel && <> · {v.titel}</>}
            {v.partner && v.partner_id && (
              <>
                {' '}· <Link href={`/kontakte/${v.partner_id}`}>{v.partner}</Link>
              </>
            )}
            {' '}· angelegt <span className="mono">{dateTime(v.created_at)}</span>
          </>
        }
        actions={
          <>
            <span className="badge info mono">{v.state}</span>
            <Link className="btn" href="/vorgaenge">Alle Vorgänge</Link>
          </>
        }
      />

      <ProzessPanel prozessCode={v.prozess_code} recordId={v.id} rolle={user.role} />

      {zusatzEintraege.length > 0 && (
        <Card title="Eigene Felder">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {zusatzEintraege.map(([name, wert]) => (
              <li key={name}>
                <span className="mono-label" style={{ marginRight: 8 }}>
                  {beschriftung.get(name) ?? name}
                </span>
                {String(wert)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RecordComments model="vorgang" recordId={v.id} path={`/vorgaenge/${v.id}`} />
    </>
  )
}
