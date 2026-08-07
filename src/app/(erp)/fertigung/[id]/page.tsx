import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { ResponsibleForm } from '@/components/responsible-form'
import { RecordComments } from '@/components/record-comments'
import { LABELS, date, dateTime, money, qty } from '@/modules/shared/format'
import {
  cancelMo,
  checkAvailability,
  confirmMo,
  finishOperation,
  produceMo,
  startMo,
  startOperation,
  updateMoDetails,
} from '../actions'

export const dynamic = 'force-dynamic'

export default async function MoPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('fertigung')
  const { id } = await params

  const [mo] = await sql<
    {
      id: string
      number: string
      product: string
      variant_id: string
      qty_to_produce: number
      qty_produced: number
      state: string
      scheduled_date: string
      date_done: string | null
      sales_order_id: string | null
      sales_order_number: string | null
      backorder_of_number: string | null
      uom: string
      consumption: string
      user_id: string | null
      priority: string
      origin: string | null
      tracking: string
      material_cost: number
      labor_cost: number
      unit_cost: number | null
    }[]
  >`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as product, mo.variant_id,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date, mo.date_done,
           mo.user_id, mo.priority, mo.origin,
           mo.material_cost, mo.labor_cost, mo.unit_cost,
           product_tracking(mo.variant_id) as tracking,
           mo.sales_order_id, so.number as sales_order_number,
           bo.number as backorder_of_number, u.name as uom, b.consumption
    from manufacturing_orders mo
    left join sales_orders so on so.id = mo.sales_order_id
    left join manufacturing_orders bo on bo.id = mo.backorder_of_id
    left join uoms u on u.id = mo.uom_id
    left join boms b on b.id = mo.bom_id
    where mo.id = ${id}`

  if (!mo) notFound()

  const components = await sql<
    {
      id: string
      product: string
      qty: number
      qty_done: number
      reserved_qty: number
      uom: string
      state: string
      available: number
      issue_method: string | null
      phantom_path: string | null
    }[]
  >`
    select m.id, variant_display_name(m.variant_id) as product, m.qty, m.qty_done,
           m.reserved_qty, u.name as uom, m.state,
           free_to_use(m.variant_id) + m.reserved_qty as available,
           m.issue_method, m.phantom_path
    from stock_moves m
    join uoms u on u.id = m.uom_id
    where m.production_id = ${id} and m.reference = 'Komponentenverbrauch'
    order by m.created_at`

  const operations = await sql<
    {
      id: string
      sequence: number
      name: string
      work_center: string
      code: string
      cost_per_hour: number
      duration_expected: number
      duration_real: number
      state: string
      date_start: string | null
      date_done: string | null
      worker: string | null
      labor_cost: number
      booked_minutes: number
    }[]
  >`
    select o.id, o.sequence, o.name, w.name as work_center, w.code, o.cost_per_hour,
           o.duration_expected, o.duration_real, o.state::text, o.date_start, o.date_done,
           us.name as worker,
           mo_operation_cost(o.id) as labor_cost,
           coalesce((select sum(t.minutes) from time_entries t
                     where t.mo_operation_id = o.id and t.ended_at is not null), 0) as booked_minutes
    from mo_operations o
    join work_centers w on w.id = o.work_center_id
    left join users us on us.id = o.user_id
    where o.mo_id = ${id}
    order by o.sequence, o.id`

  // Wer kann Zeit buchen, und läuft schon eine Uhr am Arbeitsgang?
  const mitarbeiter = await sql<{ id: string; name: string }[]>`
    select e.id, e.name from employees e
    where e.active
      and not exists (select 1 from time_entries t
                      where t.employee_id = e.id and t.kind = 'production' and t.ended_at is null)
    order by e.name`

  const laufend = await sql<{ mo_operation_id: string; name: string; started_at: string }[]>`
    select t.mo_operation_id, e.name, t.started_at
    from time_entries t
    join employees e on e.id = t.employee_id
    join mo_operations o on o.id = t.mo_operation_id
    where o.mo_id = ${id} and t.ended_at is null`


  const open = mo.state !== 'done' && mo.state !== 'cancel'
  const remaining = Number(mo.qty_to_produce) - Number(mo.qty_produced)
  // Statusleuchte der Werkstattanzeige: erledigt = grün, storniert = aus,
  // laufend = Akzent (der einzige Punkt der Seite, der glüht).
  const moLed = mo.state === 'done' ? 'ok' : mo.state === 'cancel' ? 'off' : 'on'

  return (
    <>
      <PageHeader
        title={<span className="mono">{mo.number}</span>}
        subtitle={
          <>
            {mo.product} · {qty(mo.qty_to_produce)} {mo.uom} · Termin{' '}
            <span className="mono">{date(mo.scheduled_date)}</span>
            {mo.sales_order_id && (
              <>
                {' '}· Auftrag{' '}
                <Link className="mono" href={`/verkauf/${mo.sales_order_id}`}>{mo.sales_order_number}</Link>
              </>
            )}
            {mo.backorder_of_number && (
              <> · Rückstand zu <span className="mono">{mo.backorder_of_number}</span></>
            )}
          </>
        }
        actions={
          <>
            <Badge state={mo.state} kind="mo" />
            <Link className="btn" href={`/fertigung/${id}/druck`} target="_blank">
              Drucken
            </Link>
            {mo.state === 'draft' && (
              <ActionButton className="primary" action={confirmMo.bind(null, id)}>Bestätigen</ActionButton>
            )}
            {open && mo.state !== 'draft' && (
              <ActionButton action={checkAvailability.bind(null, id)}>Verfügbarkeit prüfen</ActionButton>
            )}
            {mo.state === 'confirmed' && (
              <ActionButton action={startMo.bind(null, id)}>Fertigung starten</ActionButton>
            )}
            {open && (
              <ActionButton
                className="danger"
                action={cancelMo.bind(null, id)}
                confirm="Fertigungsauftrag stornieren? Reservierungen werden freigegeben."
              >
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />
      <div style={{ marginBottom: 12 }}>
        <ResponsibleForm action={updateMoDetails.bind(null, id)} userId={mo.user_id} priority={mo.priority} />
      </div>

      {/* Werkstattanzeige: die drei Zahlen des Auftrags auf einen Blick. */}
      <div className="display-panel" style={{ marginBottom: 16 }}>
        <div className="display-head">
          <span>{mo.number}</span>
          <span>
            <span className={`led ${moLed}`} /> {LABELS.mo[mo.state as keyof typeof LABELS.mo] ?? mo.state}
          </span>
        </div>
        <div className="grid-3" style={{ gap: 12, padding: '0 6px 2px' }}>
          <div>
            <div className="mono-label">Soll</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--display-bright)' }}>
              {qty(mo.qty_to_produce)} <span style={{ fontSize: 12, fontWeight: 400 }}>{mo.uom}</span>
            </div>
          </div>
          <div>
            <div className="mono-label">Ist</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: 'var(--display-bright)' }}>
              {qty(mo.qty_produced)} <span style={{ fontSize: 12, fontWeight: 400 }}>{mo.uom}</span>
            </div>
            {mo.state === 'done' && (
              <div className="mono" style={{ fontSize: 11 }}>fertig gemeldet {date(mo.date_done)}</div>
            )}
          </div>
          <div>
            <div className="mono-label">Rest</div>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: open && remaining > 0 ? 'var(--accent)' : 'var(--display-bright)',
              }}
            >
              {open ? (
                <>
                  {qty(remaining)} <span style={{ fontSize: 12, fontWeight: 400 }}>{mo.uom}</span>
                </>
              ) : (
                '—'
              )}
            </div>
          </div>
        </div>
      </div>

      <Card
        title="Komponenten"
        actions={
          <>
            <span className="mono-label">Verbrauchsregel</span>
            <span className="small">
              {mo.consumption === 'blocked'
                ? 'Abweichung gesperrt'
                : mo.consumption === 'allowed'
                  ? 'Abweichung erlaubt'
                  : 'Abweichung mit Warnung'}
            </span>
          </>
        }
        tight
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Komponente</th>
                <th>Aus Baugruppe</th>
                <th className="num">Bedarf</th>
                <th>Einheit</th>
                <th>Verbrauch</th>
                <th className="num">Reserviert</th>
                <th className="num">Verfügbar</th>
                <th className="num">Verbraucht</th>
              </tr>
            </thead>
            <tbody>
              {components.map((c) => {
                const short = Number(c.reserved_qty) < Number(c.qty) && c.state !== 'done'
                return (
                  <tr key={c.id}>
                    <td>{c.product}</td>
                    <td className="small muted">{c.phantom_path ?? '—'}</td>
                    <td className="num">{qty(c.qty)}</td>
                    <td>{c.uom}</td>
                    <td className="small muted nowrap">
                      {c.issue_method === 'manual' ? 'manuell erfassen' : 'automatisch'}
                    </td>
                    {/* Zustand als LED plus Wort — die Zahl bleibt rechtsbündig
                        ausgerichtet und trägt keine Farbe. */}
                    <td className="num">
                      <span className={`led ${short ? 'warn' : 'ok'}`} />{' '}
                      <span className="muted small">{short ? 'fehlt' : 'gedeckt'}</span>{' '}
                      {qty(c.reserved_qty)}
                    </td>
                    <td className="num muted">{qty(c.available)}</td>
                    <td className="num">{c.state === 'done' ? qty(c.qty_done) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card
        title="Arbeitsgänge"
        actions={
          operations.length > 0 ? (
            <span className="mono-label">
              {qty(operations.reduce((sum, o) => sum + Number(o.duration_real), 0))} von{' '}
              {qty(operations.reduce((sum, o) => sum + Number(o.duration_expected), 0))} Min. erfasst
            </span>
          ) : null
        }
        tight
      >
        {operations.length === 0 ? (
          <Empty>
            Keine Arbeitsgänge hinterlegt — der Auftrag trägt nur Materialkosten. Arbeitsgänge werden
            an der <Link href="/fertigung/stuecklisten">Stückliste</Link> gepflegt.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Arbeitsgang</th>
                  <th>Arbeitsplatz</th>
                  <th className="num">Vorgabe</th>
                  <th className="num">Erfasst</th>
                  <th className="num">Lohnkosten</th>
                  <th>Zustand</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {operations.map((o) => {
                  const led =
                    o.state === 'done' ? 'ok' : o.state === 'progress' ? 'on' : o.state === 'cancel' ? 'off' : 'off'
                  const label =
                    o.state === 'done'
                      ? 'erledigt'
                      : o.state === 'progress'
                        ? 'läuft'
                        : o.state === 'cancel'
                          ? 'storniert'
                          : 'offen'
                  return (
                    <tr key={o.id}>
                      <td className="mono small">{o.sequence}</td>
                      <td>
                        {o.name}
                        {o.worker && <div className="small muted">{o.worker}</div>}
                      </td>
                      <td>
                        <span className="mono small">{o.code}</span> {o.work_center}
                        <div className="small muted">{money(o.cost_per_hour)} / Std.</div>
                      </td>
                      <td className="num mono muted">{qty(o.duration_expected)} Min.</td>
                      <td className="num mono">
                        {Number(o.duration_real) > 0 ? `${qty(o.duration_real)} Min.` : '—'}
                        {laufend
                          .filter((l) => l.mo_operation_id === o.id)
                          .map((l) => (
                            <div key={l.name} className="small muted nowrap">
                              <span className="led on" /> {l.name} seit {dateTime(l.started_at)}
                            </div>
                          ))}
                        {o.date_start && o.state === 'progress' && laufend.every((l) => l.mo_operation_id !== o.id) && (
                          <div className="small muted nowrap">seit {dateTime(o.date_start)}</div>
                        )}
                      </td>
                      <td className="num mono">
                        {money(o.labor_cost)}
                        {Number(o.booked_minutes) > 0 && (
                          <div className="small muted nowrap">
                            {qty(o.booked_minutes)} Min. zum Personalsatz
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        <span className={`led ${led}`} /> <span className="small muted">{label}</span>
                      </td>
                      <td className="num">
                        {open && o.state !== 'done' && o.state !== 'cancel' && (
                          <span className="actions" style={{ justifyContent: 'flex-end' }}>
                            {o.state === 'pending' && (
                              <ActionForm action={startOperation.bind(null, id, o.id)}>
                                <span className="actions">
                                  {mitarbeiter.length > 0 && (
                                    <select
                                      name="employee_id"
                                      defaultValue=""
                                      style={{ width: 150 }}
                                      title="Mit Mitarbeiter läuft die Zeiterfassung mit — dann zählt der Personalkostensatz"
                                    >
                                      <option value="">ohne Zeiterfassung</option>
                                      {mitarbeiter.map((m) => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                      ))}
                                    </select>
                                  )}
                                  <button className="small" type="submit">Starten</button>
                                </span>
                              </ActionForm>
                            )}
                            <ActionForm action={finishOperation.bind(null, id, o.id)}>
                              <span className="actions">
                                <input
                                  className="mono"
                                  type="number"
                                  name="minutes"
                                  step="0.01"
                                  min="0"
                                  style={{ width: 90 }}
                                  placeholder={
                                    o.state === 'progress' ? 'Uhr' : String(Number(o.duration_expected))
                                  }
                                  title="Dauer in Minuten — leer lassen: bei laufendem Arbeitsgang zählt die Uhr, sonst die Vorgabezeit"
                                />
                                <button className="small" type="submit">Fertig</button>
                              </span>
                            </ActionForm>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {mo.state === 'done' && Number(mo.unit_cost ?? 0) > 0 && (
        <Card title="Herstellkosten" tight>
          <div className="grid-3" style={{ padding: 12 }}>
            <Stat label="Material" value={money(mo.material_cost)} hint="Wert der verbrauchten Komponenten" />
            <Stat label="Lohn" value={money(mo.labor_cost)} hint="aus den erfassten Arbeitsgangzeiten" />
            <Stat
              label="Je Stück"
              value={money(mo.unit_cost ?? 0)}
              hint={`${qty(mo.qty_produced)} ${mo.uom} · ${money(Number(mo.material_cost) + Number(mo.labor_cost))} gesamt`}
            />
          </div>
          <p className="muted small" style={{ padding: '0 12px 12px', margin: 0 }}>
            Mit diesem Wert ist das Fertigprodukt eingebucht — er geht in den gleitenden
            Durchschnittspreis der Variante ein, nicht der gepflegte Standardpreis.
          </p>
        </Card>
      )}

      {open && (
        <Card title="Fertig melden">
          <ActionForm action={produceMo.bind(null, id)}>
            <div className="row" style={{ marginBottom: 12 }}>
              <label className="field">
                <span>Produzierte Menge</span>
                <input
                  type="number"
                  name="qty"
                  step="0.001"
                  min="0.001"
                  max={remaining}
                  defaultValue={remaining}
                  required
                />
              </label>
              {mo.tracking !== 'none' && (
                <label className="field" style={{ maxWidth: 260 }}>
                  <span>{mo.tracking === 'serial' ? 'Seriennummer (leer = automatisch)' : 'Losnummer (leer = automatisch)'}</span>
                  <input
                    className="mono"
                    name="lot"
                    placeholder={mo.tracking === 'serial' ? 'nur bei Menge 1' : 'z. B. CHARGE-2026-01'}
                  />
                </label>
              )}
              <label className="field">
                <span>Bei Teilmenge</span>
                <select name="backorder" defaultValue="yes">
                  <option value="yes">Rückstand für die Restmenge anlegen</option>
                  <option value="no">Restmenge verwerfen</option>
                </select>
              </label>
            </div>

            {components.some((c) => c.issue_method === 'manual' && c.state !== 'done' && c.state !== 'cancel') && (
              <div className="notice warn">
                Positionen mit Verbrauchsart <strong>manuell</strong> müssen unten erfasst werden —
                ohne Eingabe verweigert die Fertigmeldung den Dienst.
              </div>
            )}

            <details open={components.some((c) => c.issue_method === 'manual' && c.state !== 'done' && c.state !== 'cancel')}>
              <summary className="muted small" style={{ cursor: 'pointer', marginBottom: 8 }}>
                Ist-Verbrauch anpassen (z. B. Ausschuss beim Einbau)
              </summary>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Komponente</th>
                      <th>Verbrauch</th>
                      <th className="num">Soll</th>
                      <th className="num" style={{ width: 160 }}>Ist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {components
                      .filter((c) => c.state !== 'done' && c.state !== 'cancel')
                      .map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.product}
                            {c.phantom_path && (
                              <div className="small muted">aus {c.phantom_path}</div>
                            )}
                          </td>
                          <td className="small">
                            {c.issue_method === 'manual' ? (
                              <>
                                <span className="led warn" /> <span className="muted">manuell</span>
                              </>
                            ) : (
                              <span className="muted">automatisch</span>
                            )}
                          </td>
                          <td className="num">{qty(c.qty)} {c.uom}</td>
                          <td>
                            <input
                              type="number"
                              name={`consumed_${c.id}`}
                              step="0.001"
                              min="0"
                              placeholder={String(c.qty)}
                              required={c.issue_method === 'manual'}
                            />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableWrap>
            </details>

            <div style={{ marginTop: 12 }}>
              <button className="primary" type="submit">Fertig melden</button>
            </div>
          </ActionForm>
        </Card>
      )}

      <RecordComments model="manufacturing_order" recordId={id} path={`/fertigung/${id}`} />
    </>
  )
}
