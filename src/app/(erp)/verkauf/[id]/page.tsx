import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, money, qty } from '@/modules/shared/format'
import { TagEditor } from '@/components/tag-editor'
import {
  addLine,
  cancelOrder,
  confirmOrder,
  removeLine,
  resetToDraft,
  setLocked,
  updateOrderHeader,
} from '../actions'

export const dynamic = 'force-dynamic'

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('verkauf')
  const { id } = await params

  const [order] = await sql<
    {
      id: string
      number: string
      state: string
      locked: boolean
      delivery_status: string
      source: string
      shopify_order_id: string | null
      shopify_order_name: string | null
      order_date: string
      currency: string
      note: string | null
      partner_id: string
      partner_name: string
      ship_name: string | null
      ship_street: string | null
      ship_house_number: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
      net: number
      tax: number
      gross: number
    }[]
  >`
    select so.*, p.name as partner_name,
           t.net, t.tax, t.gross
    from sales_orders so
    join partners p on p.id = so.partner_id
    cross join lateral sales_order_total(so.id) t
    where so.id = ${id}`

  if (!order) notFound()

  const kopf = (order as unknown) as {
    user_id: string | null
    client_order_ref: string | null
    commitment_date: string | null
    validity_date: string | null
    payment_term_id: string | null
    incoterm_code: string | null
    incoterm_location: string | null
  }
  const benutzer = await sql<{ id: string; name: string }[]>`
    select id, name from users where active order by name`
  const terms = await sql<{ id: string; name: string }[]>`
    select id, name from payment_terms where active order by sequence, nb_days`
  const incoterms = await sql<{ code: string; name: string }[]>`
    select code, name from incoterms order by code`

  const lines = await sql<
    {
      id: string
      name: string
      qty: number
      uom: string
      price_unit: number
      discount: number
      tax_rate: number
      qty_delivered: number
      subtotal: number
      variant_id: string | null
    }[]
  >`
    select l.id, l.name, l.qty, u.name as uom, l.price_unit, l.discount, l.tax_rate,
           l.qty_delivered, sale_line_subtotal(l) as subtotal, l.variant_id
    from sales_order_lines l
    left join uoms u on u.id = l.uom_id
    where l.order_id = ${id} and l.display_type is null
    order by l.sequence`

  const pickings = await sql<
    { id: string; number: string; state: string; date_done: string | null }[]
  >`
    select id, number, state, date_done from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${id} order by created_at`

  const mos = await sql<
    { id: string; number: string; state: string; qty_to_produce: number; product: string }[]
  >`
    select mo.id, mo.number, mo.state, mo.qty_to_produce,
           variant_display_name(mo.variant_id) as product
    from manufacturing_orders mo where mo.sales_order_id = ${id} order by mo.created_at`

  const shipments = await sql<
    { id: string; shipment_number: string; state: string; tracking_url: string }[]
  >`
    select s.id, s.shipment_number, s.state, s.tracking_url
    from shipments s where s.sales_order_id = ${id} order by s.created_at`

  const products = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) ||
           coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.can_be_sold and pt.active
    order by label limit 500`

  const editable = order.state !== 'cancel' && !order.locked

  return (
    <>
      <PageHeader
        title={
          <>
            <span className="mono">{order.number}</span>
            {order.shopify_order_name && (
              <span className="mono muted"> · {order.shopify_order_name}</span>
            )}
          </>
        }
        subtitle={
          <>
            {order.partner_name} · <span className="mono">{date(order.order_date)}</span>
            {order.source === 'shopify' && <> · aus Shopify importiert</>}
          </>
        }
        actions={
          <>
            <Badge state={order.state} kind="sale" />
            {/* Sperre: Leuchte plus Wort statt grauem Chip. */}
            {order.locked && (
              <span className="actions nowrap" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <span className="led warn" />
                <span className="mono-label">Gesperrt</span>
              </span>
            )}
            {(order.state === 'draft' || order.state === 'sent') && (
              <ActionButton className="primary" action={confirmOrder.bind(null, id)}>
                Bestätigen
              </ActionButton>
            )}
            {order.state === 'sale' &&
              (order.locked ? (
                <ActionButton action={setLocked.bind(null, id, false)}>Entsperren</ActionButton>
              ) : (
                <ActionButton action={setLocked.bind(null, id, true)}>Sperren</ActionButton>
              ))}
            {order.state !== 'cancel' && (
              <ActionButton
                className="danger"
                action={cancelOrder.bind(null, id)}
                confirm="Auftrag wirklich stornieren? Offene Lieferungen werden abgebrochen."
              >
                Stornieren
              </ActionButton>
            )}
            {(order.state === 'cancel' || order.state === 'sent') && (
              <ActionButton action={resetToDraft.bind(null, id)}>Auf Angebot zurücksetzen</ActionButton>
            )}
          </>
        }
      />

      {order.locked && (
        <div className="notice info">
          Der Auftrag ist gesperrt und kann nicht geändert werden. Zum Bearbeiten bitte entsperren.
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <TagEditor model="sales_order" recordId={id} path={`/verkauf/${id}`} />
      </div>

      {/* Kennzahlenreihe: .stat mit Mono-Typenschild statt drei Kartenkopfleisten. */}
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="stat">
            <div className="label">Lieferstatus</div>
            <div style={{ marginTop: 6 }}>
              <Badge state={order.delivery_status} kind="delivery" />
            </div>
          </div>
        </div>
        {/* Bewusst keine Abrechnungs-Kachel: ein Kundenrechnungs-Modul gibt es
            (noch) nicht — invoice_status bleibt als Faktum am Beleg, aber ohne
            Modul dahinter wäre die Anzeige ein Signal ins Leere. Kommt ein
            AR-Modul, kommt die Kachel mit prozessschritt_aktiv() zurück. */}
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="stat">
            <div className="label">Lieferadresse</div>
            <div className="small" style={{ marginTop: 6 }}>
              {order.ship_name ?? order.partner_name}
              <br />
              {order.ship_street} {order.ship_house_number}
              <br />
              {/* PLZ und Ländercode sind Codes, Ort bleibt Fließtext. */}
              <span className="mono">{order.ship_zip}</span> {order.ship_city}{' '}
              <span className="mono">{order.ship_country_code}</span>
            </div>
          </div>
        </div>
        {order.source === 'shopify' && order.shopify_order_id && (
          <div className="display-panel">
            <div className="display-head">
              <span>Shopify-Verknüpfung</span>
              <span>ID</span>
            </div>
            <div className="mono" style={{ fontSize: 15, color: 'var(--display-bright)' }}>
              {order.shopify_order_name ?? '—'}
            </div>
            <div className="mono small">{order.shopify_order_id}</div>
          </div>
        )}
      </div>

      <Card title="Details">
        <ActionForm action={updateOrderHeader.bind(null, id)}>
          <div className="row">
            <label className="field">
              <span>Verkäufer</span>
              <select name="user_id" defaultValue={kopf.user_id ?? ''} disabled={!editable}>
                <option value="">—</option>
                {benutzer.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Kundenreferenz</span>
              <input name="client_order_ref" defaultValue={kopf.client_order_ref ?? ''} disabled={!editable} />
            </label>
            <label className="field">
              <span>Zugesagter Liefertermin</span>
              <input
                type="date"
                name="commitment_date"
                defaultValue={kopf.commitment_date?.slice(0, 10) ?? ''}
                disabled={!editable}
              />
            </label>
            <label className="field">
              <span>Angebot gültig bis</span>
              <input
                type="date"
                name="validity_date"
                defaultValue={kopf.validity_date?.slice(0, 10) ?? ''}
                disabled={!editable}
              />
            </label>
            <label className="field">
              <span>Zahlungsbedingung</span>
              <select name="payment_term_id" defaultValue={kopf.payment_term_id ?? ''} disabled={!editable}>
                <option value="">—</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Incoterm</span>
              <select name="incoterm_code" defaultValue={kopf.incoterm_code ?? ''} disabled={!editable}>
                <option value="">—</option>
                {incoterms.map((i) => (
                  <option key={i.code} value={i.code}>{i.code} — {i.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Incoterm-Ort</span>
              <input name="incoterm_location" defaultValue={kopf.incoterm_location ?? ''} disabled={!editable} />
            </label>
            {editable && (
              <div className="shrink field">
                <button type="submit">Speichern</button>
              </div>
            )}
          </div>
        </ActionForm>
      </Card>

      <Card title="Positionen" tight>
        {lines.length === 0 ? (
          <Empty>Noch keine Positionen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Menge</th>
                  <th>Einheit</th>
                  <th className="num">Geliefert</th>
                  <th className="num">Einzelpreis</th>
                  <th className="num">MwSt.</th>
                  <th className="num">Netto</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="num">{qty(l.qty)}</td>
                    <td>{l.uom}</td>
                    <td className="num">
                      {/* Vollständig geliefert zeigt die Leuchte, nicht die Farbe der Zahl. */}
                      <span
                        className="nowrap"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <span
                          className={
                            Number(l.qty_delivered) >= Number(l.qty) ? 'led ok' : 'led off'
                          }
                        />
                        <span className="mono">{qty(l.qty_delivered)}</span>
                      </span>
                    </td>
                    <td className="num">{money(l.price_unit, order.currency)}</td>
                    <td className="num">{qty(l.tax_rate)} %</td>
                    <td className="num">{money(l.subtotal, order.currency)}</td>
                    {editable && (
                      <td className="num">
                        <ActionButton className="small danger" action={removeLine.bind(null, id, l.id)}>
                          Entfernen
                        </ActionButton>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {/* Summenzeilen: Kennzahlen-Labels als Typenschild, die Gesamtsumme
                  trennt eine Linie ab — keine Fettung. */}
              <tfoot>
                <tr>
                  <td colSpan={6} className="num mono-label">Netto</td>
                  <td className="num">{money(order.net, order.currency)}</td>
                  {editable && <td />}
                </tr>
                <tr>
                  <td colSpan={6} className="num mono-label">MwSt.</td>
                  <td className="num">{money(order.tax, order.currency)}</td>
                  {editable && <td />}
                </tr>
                <tr style={{ borderTop: '2px solid var(--border-strong)' }}>
                  <td colSpan={6} className="num mono-label">Gesamt</td>
                  <td className="num">{money(order.gross, order.currency)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        {editable && (
          <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
            <ActionForm action={addLine.bind(null, id)}>
              <div className="row">
                <label className="field" style={{ flex: 3 }}>
                  <span>Produkt</span>
                  <select name="variant_id" required>
                    <option value="">— auswählen —</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Menge</span>
                  <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
                </label>
                <label className="field">
                  <span>Preis (optional)</span>
                  <input type="number" name="price_unit" step="0.01" placeholder="aus Produkt" />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Position hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title={`Lieferungen (${pickings.length})`} tight>
          {pickings.length === 0 ? (
            <Empty>Noch keine Lieferung. Sie entsteht beim Bestätigen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Nummer</th>
                    <th>Status</th>
                    <th>Datum</th>
                  </tr>
                </thead>
                <tbody>
                  {pickings.map((p) => (
                    <tr key={p.id}>
                      <td className="mono"><Link href={`/lager/${p.id}`}>{p.number}</Link></td>
                      <td><Badge state={p.state} kind="picking" /></td>
                      <td className="mono nowrap">{date(p.date_done)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Fertigungsaufträge (${mos.length})`} tight>
          {mos.length === 0 ? (
            <Empty>Keine Fertigung nötig.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Nummer</th>
                    <th>Produkt</th>
                    <th className="num">Menge</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {mos.map((m) => (
                    <tr key={m.id}>
                      <td className="mono"><Link href={`/fertigung/${m.id}`}>{m.number}</Link></td>
                      <td>{m.product}</td>
                      <td className="num">{qty(m.qty_to_produce)}</td>
                      <td><Badge state={m.state} kind="mo" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {shipments.length > 0 && (
        <Card title="Sendungen" tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Sendungsnummer</th>
                  <th>Status</th>
                </tr>
              </thead>
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

      <RecordComments model="sales_order" recordId={id} path={`/verkauf/${id}`} />
    </>
  )
}
