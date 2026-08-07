import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, money, qty } from '@/modules/shared/format'
import { cancelBill, payBill, postBill, setBillChecked, setBillDate } from '../../actions'

export const dynamic = 'force-dynamic'

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('einkauf')
  const { id } = await params

  const [bill] = await sql<
    {
      id: string
      number: string
      state: string
      vendor: string
      bill_date: string | null
      vendor_bill_reference: string | null
      is_credit_note: boolean
      purchase_order_id: string | null
      po_number: string | null
      currency: string
      net: number
      tax: number
      gross: number
      reversed_number: string | null
      due_date: string | null
      payment_term_id: string | null
      payment_reference: string | null
      checked: boolean
      match_state: string
    }[]
  >`
    select b.*, p.name as vendor, po.number as po_number, t.net, t.tax, t.gross,
           rb.number as reversed_number, vendor_bill_match_state(b.id) as match_state
    from vendor_bills b
    join partners p on p.id = b.vendor_id
    left join purchase_orders po on po.id = b.purchase_order_id
    left join vendor_bills rb on rb.id = b.reversed_bill_id
    cross join lateral vendor_bill_total(b.id) t
    where b.id = ${id}`

  if (!bill) notFound()

  const lines = await sql<{ id: string; name: string; qty: number; price_unit: number; tax_rate: number }[]>`
    select id, name, qty, price_unit, tax_rate from vendor_bill_lines
    where bill_id = ${id} order by created_at`

  const terms = await sql<{ id: string; name: string }[]>`
    select id, name from payment_terms where active order by sequence, nb_days`

  // 3-Way-Matching-Ampel: Bestellung <-> Wareneingang <-> Rechnung.
  // Echte Ampel: LED plus Wort. Nur der Ausnahmefall glüht orange.
  const MATCH = {
    yes: { label: 'Zahlung freigegeben', led: 'ok' },
    no: { label: 'Wareneingang fehlt', led: 'warn' },
    exception: { label: 'Mehr berechnet als erhalten', led: 'on' },
  } as Record<string, { label: string; led: string }>
  const match = MATCH[bill.match_state] ?? MATCH.yes


  return (
    <>
      <PageHeader
        title={
          <span className="actions" style={{ gap: 8 }}>
            <span className="mono">{bill.number}</span>
            {bill.is_credit_note && <span className="badge info">Gutschrift</span>}
          </span>
        }
        subtitle={
          <>
            {bill.vendor}
            {bill.po_number && (
              <>
                {' '}· Bestellung{' '}
                <Link className="mono" href={`/einkauf/${bill.purchase_order_id}`}>{bill.po_number}</Link>
              </>
            )}
            {bill.vendor_bill_reference && (
              <> · Lieferantenbeleg <span className="mono">{bill.vendor_bill_reference}</span></>
            )}
            {bill.reversed_number && (
              <> · storniert <span className="mono">{bill.reversed_number}</span></>
            )}
            {bill.due_date && <> · fällig <span className="mono">{date(bill.due_date)}</span></>}
            {bill.payment_reference && (
              <> · Verwendungszweck <span className="mono">{bill.payment_reference}</span></>
            )}
          </>
        }
        actions={
          <>
            <Badge state={bill.state} kind="bill" />
            {bill.po_number && (
              <span className="actions" style={{ gap: 6 }} title="3-Way-Matching">
                <span className={`led ${match.led}`} />
                <span className="mono-label">{match.label}</span>
              </span>
            )}
            {/* Zustand und Bedienung getrennt: LED zeigt den Prüfstand, die Taste schaltet ihn. */}
            {bill.checked && (
              <span className="actions" style={{ gap: 6 }}>
                <span className="led ok" />
                <span className="mono-label">Geprüft</span>
              </span>
            )}
            <ActionButton action={setBillChecked.bind(null, id, !bill.checked)}>
              {bill.checked ? 'Prüfung aufheben' : 'Als geprüft markieren'}
            </ActionButton>
            {bill.state === 'draft' && (
              <ActionButton className="primary" action={postBill.bind(null, id)}>Buchen</ActionButton>
            )}
            {bill.state === 'posted' && (
              <ActionButton className="primary" action={payBill.bind(null, id)}>Zahlung erfassen</ActionButton>
            )}
            {(bill.state === 'draft' || bill.state === 'posted') && (
              <ActionButton
                className="danger"
                action={cancelBill.bind(null, id)}
                confirm={
                  bill.state === 'posted'
                    ? 'Für die gebuchte Rechnung wird eine Gutschrift angelegt. Fortfahren?'
                    : 'Entwurf verwerfen?'
                }
              >
                {bill.state === 'posted' ? 'Gutschrift anlegen' : 'Verwerfen'}
              </ActionButton>
            )}
          </>
        }
      />

      {bill.state === 'draft' && (
        <Card title="Rechnungsdaten">
          <ActionForm action={setBillDate.bind(null, id)}>
            <div className="row">
              <label className="field">
                <span>Rechnungsdatum</span>
                <input type="date" name="bill_date" defaultValue={bill.bill_date ?? ''} required />
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span>Rechnungsnummer des Lieferanten</span>
                <input className="mono" name="vendor_bill_reference" defaultValue={bill.vendor_bill_reference ?? ''} />
              </label>
              <label className="field">
                <span>Zahlungsbedingung</span>
                <select name="payment_term_id" defaultValue={bill.payment_term_id ?? ''}>
                  <option value="">—</option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Verwendungszweck</span>
                <input className="mono" name="payment_reference" defaultValue={bill.payment_reference ?? ''} />
              </label>
              <div className="shrink field">
                <button type="submit">Speichern</button>
              </div>
            </div>
          </ActionForm>
        </Card>
      )}

      <Card title="Positionen" tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Position</th>
                <th className="num">Menge</th>
                <th className="num">Preis</th>
                <th className="num">MwSt.</th>
                <th className="num">Netto</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="num">{qty(l.qty)}</td>
                  <td className="num">{money(l.price_unit, bill.currency)}</td>
                  <td className="num">{qty(l.tax_rate)} %</td>
                  <td className="num">{money(Number(l.qty) * Number(l.price_unit), bill.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="num mono-label">Netto</td>
                <td className="num">{money(bill.net, bill.currency)}</td>
              </tr>
              <tr>
                <td colSpan={4} className="num mono-label">MwSt.</td>
                <td className="num">{money(bill.tax, bill.currency)}</td>
              </tr>
              <tr>
                <td colSpan={4} className="num mono-label">Gesamt</td>
                <td className="num" style={{ fontWeight: 650 }}>{money(bill.gross, bill.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </TableWrap>
      </Card>

      <RecordComments model="vendor_bill" recordId={id} path={`/einkauf/rechnungen/${id}`} />
    </>
  )
}
