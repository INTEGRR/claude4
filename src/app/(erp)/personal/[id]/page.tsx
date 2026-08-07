import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, dateTime, hours, money } from '@/modules/shared/format'
import { addTimeEntry, deleteTimeEntry, requestAbsence, updateEmployee } from '../actions'

export const dynamic = 'force-dynamic'

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Vollzeit',
  part_time: 'Teilzeit',
  mini_job: 'Minijob',
  temp: 'Aushilfe',
  apprentice: 'Auszubildende(r)',
}

const ABSENCE_LABEL: Record<string, string> = {
  vacation: 'Urlaub',
  sick: 'Krank',
  training: 'Schulung',
  unpaid: 'Unbezahlt',
  other: 'Sonstiges',
}

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('personal')
  const { id } = await params

  const [e] = await sql<
    {
      id: string
      number: string
      name: string
      user_id: string | null
      barcode: string | null
      job_title: string | null
      department: string | null
      employment_type: string
      hourly_cost: number
      weekly_hours: number
      vacation_days: number
      hire_date: string | null
      exit_date: string | null
      email: string | null
      phone: string | null
      note: string | null
      active: boolean
      present: boolean
    }[]
  >`
    select e.*, exists (select 1 from employees_present p where p.employee_id = e.id) as present
    from employees e where e.id = ${id}`

  if (!e) notFound()

  const users = await sql<{ id: string; label: string }[]>`
    select id, name || ' · ' || email as label from users order by name`

  const [monat] = await sql<{ minutes: number; auftragszeit: number }[]>`
    select employee_minutes(${id}, date_trunc('month', current_date)::date, current_date) as minutes,
           coalesce((select sum(t.minutes) from time_entries t
                     where t.employee_id = ${id} and t.kind = 'production'
                       and t.started_at >= date_trunc('month', current_date)), 0) as auftragszeit`

  const [urlaub] = await sql<{ genommen: number; offen: number }[]>`
    select coalesce(sum(absence_days(a.id)) filter (where a.state = 'approved'), 0) as genommen,
           coalesce(sum(absence_days(a.id)) filter (where a.state = 'requested'), 0) as offen
    from absences a
    where a.employee_id = ${id} and a.kind = 'vacation'
      and extract(year from a.starts_on) = extract(year from current_date)`

  const zeiten = await sql<
    {
      id: string
      kind: string
      started_at: string
      ended_at: string | null
      break_minutes: number
      minutes: number
      cost: number
      auftrag: string | null
      arbeitsgang: string | null
    }[]
  >`
    select t.id, t.kind::text, t.started_at, t.ended_at, t.break_minutes, t.minutes,
           round(t.minutes / 60.0 * t.hourly_cost, 2) as cost,
           mo.number as auftrag, o.name as arbeitsgang
    from time_entries t
    left join mo_operations o on o.id = t.mo_operation_id
    left join manufacturing_orders mo on mo.id = o.mo_id
    where t.employee_id = ${id}
    order by t.started_at desc
    limit 40`

  const abwesenheiten = await sql<
    {
      id: string
      kind: string
      starts_on: string
      ends_on: string
      half_day: boolean
      state: string
      reason: string | null
      tage: number
    }[]
  >`
    select a.id, a.kind::text, a.starts_on::text, a.ends_on::text, a.half_day, a.state::text,
           a.reason, absence_days(a.id) as tage
    from absences a where a.employee_id = ${id}
    order by a.starts_on desc limit 30`

  const schichten = await sql<
    { id: string; name: string | null; starts_at: string; ends_at: string; state: string }[]
  >`
    select s.id, t.name, s.starts_at, s.ends_at, s.state::text
    from shift_assignments s
    left join shift_templates t on t.id = s.template_id
    where s.employee_id = ${id} and s.ends_at >= now() - interval '7 days'
    order by s.starts_at limit 20`

  return (
    <>
      <PageHeader
        kicker="Mitarbeiter"
        title={e.name}
        subtitle={
          <>
            <span className="mono">{e.number}</span>
            {e.job_title && <> · {e.job_title}</>}
            {e.department && <> · {e.department}</>}
            {' · '}
            {EMPLOYMENT_LABEL[e.employment_type] ?? e.employment_type}
            {e.hire_date && <> · seit {date(e.hire_date)}</>}
          </>
        }
        actions={
          <>
            <span className={`led ${e.present ? 'on' : e.active ? 'off' : 'off'}`} />
            <span className="mono-label">
              {!e.active ? 'ausgetreten' : e.present ? 'im Haus' : 'nicht da'}
            </span>
            <Link className="btn" href="/personal">Zur Übersicht</Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Anwesenheit (Monat)" value={hours(monat.minutes)} hint="abgeschlossene Buchungen" />
        <Stat
          label="Auftragszeit (Monat)"
          value={hours(monat.auftragszeit)}
          hint="auf Fertigungsaufträge gebucht"
        />
        <Stat
          label="Urlaub"
          value={`${Number(urlaub.genommen)} / ${Number(e.vacation_days)} Tage`}
          hint={
            Number(urlaub.offen) > 0
              ? `${Number(urlaub.offen)} Tag(e) beantragt`
              : 'genehmigt im laufenden Jahr'
          }
        />
      </div>

      <Card title="Stammdaten">
        <ActionForm action={updateEmployee.bind(null, id)}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Name</span>
              <input name="name" defaultValue={e.name} required />
            </label>
            <label className="field">
              <span>Ausweis-Barcode</span>
              <input className="mono" name="barcode" defaultValue={e.barcode ?? ''} />
            </label>
            <label className="field">
              <span>Funktion</span>
              <input name="job_title" defaultValue={e.job_title ?? ''} />
            </label>
            <label className="field">
              <span>Abteilung</span>
              <input name="department" defaultValue={e.department ?? ''} />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Vertrag</span>
              <select name="employment_type" defaultValue={e.employment_type}>
                {Object.entries(EMPLOYMENT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kostensatz (€/Std.)</span>
              <input
                className="mono"
                type="number"
                name="hourly_cost"
                step="0.01"
                min="0"
                defaultValue={Number(e.hourly_cost)}
              />
            </label>
            <label className="field">
              <span>Wochenstunden</span>
              <input type="number" name="weekly_hours" step="0.5" min="0" defaultValue={Number(e.weekly_hours)} />
            </label>
            <label className="field">
              <span>Urlaubstage / Jahr</span>
              <input type="number" name="vacation_days" step="0.5" min="0" defaultValue={Number(e.vacation_days)} />
            </label>
            <label className="field">
              <span>Benutzerkonto</span>
              <select name="user_id" defaultValue={e.user_id ?? ''}>
                <option value="">— keines —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" defaultValue={e.email ?? ''} />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" defaultValue={e.phone ?? ''} />
            </label>
            <label className="field">
              <span>Eintritt</span>
              <input type="date" name="hire_date" defaultValue={e.hire_date ?? ''} />
            </label>
            <label className="field">
              <span>Austritt</span>
              <input type="date" name="exit_date" defaultValue={e.exit_date ?? ''} />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Notiz</span>
              <input name="note" defaultValue={e.note ?? ''} />
            </label>
            <label className="shrink field">
              <input type="checkbox" name="active" defaultChecked={e.active} /> aktiv
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card title={`Zeitbuchungen (${zeiten.length})`} tight>
        {zeiten.length === 0 ? (
          <Empty>Noch keine Zeit erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Von</th>
                  <th>Bis</th>
                  <th className="num">Pause</th>
                  <th className="num">Netto</th>
                  <th className="num">Kosten</th>
                  <th>Auftrag</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {zeiten.map((z) => (
                  <tr key={z.id}>
                    <td className="small muted">
                      {z.kind === 'attendance' ? 'Anwesenheit' : 'Auftragszeit'}
                    </td>
                    <td className="mono small nowrap">{dateTime(z.started_at)}</td>
                    <td className="mono small nowrap">
                      {z.ended_at ? (
                        dateTime(z.ended_at)
                      ) : (
                        <>
                          <span className="led on" /> läuft
                        </>
                      )}
                    </td>
                    <td className="num mono">
                      {Number(z.break_minutes) > 0 ? `${Number(z.break_minutes)} Min.` : '—'}
                    </td>
                    <td className="num mono">{z.ended_at ? hours(z.minutes) : '—'}</td>
                    <td className="num mono muted">{z.ended_at ? money(z.cost) : '—'}</td>
                    <td className="small muted">
                      {z.auftrag ? `${z.auftrag} · ${z.arbeitsgang}` : '—'}
                    </td>
                    <td className="num">
                      {z.kind === 'attendance' && z.ended_at && (
                        <ActionButton
                          className="small danger"
                          action={deleteTimeEntry.bind(null, id, z.id)}
                          confirm="Diese Buchung löschen?"
                        >
                          Löschen
                        </ActionButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <ActionForm action={addTimeEntry}>
            <input type="hidden" name="employee_id" value={id} />
            <div className="row">
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Beginn nachtragen</span>
                <input type="datetime-local" name="started_at" required />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Ende</span>
                <input type="datetime-local" name="ended_at" required />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Pause (Min.)</span>
                <input type="number" name="break_minutes" min="0" step="1" defaultValue="0" />
              </label>
              <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                <span>Grund</span>
                <input name="note" placeholder="Ausweis vergessen" />
              </label>
              <div className="shrink">
                <button type="submit">Nachtragen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>

      <Card title={`Abwesenheiten (${abwesenheiten.length})`} tight>
        {abwesenheiten.length === 0 ? (
          <Empty>Keine Abwesenheiten erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Von</th>
                  <th>Bis</th>
                  <th className="num">Tage</th>
                  <th>Status</th>
                  <th>Grund</th>
                </tr>
              </thead>
              <tbody>
                {abwesenheiten.map((a) => (
                  <tr key={a.id}>
                    <td>{ABSENCE_LABEL[a.kind] ?? a.kind}</td>
                    <td className="mono small nowrap">{date(a.starts_on)}</td>
                    <td className="mono small nowrap">{a.half_day ? 'halber Tag' : date(a.ends_on)}</td>
                    <td className="num mono">{Number(a.tage)}</td>
                    <td><Badge state={a.state} kind="absence" /></td>
                    <td className="small muted">{a.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <ActionForm action={requestAbsence}>
            <input type="hidden" name="employee_id" value={id} />
            <div className="row">
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Art</span>
                <select name="kind" defaultValue="vacation">
                  {Object.entries(ABSENCE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Von</span>
                <input type="date" name="starts_on" required />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Bis</span>
                <input type="date" name="ends_on" required />
              </label>
              <label className="shrink field" style={{ marginBottom: 0 }}>
                <input type="checkbox" name="half_day" /> halber Tag
              </label>
              <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                <span>Grund</span>
                <input name="reason" />
              </label>
              <div className="shrink">
                <button type="submit">Beantragen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>

      <Card title="Geplante Schichten" actions={<Link className="btn small" href="/personal/schichtplan">Zum Plan</Link>} tight>
        {schichten.length === 0 ? (
          <Empty>Keine Schichten geplant.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Schicht</th>
                  <th>Beginn</th>
                  <th>Ende</th>
                  <th className="num">Dauer</th>
                </tr>
              </thead>
              <tbody>
                {schichten.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name ?? 'Einzelschicht'}</td>
                    <td className="mono small nowrap">{dateTime(s.starts_at)}</td>
                    <td className="mono small nowrap">{dateTime(s.ends_at)}</td>
                    <td className="num mono">
                      {hours((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <RecordComments model="employee" recordId={id} path={`/personal/${id}`} />
    </>
  )
}
