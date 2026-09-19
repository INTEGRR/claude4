import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { ResponsibleForm } from '@/components/responsible-form'
import { TagEditor } from '@/components/tag-editor'
import { RecordComments } from '@/components/record-comments'
import { ProzessPanel } from '@/components/prozess-panel'
import { date, dateTime, qty } from '@/modules/shared/format'
import {
  addPart,
  cancelRepair,
  confirmRepair,
  createQuotation,
  endRepair,
  removePart,
  startRepair,
  updateRepairDetails,
} from '../actions'

export const dynamic = 'force-dynamic'

const PART_TYPES = {
  add: { label: 'Einbauen', hint: 'wird aus dem Lager verbraucht' },
  remove: { label: 'Ausbauen', hint: 'wird entsorgt (Ausschuss)' },
  recycle: { label: 'Wiederverwenden', hint: 'geht zurück ins Lager' },
} as const

export default async function RepairPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ schritt?: string }>
}) {
  const user = await requireArea('reparatur')
  const { id } = await params
  // Vom Scan-Resolver gesetzt (Wareneingang): das Formular dieses Schritts
  // steht sofort offen — Sendungsnummer scannen, Enter, fertig.
  const { schritt: sofortOffen } = await searchParams

  const [repair] = await sql<
    {
      id: string
      number: string
      customer: string
      partner_id: string
      product: string
      qty: number
      under_warranty: boolean
      state: string
      scheduled_date: string
      note: string | null
      sales_order_id: string | null
      sales_order_number: string | null
      user_id: string | null
      priority: string
      origin_model: string | null
      origin_id: string | null
      origin_label: string | null
      received_at: string | null
      customer_email: string | null
    }[]
  >`
    select r.id, r.number, p.name as customer, r.partner_id,
           variant_display_name(r.variant_id) as product, r.qty, r.under_warranty, r.state,
           r.scheduled_date, r.note, r.sales_order_id, so.number as sales_order_number,
           r.user_id, r.priority,
           r.origin_model, r.origin_id, r.origin_label, r.received_at, p.email as customer_email
    from repair_orders r
    join partners p on p.id = r.partner_id
    left join sales_orders so on so.id = r.sales_order_id
    where r.id = ${id}`

  if (!repair) notFound()

  // Versand rund um die Reparatur: das Retourenlabel (Kunde → Werkstatt) und
  // die Rücksendung (Werkstatt → Kunde, eine Sendung ohne Lieferung, 0081).
  const [retoure] = await sql<
    { shipment_number: string | null; qr_link: string | null; emailed_at: string | null; created_at: string }[]
  >`
    select shipment_number, qr_link, emailed_at, created_at from return_labels
    where repair_order_id = ${id} order by created_at desc limit 1`
  const [sendung] = await sql<
    {
      id: string
      shipment_number: string | null
      state: string
      tracking_url: string | null
      dhl_product: string
      hat_label: boolean
      last_event: { description?: string } | null
      created_at: string
    }[]
  >`
    select id, shipment_number, state, tracking_url, dhl_product,
           (label_pdf is not null or label_path is not null) as hat_label,
           last_tracking_event as last_event, created_at
    from shipments where repair_order_id = ${id} and state <> 'cancelled'
    order by created_at desc limit 1`

  const parts = await sql<
    {
      id: string
      part_type: 'add' | 'remove' | 'recycle'
      product: string
      qty: number
      qty_done: number
      uom: string
      available: number
      move_state: string | null
    }[]
  >`
    select rp.id, rp.part_type, variant_display_name(rp.variant_id) as product,
           rp.qty, rp.qty_done, u.name as uom,
           free_to_use(rp.variant_id) as available, m.state as move_state
    from repair_parts rp
    join uoms u on u.id = rp.uom_id
    left join stock_moves m on m.id = rp.move_id
    where rp.repair_id = ${id} order by rp.sequence`


  const products = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active order by label limit 500`

  const editable = ['new', 'awaiting_device', 'received'].includes(repair.state)
  // Teile lassen sich auch während der Reparatur nachtragen — erst am
  // offenen Gerät zeigt sich der Bedarf (repair_add_part bucht sofort nach).
  const teileErfassbar = ['new', 'awaiting_device', 'received', 'confirmed', 'under_repair'].includes(
    repair.state,
  )
  const open = !['repaired', 'shipped', 'cancel'].includes(repair.state)

  return (
    <>
      <PageHeader
        title={<span className="mono">{repair.number}</span>}
        subtitle={
          <>
            {repair.customer} · {repair.product} ({qty(repair.qty)}) ·{' '}
            <span className="mono">{date(repair.scheduled_date)}</span>
            {repair.origin_model === 'vorgang' && repair.origin_id && (
              <>
                {' '}· aus Anfrage{' '}
                <Link className="mono" href={`/vorgaenge/${repair.origin_id}`}>{repair.origin_label}</Link>
              </>
            )}
            {repair.received_at && (
              <>
                {' '}· Gerät eingegangen <span className="mono">{dateTime(repair.received_at)}</span>
              </>
            )}
            {repair.sales_order_id && (
              <>
                {' '}· Angebot{' '}
                <Link className="mono" href={`/verkauf/${repair.sales_order_id}`}>{repair.sales_order_number}</Link>
              </>
            )}
          </>
        }
        actions={
          <>
            <Badge state={repair.state} kind="repair" />
            {/* Abrechnung immer zeigen — vorher war „kostenpflichtig“ unsichtbar. */}
            <span className="nowrap">
              <span className={`led ${repair.under_warranty ? 'ok' : 'off'}`} />{' '}
              {repair.under_warranty ? 'Garantie' : 'kostenpflichtig'}
            </span>
            {(repair.state === 'new' || repair.state === 'received') && (
              <ActionButton className="primary" action={confirmRepair.bind(null, id)}>
                Bestätigen
              </ActionButton>
            )}
            {repair.state === 'confirmed' && (
              <ActionButton action={startRepair.bind(null, id)}>Reparatur starten</ActionButton>
            )}
            {repair.state === 'repaired' && !repair.under_warranty && !repair.sales_order_id && (
              <ActionButton action={createQuotation.bind(null, id)}>Angebot erstellen</ActionButton>
            )}
            {open && (
              <ActionButton
                className="danger"
                action={cancelRepair.bind(null, id)}
                confirm="Reparatur stornieren? Reservierte Teile werden freigegeben."
              >
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />

      <div style={{ marginBottom: 12, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <ResponsibleForm action={updateRepairDetails.bind(null, id)} userId={repair.user_id} priority={repair.priority} />
        <TagEditor model="repair_order" recordId={id} path={`/reparatur/${id}`} />
      </div>

      <ProzessPanel
        prozessCode="reparatur"
        recordId={id}
        rolle={user.role}
        befugnisse={user.befugnisse}
        sofortOffen={sofortOffen}
      />

      {(retoure || sendung || repair.state === 'awaiting_device') && (
        <Card title="Versand">
          <div className="grid-2">
            <div>
              <span className="mono-label">Retourenlabel (Kunde → Werkstatt)</span>
              <div style={{ marginTop: 4 }}>
                {retoure ? (
                  <>
                    <span className="mono">{retoure.shipment_number}</span>
                    <div className="small muted">
                      {retoure.emailed_at
                        ? `gemailt ${dateTime(retoure.emailed_at)}`
                        : 'Mail in der Warteschlange'}
                      {repair.customer_email ? ` an ${repair.customer_email}` : ' — der Kunde hat keine E-Mail'}
                      {retoure.qr_link && (
                        <>
                          {' '}·{' '}
                          <a href={retoure.qr_link} target="_blank" rel="noreferrer">QR-Code</a>
                        </>
                      )}
                    </div>
                    <div className="small muted">
                      Referenz für den Wareneingang: <span className="mono">{repair.number}</span> —
                      Sendungsnummer oder RMA scannen.
                    </div>
                  </>
                ) : (
                  <span className="muted small">Noch kein Retourenlabel.</span>
                )}
              </div>
            </div>
            <div>
              <span className="mono-label">Rücksendung (Werkstatt → Kunde)</span>
              <div style={{ marginTop: 4 }}>
                {sendung ? (
                  <>
                    <span className="mono">{sendung.shipment_number}</span>{' '}
                    <Badge state={sendung.state} kind="shipment" />
                    <div className="small muted">
                      {sendung.dhl_product} · erstellt {dateTime(sendung.created_at)}
                      {sendung.last_event?.description ? ` · ${sendung.last_event.description}` : ''}
                    </div>
                    <div className="small" style={{ marginTop: 4 }}>
                      {sendung.tracking_url && (
                        <a href={sendung.tracking_url} target="_blank" rel="noreferrer">Sendungsverfolgung</a>
                      )}
                      {sendung.hat_label && (
                        <>
                          {sendung.tracking_url ? ' · ' : ''}
                          <a href={`/api/label/${sendung.id}`} target="_blank" rel="noreferrer">Label herunterladen</a>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="muted small">
                    {repair.state === 'shipped'
                      ? 'Ohne DHL-Label zurückgegeben (Abholung/Eigenversand).'
                      : 'Noch nicht versendet — nach dem Abschluss über „Rückgabe an den Kunden".'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Der Rohtext des Kunden — am Arbeitsplatz gelesen, darum als Geräteanzeige. */}
      {repair.note && (
        <div className="display-panel" style={{ marginBottom: 16 }}>
          <div className="display-head">
            <span>Fehlerbild</span>
            <span>{repair.number}</span>
          </div>
          <div style={{ padding: '0 6px 2px', color: 'var(--display-bright)', whiteSpace: 'pre-wrap' }}>
            {repair.note}
          </div>
        </div>
      )}

      <Card title="Teile" tight>
        {parts.length === 0 ? (
          <Empty>Noch keine Teile erfasst.</Empty>
        ) : repair.state === 'confirmed' || repair.state === 'under_repair' ? (
          <ActionForm action={endRepair.bind(null, id)}>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Art</th>
                    <th>Teil</th>
                    <th className="num">Geplant</th>
                    <th className="num">Verfügbar</th>
                    <th className="num" style={{ width: 140 }}>Tatsächlich</th>
                    <th>Einheit</th>
                  </tr>
                </thead>
                <tbody>
                  {parts.map((p) => {
                    const covered = Number(p.available) >= Number(p.qty)
                    return (
                      <tr key={p.id}>
                        {/* Die Art ist eine Einteilung, kein Zustand: neutral. */}
                        <td>
                          <span className="badge neutral">{PART_TYPES[p.part_type].label}</span>
                        </td>
                        <td>{p.product}</td>
                        <td className="num">{qty(p.qty)}</td>
                        {/* Deckt der Bestand den geplanten Bedarf? Das war bisher nicht ablesbar. */}
                        <td className="num">
                          {p.part_type === 'add' ? (
                            <>
                              <span className={`led ${covered ? 'ok' : 'warn'}`} />{' '}
                              <span className="muted small">{covered ? 'gedeckt' : 'zu wenig'}</span>{' '}
                              {qty(p.available)}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <input type="number" name={`done_${p.id}`} step="0.001" min="0" defaultValue={p.qty} required />
                        </td>
                        <td>{p.uom}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
            <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
              <button className="primary" type="submit">Reparatur abschließen</button>
              <span className="muted small" style={{ marginLeft: 12 }}>
                Bucht alle Teilebewegungen und setzt den Auftrag auf „Repariert“.
              </span>
            </div>
          </ActionForm>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Teil</th>
                  <th className="num">Menge</th>
                  <th className="num">Gebucht</th>
                  <th>Einheit</th>
                  <th>Wirkung</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    {/* Die Art ist eine Einteilung, kein Zustand: neutral. */}
                    <td>
                      <span className="badge neutral">{PART_TYPES[p.part_type].label}</span>
                    </td>
                    <td>{p.product}</td>
                    <td className="num">{qty(p.qty)}</td>
                    <td className="num">{p.move_state === 'done' ? qty(p.qty_done) : '—'}</td>
                    <td>{p.uom}</td>
                    <td className="muted small">{PART_TYPES[p.part_type].hint}</td>
                    {editable && (
                      <td className="num">
                        <ActionButton className="small danger" action={removePart.bind(null, id, p.id)}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        {teileErfassbar && (
          <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
            <ActionForm action={addPart.bind(null, id)}>
              <div className="row">
                <label className="field">
                  <span>Art</span>
                  <select name="part_type" defaultValue="add">
                    {Object.entries(PART_TYPES).map(([key, v]) => (
                      <option key={key} value={key}>{v.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ flex: 3 }}>
                  <span>Teil</span>
                  <select name="variant_id" required defaultValue="">
                    <option value="" disabled>— auswählen —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Menge</span>
                  <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      <RecordComments model="repair_order" recordId={id} path={`/reparatur/${id}`} />
    </>
  )
}
