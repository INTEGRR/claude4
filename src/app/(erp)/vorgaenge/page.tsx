import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { vorgangStarten } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Generische Vorgänge — das Chamäleon in Aktion: jede Zeile gehört zu einem
 * LAUFZEIT-Prozess (modell 'vorgang'), die Zustände kommen aus dessen
 * Definition. Eine neue Business-Linie ist hier ein neuer Prozess, keine
 * neue Fachtabelle.
 */
export default async function VorgaengePage() {
  await requireArea('verkauf')

  const prozesse = await sql<{ code: string; name: string }[]>`
    select code, name from prozesse
    where aktiv and modell = 'vorgang' order by name`

  const vorgaenge = await sql<
    {
      id: string
      number: string
      prozess_code: string
      prozess_name: string
      titel: string | null
      state: string
      partner: string | null
      partner_id: string | null
      created_at: string
      reparatur_id: string | null
      reparatur_number: string | null
      auftrag_id: string | null
      auftrag_number: string | null
    }[]
  >`
    select v.id, v.number, v.prozess_code, p.name as prozess_name,
           v.titel, v.state, pa.name as partner, v.partner_id, v.created_at,
           ro.id as reparatur_id, ro.number as reparatur_number,
           so.id as auftrag_id, so.number as auftrag_number
    from vorgaenge v
    join prozesse p on p.code = v.prozess_code
    left join partners pa on pa.id = v.partner_id
    -- Folgebelege über origin am KIND (0072/0081) — höchstens einer je Art.
    left join lateral (
      select r.id, r.number from repair_orders r
      where r.origin_model = 'vorgang' and r.origin_id = v.id limit 1
    ) ro on true
    left join lateral (
      select s.id, s.number from sales_orders s
      where s.origin_model = 'vorgang' and s.origin_id = v.id limit 1
    ) so on true
    order by v.created_at desc
    limit 200`

  const partner = await sql<{ id: string; name: string }[]>`
    select id, name from partners order by name limit 500`

  return (
    <>
      <PageHeader
        title="Vorgänge"
        subtitle="Laufzeit-Prozesse auf generischen Belegen — neue Business-Linien ohne neue Tabellen"
      />

      {prozesse.length === 0 ? (
        <Card title="Neuer Vorgang">
          <Empty>Kein aktiver Vorgangs-Prozess — unter /prozesse anlegen.</Empty>
        </Card>
      ) : (
        <Card title="Neuer Vorgang">
          <ActionForm action={vorgangStarten}>
            <div className="row">
              <label className="field">
                <span>Prozess</span>
                <select name="prozess_code" required defaultValue={prozesse[0].code}>
                  {prozesse.map((p) => (
                    <option key={p.code} value={p.code}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Titel</span>
                <input name="titel" maxLength={200} placeholder="Worum geht es?" />
              </label>
              <label className="field">
                <span>Kontakt (optional)</span>
                <select name="partner_id" defaultValue="">
                  <option value="">—</option>
                  {partner.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Starten</button>
              </div>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card title={`Vorgänge (${vorgaenge.length})`} tight>
        {vorgaenge.length === 0 ? (
          <Empty>Noch keine Vorgänge.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Prozess</th>
                  <th>Titel</th>
                  <th>Zustand</th>
                  <th>Kontakt</th>
                  <th>Folgebeleg</th>
                  <th>Angelegt</th>
                </tr>
              </thead>
              <tbody>
                {vorgaenge.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link className="mono" href={`/vorgaenge/${v.id}`}>{v.number}</Link>
                    </td>
                    <td className="small">
                      <Link href={`/vorgaenge/prozess/${v.prozess_code}`}>{v.prozess_name}</Link>
                    </td>
                    <td>{v.titel ?? <span className="muted">—</span>}</td>
                    <td>
                      <Link
                        className="badge neutral mono"
                        href={`/vorgaenge/prozess/${v.prozess_code}?zustand=${encodeURIComponent(v.state)}`}
                        title="Alle Vorgänge dieses Ablaufs in diesem Zustand"
                      >
                        {v.state}
                      </Link>
                    </td>
                    <td className="small">
                      {v.partner && v.partner_id ? (
                        <Link href={`/kontakte/${v.partner_id}`}>{v.partner}</Link>
                      ) : (
                        (v.partner ?? '—')
                      )}
                    </td>
                    <td className="mono small">
                      {v.reparatur_id && (
                        <Link href={`/reparatur/${v.reparatur_id}`}>{v.reparatur_number}</Link>
                      )}
                      {v.reparatur_id && v.auftrag_id && ' · '}
                      {v.auftrag_id && <Link href={`/verkauf/${v.auftrag_id}`}>{v.auftrag_number}</Link>}
                      {!v.reparatur_id && !v.auftrag_id && <span className="muted">—</span>}
                    </td>
                    <td className="mono small">{dateTime(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  )
}
