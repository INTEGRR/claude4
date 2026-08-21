import { requireArea } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { date, isoDatum, money, qty } from '@/modules/shared/format'
import { cancelBill, payBill, postBill, setBillChecked, setBillDate } from '../../actions'
import { rechnungTeilzahlung, zahlungStornieren } from '../../../finanzen/actions'

export const dynamic = 'force-dynamic'

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireArea('einkauf')
  const { id } = await params
  const darfFinanzen = canAccess(user.role, 'finanzen', user.befugnisse)

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

  // Zahlungen (0058): offener Betrag mit Anrechnung der Zahlplan-Anzahlungen.
  const [offen] = darfFinanzen
    ? await sql<{ offen: number }[]>`select vendor_bill_offen(${id}) as offen`
    : [{ offen: 0 }]
  const billZahlungen = darfFinanzen
    ? await sql<
        { id: string; nummer: string; betrag_eur: number; gezahlt_am: string;
          konto: string | null; storniert: boolean; quelle: string; bezeichnung: string | null }[]
      >`
        select z.id, z.nummer, z.betrag_eur, z.gezahlt_am, k.name as konto,
               (z.storniert_am is not null) as storniert, z.quelle, r.bezeichnung
        from zahlungen z
        left join bankkonten k on k.id = z.bankkonto_id
        left join zahlplan_raten r on r.id = z.zahlplan_rate_id
        where z.vendor_bill_id = ${id}
           or (r.purchase_order_id = ${bill.purchase_order_id ?? null} and ${bill.purchase_order_id ?? null}::uuid is not null)
        order by z.gezahlt_am`
    : []
  const konten = darfFinanzen
    ? await sql<{ id: string; name: string }[]>`
        select id, name from bankkonten where aktiv order by sequence, name`
    : []

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

      {/* Zahlungen (Finanzen): Teilzahlungen mit Anrechnung der Zahlplan-
          Anzahlungen derselben Bestellung — bezahlt wird die Rechnung erst
          bei voller Deckung (Logik in vendor_bill_offen/zahlung_erfassen). */}
      {darfFinanzen && !bill.is_credit_note && (
        <Card title="Zahlungen">
          <div className="row" style={{ alignItems: 'center', marginBottom: billZahlungen.length > 0 ? 10 : 0 }}>
            <div style={{ flex: 1 }}>
              Offen:{' '}
              <span className="mono" style={{ fontWeight: 650 }}>{money(offen.offen)}</span>
              {Number(offen.offen) <= 0 && <> — <span className="led ok" /> vollständig gedeckt</>}
            </div>
          </div>
          {billZahlungen.length > 0 && (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Zahlung</th>
                    <th>Datum</th>
                    <th>Konto</th>
                    <th>Bezug</th>
                    <th style={{ textAlign: 'right' }}>Betrag</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {billZahlungen.map((z) => (
                    <tr key={z.id} style={z.storniert ? { opacity: 0.45 } : undefined}>
                      <td className="mono">{z.nummer}{z.storniert ? ' (storniert)' : ''}</td>
                      <td className="mono muted">{date(z.gezahlt_am)}</td>
                      <td className="muted">{z.konto ?? '—'}</td>
                      <td className="muted">
                        {z.quelle === 'po_rate' ? `Zahlplan: ${z.bezeichnung ?? 'Rate'}` : 'Rechnung'}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{money(z.betrag_eur)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {!z.storniert && (
                          <ActionButton className="small danger" action={zahlungStornieren.bind(null, z.id)}>
                            Stornieren
                          </ActionButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {bill.state === 'posted' && Number(offen.offen) > 0 && (
            <div style={{ marginTop: 12 }}>
              <ActionForm action={rechnungTeilzahlung.bind(null, id)}>
                <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label className="field shrink">
                    <span>Betrag (€)</span>
                    <input
                      type="number"
                      name="betrag"
                      step="0.01"
                      min="0.01"
                      required
                      defaultValue={Number(offen.offen).toFixed(2)}
                      style={{ width: 130 }}
                    />
                  </label>
                  <label className="field shrink">
                    <span>Gezahlt am</span>
                    <input type="date" name="gezahlt_am" defaultValue={isoDatum(new Date())} />
                  </label>
                  <label className="field shrink">
                    <span>Bankkonto</span>
                    <select name="bankkonto_id" defaultValue="">
                      <option value="">—</option>
                      {konten.map((k) => (
                        <option key={k.id} value={k.id}>{k.name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="shrink field">
                    <button className="primary" type="submit">Zahlung erfassen</button>
                  </div>
                </div>
              </ActionForm>
            </div>
          )}
        </Card>
      )}

      <RecordComments model="vendor_bill" recordId={id} path={`/einkauf/rechnungen/${id}`} />
    </>
  )
}
