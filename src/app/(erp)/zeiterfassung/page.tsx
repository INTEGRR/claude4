import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { date, dateTime, hours, money } from '@/modules/shared/format'
import { clockByBarcode, clockToggle, stopEntry } from '../personal/actions'

export const dynamic = 'force-dynamic'

/**
 * Stempeluhr. Gedacht als Terminal neben der Werkstatttür: Ausweis scannen —
 * fertig. Der erste Scan meldet an, der zweite ab. Die Knöpfe daneben sind
 * für den Fall, dass der Ausweis mal wieder in der Jacke steckt.
 */
export default async function ZeiterfassungPage() {
  const user = await requireArea('zeiterfassung')
  const sieht = (bereich: Parameters<typeof canAccess>[1]) => canAccess(user.role, bereich)

  const anwesend = await sql<
    {
      employee_id: string
      number: string
      name: string
      department: string | null
      entry_id: string
      started_at: string
      minutes_so_far: number
    }[]
  >`select * from employees_present order by started_at`

  const mitarbeiter = await sql<
    { id: string; number: string; name: string; department: string | null; present: boolean }[]
  >`
    select e.id, e.number, e.name, e.department,
           exists (select 1 from employees_present p where p.employee_id = e.id) as present
    from employees e
    where e.active
    order by e.name`

  const heute = await sql<
    {
      id: string
      name: string
      kind: string
      started_at: string
      ended_at: string | null
      break_minutes: number
      minutes: number
      auftrag: string | null
      arbeitsgang: string | null
    }[]
  >`
    select t.id, e.name, t.kind::text, t.started_at, t.ended_at, t.break_minutes, t.minutes,
           mo.number as auftrag, o.name as arbeitsgang
    from time_entries t
    join employees e on e.id = t.employee_id
    left join mo_operations o on o.id = t.mo_operation_id
    left join manufacturing_orders mo on mo.id = o.mo_id
    where t.started_at >= date_trunc('day', now())
    order by t.started_at desc
    limit 60`

  const tagesminuten = heute
    .filter((h) => h.kind === 'attendance')
    .reduce((sum, h) => sum + Number(h.minutes), 0)
  const auftragsminuten = heute
    .filter((h) => h.kind === 'production')
    .reduce((sum, h) => sum + Number(h.minutes), 0)

  return (
    <>
      <PageHeader
        title="Zeiterfassung"
        subtitle="Ausweis scannen meldet an — der zweite Scan meldet ab"
        actions={
          sieht('personal') ? (
            <Link className="btn" href="/personal">Zum Personal</Link>
          ) : null
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat
          label="Gerade im Haus"
          value={String(anwesend.length)}
          hint={anwesend.length === 0 ? 'niemand angemeldet' : 'angemeldete Mitarbeiter'}
        />
        <Stat label="Anwesenheit heute" value={hours(tagesminuten)} hint="abgeschlossene Buchungen" />
        <Stat label="Auftragszeit heute" value={hours(auftragsminuten)} hint="auf Arbeitsgänge gebucht" />
      </div>

      {/* Das Terminal: ein Feld, ein Ziel. Autofokus, damit der Scanner
          direkt hineinschreiben kann. */}
      <Card title="Stempeluhr">
        <ActionForm action={clockByBarcode}>
          <div className="row">
            <label className="field" style={{ flex: 2, marginBottom: 0 }}>
              <span>Ausweis scannen</span>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                className="mono"
                name="barcode"
                placeholder="Ausweisnummer"
                autoFocus
                autoComplete="off"
              />
            </label>
            <div className="shrink">
              <button className="primary" type="submit">Kommen / Gehen</button>
            </div>
          </div>
        </ActionForm>
      </Card>

      <Card title={`Anwesend (${anwesend.length})`} tight>
        {anwesend.length === 0 ? (
          <Empty>Niemand angemeldet.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Mitarbeiter</th>
                  <th>Seit</th>
                  <th className="num">Bisher</th>
                  <th className="num" style={{ width: 320 }}>Abmelden</th>
                </tr>
              </thead>
              <tbody>
                {anwesend.map((a) => (
                  <tr key={a.entry_id}>
                    <td className="mono small">{a.number}</td>
                    <td>
                      <span className="led on" /> {a.name}
                      {a.department && <span className="muted small"> · {a.department}</span>}
                    </td>
                    <td className="mono small nowrap">{dateTime(a.started_at)}</td>
                    <td className="num mono">{hours(a.minutes_so_far)}</td>
                    <td className="num">
                      <ActionForm action={stopEntry.bind(null, a.entry_id)}>
                        <span className="actions" style={{ justifyContent: 'flex-end' }}>
                          <input
                            className="mono"
                            type="number"
                            name="break_minutes"
                            min="0"
                            step="1"
                            style={{ width: 110 }}
                            placeholder="Pause Min."
                            title="Pausenzeit in Minuten — wird von der Anwesenheit abgezogen"
                          />
                          <button type="submit">Gehen</button>
                        </span>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Ohne Ausweis" tight>
        {mitarbeiter.length === 0 ? (
          <Empty>
            Noch kein Mitarbeiter angelegt.
            {sieht('personal') && (
              <>
                {' '}
                <Link href="/personal">Jetzt anlegen</Link>.
              </>
            )}
          </Empty>
        ) : (
          <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
            {/* Neutrale Knöpfe: die Leuchte trägt den Zustand, nicht die Farbe.
                Orange bliebe sonst auf jedem Knopf und sagte nichts mehr. */}
            {mitarbeiter.map((m) => (
              <ActionButton
                key={m.id}
                action={clockToggle.bind(null, m.id)}
                title={m.present ? `${m.name} abmelden` : `${m.name} anmelden`}
              >
                <span className={`led ${m.present ? 'on' : 'off'}`} /> {m.name}{' '}
                <span className="muted small">{m.present ? '· gehen' : '· kommen'}</span>
              </ActionButton>
            ))}
          </div>
        )}
      </Card>

      <Card title="Buchungen heute" actions={<span className="mono-label">{date(new Date())}</span>} tight>
        {heute.length === 0 ? (
          <Empty>Heute noch keine Buchung.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th>Art</th>
                  <th>Von</th>
                  <th>Bis</th>
                  <th className="num">Pause</th>
                  <th className="num">Netto</th>
                  <th>Auftrag</th>
                </tr>
              </thead>
              <tbody>
                {heute.map((h) => (
                  <tr key={h.id}>
                    <td>{h.name}</td>
                    <td className="small muted">
                      {h.kind === 'attendance' ? 'Anwesenheit' : 'Auftragszeit'}
                    </td>
                    <td className="mono small nowrap">{dateTime(h.started_at)}</td>
                    <td className="mono small nowrap">
                      {h.ended_at ? (
                        dateTime(h.ended_at)
                      ) : (
                        <>
                          <span className="led on" /> läuft
                        </>
                      )}
                    </td>
                    <td className="num mono">
                      {Number(h.break_minutes) > 0 ? `${Number(h.break_minutes)} Min.` : '—'}
                    </td>
                    <td className="num mono">{h.ended_at ? hours(h.minutes) : '—'}</td>
                    <td className="small muted">
                      {h.auftrag ? `${h.auftrag} · ${h.arbeitsgang}` : '—'}
                    </td>
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
