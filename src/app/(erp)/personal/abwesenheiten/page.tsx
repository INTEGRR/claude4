import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, dateTime } from '@/modules/shared/format'
import { decideAbsence, requestAbsence } from '../actions'

export const dynamic = 'force-dynamic'

/**
 * Abwesenheiten mit Genehmigung. Offene Anträge stehen oben — sie sind das
 * Einzige, was hier eine Handlung verlangt.
 */

const ABSENCE_LABEL: Record<string, string> = {
  vacation: 'Urlaub',
  sick: 'Krank',
  training: 'Schulung',
  unpaid: 'Unbezahlt',
  other: 'Sonstiges',
}

export default async function AbwesenheitenPage() {
  await requireArea('personal')

  const antraege = await sql<
    {
      id: string
      employee_id: string
      employee: string
      kind: string
      starts_on: string
      ends_on: string
      half_day: boolean
      state: string
      reason: string | null
      decision_note: string | null
      decided_at: string | null
      tage: number
      schichten: number
    }[]
  >`
    select a.id, a.employee_id, e.name as employee, a.kind::text,
           a.starts_on::text, a.ends_on::text, a.half_day, a.state::text,
           a.reason, a.decision_note, a.decided_at, absence_days(a.id) as tage,
           (select count(*)::int from shift_assignments s
             where s.employee_id = a.employee_id and s.state <> 'cancel'
               and s.starts_at < (a.ends_on + 1)::timestamptz
               and s.ends_at > a.starts_on::timestamptz) as schichten
    from absences a
    join employees e on e.id = a.employee_id
    order by (a.state = 'requested') desc, a.starts_on desc
    limit 100`

  const mitarbeiter = await sql<{ id: string; name: string }[]>`
    select id, name from employees where active order by name`

  const offen = antraege.filter((a) => a.state === 'requested')
  const heute = antraege.filter(
    (a) =>
      a.state === 'approved' &&
      a.starts_on <= new Date().toISOString().slice(0, 10) &&
      a.ends_on >= new Date().toISOString().slice(0, 10),
  )
  const urlaubstage = antraege
    .filter((a) => a.state === 'approved' && a.kind === 'vacation')
    .reduce((s, a) => s + Number(a.tage), 0)

  return (
    <>
      <PageHeader
        title="Abwesenheiten"
        subtitle="Urlaub, Krankheit und Schulung — offene Anträge zuerst"
        actions={<Link className="btn" href="/personal">Zum Personal</Link>}
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Offene Anträge"
          value={String(offen.length)}
          hint={offen.length === 0 ? 'nichts zu entscheiden' : 'warten auf Entscheidung'}
        />
        <Stat label="Heute abwesend" value={String(heute.length)} hint="genehmigt und laufend" />
        <Stat label="Genehmigte Urlaubstage" value={String(urlaubstage)} hint="im gezeigten Zeitraum" />
      </div>

      {offen.some((a) => a.schichten > 0) && (
        <div className="notice warn">
          Bei mindestens einem offenen Antrag sind im Zeitraum bereits Schichten geplant. Die
          Genehmigung ist trotzdem möglich — der Plan muss danach aber angepasst werden, sonst
          steht jemand im Plan, der nicht da ist.
        </div>
      )}

      <Card title={`Anträge (${antraege.length})`} tight>
        {antraege.length === 0 ? (
          <Empty>Noch keine Abwesenheit erfasst.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th>Art</th>
                  <th>Von</th>
                  <th>Bis</th>
                  <th className="num">Tage</th>
                  <th>Status</th>
                  <th>Grund</th>
                  <th className="num">Entscheidung</th>
                </tr>
              </thead>
              <tbody>
                {antraege.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link href={`/personal/${a.employee_id}`}>{a.employee}</Link>
                    </td>
                    <td>{ABSENCE_LABEL[a.kind] ?? a.kind}</td>
                    <td className="mono small nowrap">{date(a.starts_on)}</td>
                    <td className="mono small nowrap">
                      {a.half_day ? 'halber Tag' : date(a.ends_on)}
                    </td>
                    <td className="num mono">{Number(a.tage)}</td>
                    <td className="nowrap">
                      <Badge state={a.state} kind="absence" />
                      {a.state === 'requested' && a.schichten > 0 && (
                        <div className="small muted nowrap">
                          <span className="led warn" /> {a.schichten} Schicht(en) geplant
                        </div>
                      )}
                      {a.decided_at && (
                        <div className="small muted nowrap">{dateTime(a.decided_at)}</div>
                      )}
                    </td>
                    <td className="small muted">
                      {a.reason ?? '—'}
                      {a.decision_note && <div>„{a.decision_note}"</div>}
                    </td>
                    <td className="num">
                      {a.state === 'requested' ? (
                        <span className="actions" style={{ justifyContent: 'flex-end' }}>
                          <ActionButton
                            className="small primary"
                            action={decideAbsence.bind(null, a.id, 'approved')}
                          >
                            Genehmigen
                          </ActionButton>
                          <ActionButton
                            className="small danger"
                            action={decideAbsence.bind(null, a.id, 'rejected')}
                          >
                            Ablehnen
                          </ActionButton>
                        </span>
                      ) : a.state === 'approved' ? (
                        <ActionButton
                          className="small"
                          action={decideAbsence.bind(null, a.id, 'cancel')}
                          confirm="Genehmigung zurückziehen?"
                        >
                          Zurückziehen
                        </ActionButton>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Abwesenheit erfassen">
        <ActionForm action={requestAbsence}>
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
              <button className="primary" type="submit">Beantragen</button>
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  )
}
