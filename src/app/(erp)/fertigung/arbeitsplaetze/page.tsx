import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { money, qty } from '@/modules/shared/format'
import { createWorkCenter, updateWorkCenter } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Arbeitsplätze (mrp.workcenter). Der Stundensatz ist die einzige Stelle, an
 * der Lohnkosten gepflegt werden — alles Weitere ergibt sich aus den
 * erfassten Zeiten der Arbeitsgänge.
 */
export default async function WorkCentersPage() {
  await requireArea('fertigung')

  const centers = await sql<
    {
      id: string
      code: string
      name: string
      cost_per_hour: number
      capacity: number
      time_efficiency: number
      active: boolean
      note: string | null
      operations: number
      minutes_open: number
      minutes_done: number
      cost_done: number
    }[]
  >`
    select w.id, w.code, w.name, w.cost_per_hour, w.capacity, w.time_efficiency,
           w.active, w.note,
           (select count(*) from bom_operations o where o.work_center_id = w.id)::int as operations,
           coalesce((select sum(o.duration_expected) from mo_operations o
                     where o.work_center_id = w.id and o.state in ('pending', 'progress')), 0)
             as minutes_open,
           coalesce((select sum(o.duration_real) from mo_operations o
                     where o.work_center_id = w.id and o.state = 'done'), 0) as minutes_done,
           coalesce((select sum(o.duration_real / 60.0 * o.cost_per_hour) from mo_operations o
                     where o.work_center_id = w.id and o.state = 'done'), 0) as cost_done
    from work_centers w
    order by w.active desc, w.code`

  const offen = centers.reduce((s, w) => s + Number(w.minutes_open), 0)
  const lohn = centers.reduce((s, w) => s + Number(w.cost_done), 0)

  return (
    <>
      <PageHeader
        title="Arbeitsplätze"
        subtitle="Stundensatz und Leistung je Arbeitsplatz — die Grundlage der Lohnkosten in der Fertigung"
        actions={<Link className="btn" href="/fertigung/stuecklisten">Zu den Stücklisten</Link>}
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Arbeitsplätze" value={qty(centers.filter((w) => w.active).length)} hint="aktiv" />
        <Stat
          label="Offene Arbeitszeit"
          value={`${qty(offen)} Min.`}
          hint="geplant in laufenden Aufträgen"
        />
        <Stat label="Verbuchte Lohnkosten" value={money(lohn)} hint="aus erledigten Arbeitsgängen" />
      </div>

      <Card title={`Arbeitsplätze (${centers.length})`} tight>
        {centers.length === 0 ? (
          <Empty>Noch kein Arbeitsplatz angelegt — ohne Arbeitsplatz gibt es keine Lohnkosten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Kürzel</th>
                  <th>Name</th>
                  <th className="num">Stundensatz</th>
                  <th className="num">Plätze</th>
                  <th className="num">Leistung</th>
                  <th className="num">Offen</th>
                  <th className="num">Erfasst</th>
                  <th>Zustand</th>
                </tr>
              </thead>
              <tbody>
                {centers.map((w) => (
                  <tr key={w.id}>
                    <td className="mono">{w.code}</td>
                    <td>
                      {w.name}
                      {w.note && <div className="small muted">{w.note}</div>}
                      <div className="small muted">
                        {w.operations} Arbeitsgang/-gänge in Stücklisten
                      </div>
                    </td>
                    <td className="num mono">{money(w.cost_per_hour)}</td>
                    <td className="num mono">{qty(w.capacity)}</td>
                    <td className="num mono">{Number(w.time_efficiency)} %</td>
                    <td className="num mono muted">{qty(w.minutes_open)} Min.</td>
                    <td className="num mono">
                      {qty(w.minutes_done)} Min.
                      <div className="small muted">{money(w.cost_done)}</div>
                    </td>
                    <td className="nowrap">
                      <span className={`led ${w.active ? 'ok' : 'off'}`} />{' '}
                      <span className="small muted">{w.active ? 'aktiv' : 'stillgelegt'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {centers.map((w) => (
        <details key={w.id} className="card" style={{ padding: '10px 14px' }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="mono">{w.code}</span> — {w.name} bearbeiten
          </summary>
          <ActionForm action={updateWorkCenter.bind(null, w.id)} style={{ marginTop: 10 }}>
            <div className="row">
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Name</span>
                <input name="name" defaultValue={w.name} required />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Stundensatz (€)</span>
                <input
                  className="mono"
                  type="number"
                  name="cost_per_hour"
                  step="0.01"
                  min="0"
                  defaultValue={Number(w.cost_per_hour)}
                />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Plätze</span>
                <input type="number" name="capacity" step="1" min="1" defaultValue={Number(w.capacity)} />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Leistung (%)</span>
                <input
                  type="number"
                  name="time_efficiency"
                  step="1"
                  min="1"
                  defaultValue={Number(w.time_efficiency)}
                />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Notiz</span>
                <input name="note" defaultValue={w.note ?? ''} />
              </label>
              <label className="shrink field" style={{ marginBottom: 0 }}>
                <input type="checkbox" name="active" defaultChecked={w.active} /> aktiv
              </label>
              <div className="shrink">
                <button type="submit">Speichern</button>
              </div>
            </div>
          </ActionForm>
        </details>
      ))}

      <Card title="Arbeitsplatz anlegen">
        <ActionForm action={createWorkCenter}>
          <div className="row">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Kürzel</span>
              <input className="mono" name="code" placeholder="MONTAGE" required />
            </label>
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Name</span>
              <input name="name" placeholder="Montageplatz 1" required />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Stundensatz (€)</span>
              <input className="mono" type="number" name="cost_per_hour" step="0.01" min="0" defaultValue="0" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Plätze</span>
              <input type="number" name="capacity" step="1" min="1" defaultValue="1" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Leistung (%)</span>
              <input type="number" name="time_efficiency" step="1" min="1" defaultValue="100" />
            </label>
            <div className="shrink">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          Die Leistung streckt die Vorgabezeit: 80 % heißt, dass der Arbeitsplatz für 40 geplante
          Minuten tatsächlich 50 braucht. Der Stundensatz wird beim Anlegen eines Fertigungsauftrags
          eingefroren — spätere Tarifänderungen verändern alte Aufträge nicht.
        </p>
      </Card>
    </>
  )
}
