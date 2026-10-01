import { requireArea } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { ResponsibleForm } from '@/components/responsible-form'
import { LandedCosts } from '@/components/landed-costs'
import { RecordComments } from '@/components/record-comments'
import { ProzessPanel } from '@/components/prozess-panel'
import { date, qty } from '@/modules/shared/format'
import {
  artikeletikettenDrucken,
  cancelPicking,
  checkAvailability,
  confirmPicking,
  returnPicking,
  updatePickingDetails,
  validatePicking,
} from '../actions'
import { herkunftHref } from '../herkunft'

export const dynamic = 'force-dynamic'

/** Eine Zeile der Karte „Artikel-Etiketten" (je Variante summiert). */
interface EtikettZeile {
  variant_id: string
  product: string
  sku: string | null
  uom: string
  /** Barcode oder SKU vorhanden — sonst gibt es kein Etikett. */
  code: boolean
  qty: number
}

export default async function PickingPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('lager')
  const { id } = await params

  const [picking] = await sql<
    {
      id: string
      number: string
      kind: string
      type_name: string
      state: string
      partner: string | null
      partner_id: string | null
      origin_model: string | null
      origin_id: string | null
      origin_label: string | null
      scheduled_date: string
      date_done: string | null
      backorder_of: string | null
      backorder_of_id: string | null
      return_of: string | null
      return_of_id: string | null
      note: string | null
      user_id: string | null
      priority: string
    }[]
  >`
    select p.id, p.number, ot.kind, ot.name as type_name, p.state, part.name as partner,
           p.partner_id, p.origin_model, p.origin_id, p.origin_label, p.scheduled_date, p.date_done,
           bo.number as backorder_of, p.backorder_of_id, ro.number as return_of, p.return_of_id, p.note,
           p.user_id, p.priority
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join partners part on part.id = p.partner_id
    left join stock_pickings bo on bo.id = p.backorder_of_id
    left join stock_pickings ro on ro.id = p.return_of_id
    where p.id = ${id}`

  if (!picking) notFound()

  const [prozessWahl] = await sql<{ code: string | null }[]>`
    select prozess_fuer_beleg('stock_picking', ${id}) as code`
  const prozessCode = prozessWahl?.code ?? null

  const moves = await sql<
    {
      id: string
      variant_id: string
      product: string
      sku: string | null
      barcode: string | null
      qty: number
      qty_done: number
      reserved_qty: number
      uom: string
      state: string
      src: string
      dest: string
      tracking: string
      lots: string | null
    }[]
  >`
    select m.id, m.variant_id, variant_display_name(m.variant_id) as product, pv.sku, pv.barcode, m.qty, m.qty_done,
           m.reserved_qty, u.name as uom, m.state, src.full_path as src, dst.full_path as dest,
           pt.tracking,
           (select string_agg(sl.name || ' × ' || round(a.qty, 2), ', ' order by sl.name)
            from move_lot_assignments a join stock_lots sl on sl.id = a.lot_id
            where a.move_id = m.id) as lots
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = m.uom_id
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    where m.picking_id = ${id}
    order by m.created_at`

  const shipments = await sql<
    { id: string; shipment_number: string; state: string; tracking_url: string }[]
  >`select id, shipment_number, state, tracking_url from shipments where picking_id = ${id}`

  // Folgebelege in beide Richtungen: Rückstände und Retouren zu diesem
  // Transfer sowie die Reparatur, deren Rückversand er ist — Querverweise
  // statt Sackgassen (Betreiber 2026-10-01).
  const folgebelege = await sql<{ id: string; number: string; art: string }[]>`
    select id, number, case when backorder_of_id = ${id} then 'Rückstand' else 'Retoure' end as art
    from stock_pickings
    where backorder_of_id = ${id} or return_of_id = ${id}
    order by created_at`
  const reparaturen = await sql<{ id: string; number: string }[]>`
    select id, number from repair_orders where return_picking_id = ${id} order by created_at`

  const open = picking.state !== 'done' && picking.state !== 'cancel'
  const originHref = herkunftHref(picking.origin_model, picking.origin_id)

  // Nach dem Wareneingang: Artikel-Etiketten je Variante, vorbelegt mit der
  // gebuchten Menge (ganze Stück; sonst 1) — gedruckt wird über
  // lager.artikeletikett_drucken am Etikettendrucker des Arbeitsplatzes.
  const etikettZeilen =
    picking.kind === 'receipt' && picking.state === 'done' && canWrite(user.rollen, 'lager', user.befugnisse)
      ? [
          ...moves
            .filter((m) => m.state === 'done' && Number(m.qty_done) > 0)
            .reduce((summe, m) => {
              const bisher = summe.get(m.variant_id)
              summe.set(m.variant_id, {
                variant_id: m.variant_id,
                product: m.product,
                sku: m.sku,
                uom: m.uom,
                code: Boolean(m.barcode?.trim() || m.sku?.trim()),
                qty: (bisher?.qty ?? 0) + Number(m.qty_done),
              })
              return summe
            }, new Map<string, EtikettZeile>())
            .values(),
        ].map((z) => ({ ...z, anzahl: Number.isInteger(z.qty) ? Math.min(500, z.qty) : 1 }))
      : []

  // Zulauf-Infos der Herkunfts-Bestellung: Termin (bestätigt vor geschätzt),
  // Carrier und Tracking — gepflegt am Einkauf, hier nur angezeigt.
  const [zulauf] =
    picking.origin_model === 'purchase_order' && picking.origin_id
      ? await sql<
          {
            expected_arrival: string | null
            eta_confirmed: string | null
            carrier: string | null
            tracking_number: string | null
            tracking_url: string | null
          }[]
        >`
          select expected_arrival, eta_confirmed::text, carrier, tracking_number, tracking_url
          from purchase_orders where id = ${picking.origin_id}`
      : [undefined]

  return (
    <>
      <PageHeader
        title={<span className="mono">{picking.number}</span>}
        subtitle={
          <>
            {picking.type_name}
            {picking.partner && (
              <>
                {' '}·{' '}
                {picking.partner_id ? (
                  <Link href={`/kontakte/${picking.partner_id}`}>{picking.partner}</Link>
                ) : (
                  picking.partner
                )}
              </>
            )}
            {picking.origin_label && (
              <>
                {' '}· Quellbeleg{' '}
                {originHref ? (
                  <Link className="mono" href={originHref}>{picking.origin_label}</Link>
                ) : (
                  <span className="mono">{picking.origin_label}</span>
                )}
              </>
            )}
            {picking.backorder_of && picking.backorder_of_id && (
              <>
                {' '}· Rückstand zu{' '}
                <Link className="mono" href={`/lager/${picking.backorder_of_id}`}>{picking.backorder_of}</Link>
              </>
            )}
            {picking.return_of && picking.return_of_id && (
              <>
                {' '}· Retoure zu{' '}
                <Link className="mono" href={`/lager/${picking.return_of_id}`}>{picking.return_of}</Link>
              </>
            )}
            {folgebelege.map((f) => (
              <span key={f.id}>
                {' '}· {f.art}{' '}
                <Link className="mono" href={`/lager/${f.id}`}>{f.number}</Link>
              </span>
            ))}
            {reparaturen.map((r) => (
              <span key={r.id}>
                {' '}· Rückversand zu Reparatur{' '}
                <Link className="mono" href={`/reparatur/${r.id}`}>{r.number}</Link>
              </span>
            ))}
          </>
        }
        actions={
          <>
            <Badge state={picking.state} kind="picking" />
            <a className="btn" href={`/lager/${id}/druck`} target="_blank" rel="noopener">
              Packzettel
            </a>
            {picking.state === 'draft' && (
              <ActionButton action={confirmPicking.bind(null, id)}>
                Bestätigen
              </ActionButton>
            )}
            {open && picking.state !== 'draft' && (
              <ActionButton action={checkAvailability.bind(null, id)}>Verfügbarkeit prüfen</ActionButton>
            )}
            {picking.state === 'done' && (
              <ActionButton
                action={returnPicking.bind(null, id)}
                confirm="Retoure zu diesem Transfer anlegen?"
              >
                Retoure
              </ActionButton>
            )}
            {open && (
              <ActionButton className="danger" action={cancelPicking.bind(null, id)} confirm="Transfer stornieren?">
                Stornieren
              </ActionButton>
            )}
          </>
        }
      />
      <div style={{ marginBottom: 12 }}>
        <ResponsibleForm action={updatePickingDetails.bind(null, id)} userId={picking.user_id} priority={picking.priority} />
      </div>

      {zulauf &&
        (zulauf.eta_confirmed || zulauf.expected_arrival || zulauf.carrier || zulauf.tracking_number) && (
        <div className="display-panel" style={{ marginBottom: 12 }}>
          <div className="display-head">
            <span>Zulauf</span>
            <span>{zulauf.eta_confirmed ? 'Termin vom Lieferanten bestätigt' : 'Termin geschätzt'}</span>
          </div>
          <div className="small">
            {(zulauf.eta_confirmed || zulauf.expected_arrival) && (
              <>
                <span className={`led ${zulauf.eta_confirmed ? 'ok' : 'off'}`} /> Erwartet am{' '}
                <span className="mono">{date(zulauf.eta_confirmed ?? zulauf.expected_arrival)}</span>
              </>
            )}
            {zulauf.carrier && <> · {zulauf.carrier}</>}
            {zulauf.tracking_number && (
              <>
                {' '}·{' '}
                {zulauf.tracking_url ? (
                  <a href={zulauf.tracking_url} target="_blank" rel="noreferrer">
                    <span className="mono">{zulauf.tracking_number}</span>
                  </a>
                ) : (
                  <span className="mono">{zulauf.tracking_number}</span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {picking.state === 'done' && (
        <div className="notice success">
          <span className="led ok" />{' '}
          Validiert am {date(picking.date_done)}. Erledigte Transfers sind unveränderlich — Korrekturen
          laufen über eine Retoure.
        </div>
      )}

      <Card title="Positionen" tight>
        {open ? (
          <ActionForm action={validatePicking.bind(null, id)}>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th>Von → Nach</th>
                    <th className="num">Bedarf</th>
                    <th className="num">Reserviert</th>
                    <th className="num" style={{ width: 150 }}>Erledigt</th>
                    <th>Einheit</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Link href={`/produkte/variante/${m.variant_id}`}>{m.product}</Link>
                        {m.sku && <span className="muted small mono"> · {m.sku}</span>}
                      </td>
                      <td className="small muted nowrap mono">{m.src} → {m.dest}</td>
                      <td className="num">{qty(m.qty)}</td>
                      <td className="num">
                        {qty(m.reserved_qty)}
                        <div className="small muted nowrap">
                          <span className={Number(m.reserved_qty) >= Number(m.qty) ? 'led ok' : 'led warn'} />{' '}
                          {Number(m.reserved_qty) >= Number(m.qty) ? 'reserviert' : 'Teilmenge'}
                        </div>
                      </td>
                      <td>
                        <input
                          type="number"
                          name={`done_${m.id}`}
                          step="0.001"
                          min="0"
                          max={m.qty}
                          defaultValue={m.qty}
                          required
                        />
                        {m.tracking !== 'none' && (
                          <input
                            name={`lots_${m.id}`}
                            className="mono"
                            style={{ marginTop: 4 }}
                            placeholder={
                              m.tracking === 'serial'
                                ? 'Seriennummern: SN1, SN2, … (leer = automatisch)'
                                : 'Lose: NAME:MENGE, … (leer = automatisch)'
                            }
                          />
                        )}
                      </td>
                      <td className="mono small">{m.uom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>

            <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
              <div className="row">
                <label className="field" style={{ maxWidth: 340 }}>
                  <span>Bei Teilmenge</span>
                  <select name="backorder" defaultValue="yes">
                    <option value="yes">Rückstand für die Restmenge anlegen</option>
                    <option value="no">Restmenge aufgeben</option>
                  </select>
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Validieren</button>
                </div>
              </div>
            </div>
          </ActionForm>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Von → Nach</th>
                  <th className="num">Bedarf</th>
                  <th className="num">Gebucht</th>
                  <th>Einheit</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td><Link href={`/produkte/variante/${m.variant_id}`}>{m.product}</Link></td>
                    <td className="small muted nowrap mono">{m.src} → {m.dest}</td>
                    <td className="num">{qty(m.qty)}</td>
                    <td className="num">{qty(m.qty_done)}</td>
                    <td className="mono small">{m.uom}</td>
                    <td><Badge state={m.state} kind="picking" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {shipments.length > 0 && (
        <Card title="Sendungen" tight>
          <TableWrap>
            <table>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <a href={s.tracking_url} target="_blank" rel="noreferrer">{s.shipment_number}</a>
                    </td>
                    <td><Badge state={s.state} kind="shipment" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {etikettZeilen.length > 0 && (
        <Card title="Artikel-Etiketten" tight actions={<span className="mono-label">je gebuchtem Stück eins</span>}>
          <ActionForm action={artikeletikettenDrucken} linkOeffnen behalten>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th className="num">Gebucht</th>
                    <th className="num" style={{ width: 130 }}>Etiketten</th>
                  </tr>
                </thead>
                <tbody>
                  {etikettZeilen.map((z) => (
                    <tr key={z.variant_id}>
                      <td>
                        <Link href={`/produkte/variante/${z.variant_id}`}>{z.product}</Link>
                        {z.sku && <span className="muted small mono"> · {z.sku}</span>}
                      </td>
                      <td className="num">
                        {qty(z.qty)} <span className="mono small">{z.uom}</span>
                      </td>
                      <td className="num">
                        {z.code ? (
                          <>
                            <input type="hidden" name="variant_id" value={z.variant_id} />
                            <input
                              type="number"
                              name="anzahl"
                              aria-label={`Etiketten für ${z.product}`}
                              min="0"
                              max="500"
                              step="1"
                              defaultValue={z.anzahl}
                            />
                          </>
                        ) : (
                          <span className="small muted" title="An der Variante Barcode oder SKU hinterlegen">
                            kein Code
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <div className="row" style={{ padding: 12, borderTop: '1px solid var(--border)', alignItems: 'center' }}>
              <div className="shrink">
                <button type="submit">Artikel-Etiketten drucken</button>
              </div>
              <span className="small muted">0 = Zeile auslassen</span>
            </div>
          </ActionForm>
        </Card>
      )}

      {/* Nebenkosten nur beim Wareneingang: dort entsteht der Einstand. */}
      {picking.kind === 'receipt' && picking.state === 'done' && (
        <LandedCosts pickingId={id} />
      )}

      {/* Welcher Prozess diesen Transfer führt, entscheidet der Beleg-Filter
          (Eingang = Wareneingang, Ausgang = Shop-Versand). */}
      {prozessCode && <ProzessPanel prozessCode={prozessCode} recordId={id} rolle={user.rollen} befugnisse={user.befugnisse} />}

      <RecordComments model="stock_picking" recordId={id} path={`/lager/${id}`} />
    </>
  )
}
