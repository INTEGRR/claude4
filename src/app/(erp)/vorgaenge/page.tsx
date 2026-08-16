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
      created_at: string
    }[]
  >`
    select v.id, v.number, v.prozess_code, p.name as prozess_name,
           v.titel, v.state, pa.name as partner, v.created_at
    from vorgaenge v
    join prozesse p on p.code = v.prozess_code
    left join partners pa on pa.id = v.partner_id
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
                  <th>Angelegt</th>
                </tr>
              </thead>
              <tbody>
                {vorgaenge.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link className="mono" href={`/vorgaenge/${v.id}`}>{v.number}</Link>
                    </td>
                    <td className="small">{v.prozess_name}</td>
                    <td>{v.titel ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className="badge neutral mono">{v.state}</span>
                    </td>
                    <td className="small">{v.partner ?? '—'}</td>
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
