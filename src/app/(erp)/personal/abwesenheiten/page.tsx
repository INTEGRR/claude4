import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, dateTime, isoDatum, label, LABELS, plural } from '@/modules/shared/format'
import { decideAbsence, requestAbsence } from '../actions'
import { Auswahl } from '@/components/auswahl'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { Seiten } from '@/components/seiten'

export const dynamic = 'force-dynamic'

/**
 * Abwesenheiten mit Genehmigung. Offene Anträge stehen oben — sie sind das
 * Einzige, was hier eine Handlung verlangt.
 */

export default async function AbwesenheitenPage({
  searchParams,
}: {
  searchParams: Promise<{ seite?: string; pro?: string }>
}) {
  await requireArea('personal')
  const params = await searchParams
  // Seitenaufteilung (F3, 2026-10-18: 10/25/100 wählbar).
  const seite = seitenParameter(params)

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
      gesamt: number
    }[]
  >`
    select count(*) over ()::int as gesamt, a.id, a.employee_id, e.name as employee, a.kind::text,
           a.starts_on::text, a.ends_on::text, a.half_day, a.state::text,
           a.reason, a.decision_note, a.decided_at, absence_days(a.id) as tage,
           (select count(*)::int from shift_assignments s
             where s.employee_id = a.employee_id and s.state <> 'cancel'
               and s.starts_at < (a.ends_on + 1)::timestamptz
               and s.ends_at > a.starts_on::timestamptz) as schichten
    from absences a
    join employees e on e.id = a.employee_id
    order by (a.state = 'requested') desc, a.starts_on desc
    limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(antraege)

  // Kennzahlen über alle Anträge, nicht nur die gezeigte Seite.
  const heuteIso = isoDatum(new Date())
  const [kennzahlen] = await sql<
    { offen: number; heute: number; urlaubstage: number; kollision: boolean }[]
  >`
    select count(*) filter (where a.state = 'requested')::int as offen,
           count(*) filter (where a.state = 'approved'
                              and a.starts_on <= ${heuteIso}::date
                              and a.ends_on >= ${heuteIso}::date)::int as heute,
           coalesce(sum(absence_days(a.id)) filter (where a.state = 'approved' and a.kind = 'vacation'), 0)::float8 as urlaubstage,
           coalesce(bool_or(a.state = 'requested' and exists (
             select 1 from shift_assignments s
              where s.employee_id = a.employee_id and s.state <> 'cancel'
                and s.starts_at < (a.ends_on + 1)::timestamptz
                and s.ends_at > a.starts_on::timestamptz)), false) as kollision
    from absences a`

  const mitarbeiter = await sql<{ id: string; name: string }[]>`
    select id, name from employees where active order by name`

  const offen = Number(kennzahlen?.offen ?? 0)
  const heute = Number(kennzahlen?.heute ?? 0)
  const urlaubstage = Number(kennzahlen?.urlaubstage ?? 0)

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
          value={String(offen)}
          hint={offen === 0 ? 'nichts zu entscheiden' : 'warten auf Entscheidung'}
        />
        <Stat label="Heute abwesend" value={String(heute)} hint="genehmigt und laufend" />
        <Stat label="Genehmigte Urlaubstage" value={String(urlaubstage)} hint="alle erfassten Anträge" />
      </div>

      {kennzahlen?.kollision && (
        <div className="notice warn">
          Bei mindestens einem offenen Antrag sind im Zeitraum bereits Schichten geplant. Die
          Genehmigung ist trotzdem möglich — der Plan muss danach aber angepasst werden, sonst
          steht jemand im Plan, der nicht da ist.
        </div>
      )}

      <Card title={`Anträge (${gesamt})`} tight>
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
                    <td>{label('absence_art', a.kind)}</td>
                    <td className="mono small nowrap">{date(a.starts_on)}</td>
                    <td className="mono small nowrap">
                      {a.half_day ? 'halber Tag' : date(a.ends_on)}
                    </td>
                    <td className="num mono">{Number(a.tage)}</td>
                    <td className="nowrap">
                      <Badge state={a.state} kind="absence" href={`/personal/${a.employee_id}`} />
                      {a.state === 'requested' && a.schichten > 0 && (
                        <div className="small muted nowrap">
                          {/* Kollision → die Woche im Schichtplan, in der sie liegt. */}
                          <span className="led warn" />{' '}
                          <Link className="muted" href={`/personal/schichtplan?woche=${a.starts_on}`}>
                            {plural(a.schichten, 'Schicht', 'Schichten')} geplant
                          </Link>
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
        <Seiten pfad="/personal/abwesenheiten" params={params} seite={seite} gesamt={gesamt} />
      </Card>

      <Card title="Abwesenheit erfassen">
        <ActionForm action={requestAbsence}>
          <div className="row">
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Mitarbeiter</span>
              <Auswahl name="employee_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {mitarbeiter.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </Auswahl>
            </label>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Art</span>
              <Auswahl name="kind" defaultValue="vacation">
                {Object.entries(LABELS.absence_art).map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </Auswahl>
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
