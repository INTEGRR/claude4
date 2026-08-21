import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, hours, isoDatum } from '@/modules/shared/format'
import { createShift, deleteShift } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Wochenplan. Eine Zeile je Mitarbeiter, eine Spalte je Tag — die Ansicht,
 * die am Schwarzen Brett hängt. Überschneidungen und Urlaubskollisionen
 * verhindert die Datenbank, hier muss nichts geprüft werden.
 */

const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

/** Montag der Woche, in der `d` liegt (ISO). */
function montag(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const tag = (x.getUTCDay() + 6) % 7
  x.setUTCDate(x.getUTCDate() - tag)
  return x
}

function iso(d: Date): string {
  return isoDatum(d)
}

export default async function SchichtplanPage({
  searchParams,
}: {
  searchParams: Promise<{ woche?: string }>
}) {
  await requireArea('personal')
  const { woche } = await searchParams

  const start = montag(woche ? new Date(`${woche}T00:00:00Z`) : new Date())
  const tage = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + i)
    return d
  })
  const ende = new Date(start)
  ende.setUTCDate(ende.getUTCDate() + 7)

  const vorwoche = new Date(start)
  vorwoche.setUTCDate(vorwoche.getUTCDate() - 7)
  const nachwoche = new Date(start)
  nachwoche.setUTCDate(nachwoche.getUTCDate() + 7)

  const mitarbeiter = await sql<{ id: string; name: string; department: string | null }[]>`
    select id, name, department from employees where active order by name`

  const eintraege = await sql<
    {
      id: string
      employee_id: string
      tag: string
      code: string | null
      name: string | null
      von: string
      bis: string
      minutes: number
      work_center: string | null
    }[]
  >`
    select s.id, s.employee_id,
           (s.starts_at at time zone 'Europe/Berlin')::date::text as tag,
           t.code, t.name,
           to_char(s.starts_at at time zone 'Europe/Berlin', 'HH24:MI') as von,
           to_char(s.ends_at at time zone 'Europe/Berlin', 'HH24:MI') as bis,
           extract(epoch from (s.ends_at - s.starts_at)) / 60 as minutes,
           w.code as work_center
    from shift_assignments s
    left join shift_templates t on t.id = s.template_id
    left join work_centers w on w.id = s.work_center_id
    where s.state <> 'cancel'
      and s.starts_at >= ${iso(start)}::date and s.starts_at < ${iso(ende)}::date
    order by s.starts_at`

  const abwesend = await sql<{ employee_id: string; starts_on: string; ends_on: string; kind: string }[]>`
    select employee_id, starts_on::text, ends_on::text, kind::text
    from absences
    where state = 'approved'
      and starts_on < ${iso(ende)}::date and ends_on >= ${iso(start)}::date`

  const vorlagen = await sql<
    { id: string; code: string; name: string; start_time: string; end_time: string }[]
  >`select id, code, name, start_time::text, end_time::text
    from shift_templates where active order by start_time`

  const arbeitsplaetze = await sql<{ id: string; label: string }[]>`
    select id, code || ' — ' || name as label from work_centers where active order by code`

  const geplant = eintraege.reduce((s, e) => s + Number(e.minutes), 0)

  return (
    <>
      <PageHeader
        title="Schichtplan"
        subtitle={`Woche ab ${date(iso(start))} — ${hours(geplant)} verplant`}
        actions={
          <>
            <Link className="btn" href={`/personal/schichtplan?woche=${iso(vorwoche)}`}>
              ← Woche
            </Link>
            <Link className="btn" href="/personal/schichtplan">Diese Woche</Link>
            <Link className="btn" href={`/personal/schichtplan?woche=${iso(nachwoche)}`}>
              Woche →
            </Link>
          </>
        }
      />

      <Card title={`Woche ${date(iso(start))} bis ${date(iso(tage[6]))}`} tight>
        {mitarbeiter.length === 0 ? (
          <Empty>
            Noch kein Mitarbeiter angelegt — <Link href="/personal">hier anlegen</Link>.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  {tage.map((t, i) => (
                    <th key={iso(t)}>
                      {WOCHENTAGE[i]} <span className="muted small">{date(iso(t))}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mitarbeiter.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/personal/${m.id}`}>{m.name}</Link>
                      {m.department && <div className="small muted">{m.department}</div>}
                    </td>
                    {tage.map((t) => {
                      const tag = iso(t)
                      const zellen = eintraege.filter(
                        (e) => e.employee_id === m.id && e.tag === tag,
                      )
                      const frei = abwesend.find(
                        (a) => a.employee_id === m.id && a.starts_on <= tag && a.ends_on >= tag,
                      )
                      return (
                        <td key={tag} className="small">
                          {frei ? (
                            <span className="badge warn">
                              {frei.kind === 'sick' ? 'krank' : 'abwesend'}
                            </span>
                          ) : zellen.length === 0 ? (
                            <span className="muted">—</span>
                          ) : (
                            zellen.map((z) => (
                              <div key={z.id} style={{ marginBottom: 4 }}>
                                <span className="mono">{z.von}–{z.bis}</span>{' '}
                                <span className="muted">{z.code ?? ''}</span>
                                {z.work_center && (
                                  <span className="muted small"> · {z.work_center}</span>
                                )}
                                <div>
                                  <ActionButton
                                    className="small danger"
                                    action={deleteShift.bind(null, z.id)}
                                  >
                                    Entfernen
                                  </ActionButton>
                                </div>
                              </div>
                            ))
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Schicht einplanen">
        <ActionForm action={createShift}>
          <div className="row">
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Mitarbeiter</span>
              <select name="employee_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {mitarbeiter.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Schicht</span>
              <select name="template_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {vorlagen.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.start_time.slice(0, 5)}–{v.end_time.slice(0, 5)})
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Tag</span>
              <input type="date" name="day" defaultValue={iso(start)} required />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Arbeitsplatz</span>
              <select name="work_center_id" defaultValue="">
                <option value="">— egal —</option>
                {arbeitsplaetze.map((w) => (
                  <option key={w.id} value={w.id}>{w.label}</option>
                ))}
              </select>
            </label>
            <div className="shrink">
              <button className="primary" type="submit">Einplanen</button>
            </div>
          </div>
        </ActionForm>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          Doppelbelegungen und Schichten während eines genehmigten Urlaubs weist die Datenbank ab —
          eine falsche Planung kann gar nicht erst gespeichert werden.
        </p>
      </Card>
    </>
  )
}
