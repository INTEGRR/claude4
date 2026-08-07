import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { HBars } from '@/components/charts'
import { date, hours, money } from '@/modules/shared/format'
import { createEmployee } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Personalübersicht: wer ist da, wer ist abwesend, wie viel Zeit ist diesen
 * Monat erfasst. Die Personalkosten stehen bewusst hier und nirgends sonst —
 * sie sind der einzige Wert, den nur das Büro sehen darf.
 */

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Vollzeit',
  part_time: 'Teilzeit',
  mini_job: 'Minijob',
  temp: 'Aushilfe',
  apprentice: 'Auszubildende(r)',
}

export default async function PersonalPage() {
  await requireArea('personal')

  const mitarbeiter = await sql<
    {
      id: string
      number: string
      name: string
      job_title: string | null
      department: string | null
      employment_type: string
      hourly_cost: number
      weekly_hours: number
      active: boolean
      present: boolean
      absent_until: string | null
      minutes_month: number
    }[]
  >`
    select e.id, e.number, e.name, e.job_title, e.department, e.employment_type::text,
           e.hourly_cost, e.weekly_hours, e.active,
           exists (select 1 from employees_present p where p.employee_id = e.id) as present,
           (select max(a.ends_on)::text from absences a
             where a.employee_id = e.id and a.state = 'approved'
               and current_date between a.starts_on and a.ends_on) as absent_until,
           employee_minutes(e.id, date_trunc('month', current_date)::date, current_date) as minutes_month
    from employees e
    order by e.active desc, e.name`

  const offeneAntraege = await sql<{ c: number }[]>`
    select count(*)::int as c from absences where state = 'requested'`

  const schichten = await sql<{ c: number }[]>`
    select count(*)::int as c from shift_assignments
    where state <> 'cancel' and starts_at >= date_trunc('week', now())
      and starts_at < date_trunc('week', now()) + interval '7 days'`

  const aktive = mitarbeiter.filter((m) => m.active)
  const monatsminuten = aktive.reduce((s, m) => s + Number(m.minutes_month), 0)
  const monatskosten = aktive.reduce(
    (s, m) => s + (Number(m.minutes_month) / 60) * Number(m.hourly_cost),
    0,
  )

  return (
    <>
      <PageHeader
        title="Personal"
        subtitle="Mitarbeiterstamm, erfasste Zeit und Personalkosten des laufenden Monats"
        actions={
          <>
            <Link className="btn" href="/zeiterfassung">Stempeluhr</Link>
            <Link className="btn" href="/personal/schichtplan">Schichtplan</Link>
            <Link className="btn" href="/personal/abwesenheiten">
              Abwesenheiten
              {offeneAntraege[0].c > 0 && <span className="badge warn"> {offeneAntraege[0].c}</span>}
            </Link>
          </>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Aktive Mitarbeiter"
          value={String(aktive.length)}
          hint={`${aktive.filter((m) => m.present).length} gerade im Haus`}
        />
        <Stat
          label="Erfasst diesen Monat"
          value={hours(monatsminuten)}
          hint={`${schichten[0].c} Schicht(en) diese Woche geplant`}
        />
        <Stat
          label="Personalkosten"
          value={money(monatskosten)}
          hint="erfasste Zeit × Kostensatz, laufender Monat"
        />
      </div>

      {aktive.length > 0 && monatsminuten > 0 && (
        <Card title="Erfasste Zeit diesen Monat" tight>
          <div style={{ padding: 12 }}>
            <HBars
              unit="Min."
              rows={aktive
                .filter((m) => Number(m.minutes_month) > 0)
                .sort((a, b) => Number(b.minutes_month) - Number(a.minutes_month))
                .slice(0, 10)
                .map((m) => ({ label: m.name, value: Math.round(Number(m.minutes_month)) }))}
            />
          </div>
        </Card>
      )}

      <Card title={`Mitarbeiter (${mitarbeiter.length})`} tight>
        {mitarbeiter.length === 0 ? (
          <Empty>Noch kein Mitarbeiter angelegt.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Name</th>
                  <th>Funktion</th>
                  <th>Vertrag</th>
                  <th className="num">Kostensatz</th>
                  <th className="num">Wochenstunden</th>
                  <th className="num">Monat</th>
                  <th>Zustand</th>
                </tr>
              </thead>
              <tbody>
                {mitarbeiter.map((m) => (
                  <tr key={m.id}>
                    <td className="mono small">{m.number}</td>
                    <td>
                      <Link href={`/personal/${m.id}`}>{m.name}</Link>
                      {m.department && <div className="small muted">{m.department}</div>}
                    </td>
                    <td className="small">{m.job_title ?? '—'}</td>
                    <td className="small muted">
                      {EMPLOYMENT_LABEL[m.employment_type] ?? m.employment_type}
                    </td>
                    <td className="num mono">{money(m.hourly_cost)} / Std.</td>
                    <td className="num mono">{Number(m.weekly_hours)} h</td>
                    <td className="num mono">{hours(m.minutes_month)}</td>
                    <td className="nowrap">
                      {!m.active ? (
                        <>
                          <span className="led off" /> <span className="small muted">ausgetreten</span>
                        </>
                      ) : m.absent_until ? (
                        <>
                          <span className="led warn" />{' '}
                          <span className="small muted">abwesend bis {date(m.absent_until)}</span>
                        </>
                      ) : m.present ? (
                        <>
                          <span className="led on" /> <span className="small muted">im Haus</span>
                        </>
                      ) : (
                        <>
                          <span className="led off" /> <span className="small muted">nicht da</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Mitarbeiter anlegen">
        <ActionForm action={createEmployee}>
          <div className="row">
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Name</span>
              <input name="name" placeholder="Vor- und Nachname" required />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Ausweis-Barcode</span>
              <input className="mono" name="barcode" placeholder="für die Stempeluhr" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Funktion</span>
              <input name="job_title" placeholder="Montage" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Vertrag</span>
              <select name="employment_type" defaultValue="full_time">
                {Object.entries(EMPLOYMENT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Kostensatz (€/Std.)</span>
              <input className="mono" type="number" name="hourly_cost" step="0.01" min="0" defaultValue="0" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Wochenstunden</span>
              <input type="number" name="weekly_hours" step="0.5" min="0" defaultValue="40" />
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Eintritt</span>
              <input type="date" name="hire_date" />
            </label>
            <div className="shrink">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          Der Kostensatz ist der Vollkostensatz je Arbeitsstunde. Er wird beim Buchen einer
          Auftragszeit eingefroren und geht in die Herstellkosten des Fertigungsauftrags ein.
        </p>
      </Card>
    </>
  )
}
