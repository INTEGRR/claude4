import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { TagEditor } from '@/components/tag-editor'
import { date } from '@/modules/shared/format'
import { createChildContact, updatePartner } from '../actions'

export const dynamic = 'force-dynamic'

const TYPE_LABEL: Record<string, string> = {
  contact: 'Kontakt',
  invoice: 'Rechnungsadresse',
  delivery: 'Lieferadresse',
  other: 'Sonstige',
}

export default async function KontaktPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('kontakte')
  const { id } = await params

  const [partner] = await sql<
    {
      id: string
      name: string
      is_company: boolean
      is_customer: boolean
      is_vendor: boolean
      email: string | null
      phone: string | null
      mobile: string | null
      website: string | null
      street: string | null
      house_number: string | null
      street2: string | null
      zip: string | null
      city: string | null
      country_code: string
      vat: string | null
      ref: string | null
      job_title: string | null
      company_registry: string | null
      partner_type: string
      parent_id: string | null
      parent_name: string | null
      user_id: string | null
      customer_payment_term_id: string | null
      supplier_payment_term_id: string | null
    }[]
  >`select p.*, elternteil.name as parent_name
    from partners p
    left join partners elternteil on elternteil.id = p.parent_id
    where p.id = ${id}`
  if (!partner) notFound()

  const children = await sql<
    { id: string; name: string; partner_type: string; email: string | null; city: string | null }[]
  >`select id, name, partner_type, email, city from partners
    where parent_id = ${id} and active order by partner_type, name`

  const benutzer = await sql<{ id: string; name: string }[]>`
    select id, name from users where active order by name`
  const terms = await sql<{ id: string; name: string }[]>`
    select id, name from payment_terms where active order by sequence, nb_days`

  const orders = await sql<{ id: string; number: string; state: string; order_date: string }[]>`
    select id, number, state, order_date from sales_orders
    where partner_id = ${id} order by order_date desc limit 10`
  const purchases = await sql<{ id: string; number: string; state: string; order_date: string }[]>`
    select id, number, state, created_at as order_date from purchase_orders
    where vendor_id = ${id} order by created_at desc limit 10`

  return (
    <>
      <PageHeader
        title={partner.name}
        subtitle={
          <>
            {partner.parent_name && (
              <>
                {TYPE_LABEL[partner.partner_type]} von{' '}
                <Link href={`/kontakte/${partner.parent_id}`}>{partner.parent_name}</Link> ·{' '}
              </>
            )}
            {partner.is_customer && 'Kunde'}
            {partner.is_customer && partner.is_vendor && ' · '}
            {partner.is_vendor && 'Lieferant'}
            {partner.is_company ? ' · Firma' : ''}
            {partner.ref && ` · Ref. ${partner.ref}`}
          </>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <TagEditor model="partner" recordId={id} path={`/kontakte/${id}`} />
      </div>

      <Card title="Stammdaten">
        <ActionForm action={updatePartner.bind(null, id)}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Name</span>
              <input name="name" defaultValue={partner.name} required />
            </label>
            <label className="field">
              <span>Interne Referenz</span>
              <input name="ref" defaultValue={partner.ref ?? ''} />
            </label>
            <label className="field">
              <span>Funktion</span>
              <input name="job_title" defaultValue={partner.job_title ?? ''} placeholder="z. B. Einkauf" />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" defaultValue={partner.email ?? ''} />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" defaultValue={partner.phone ?? ''} />
            </label>
            <label className="field">
              <span>Mobil</span>
              <input name="mobile" defaultValue={partner.mobile ?? ''} />
            </label>
            <label className="field">
              <span>Website</span>
              <input name="website" defaultValue={partner.website ?? ''} />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" defaultValue={partner.street ?? ''} />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house_number" defaultValue={partner.house_number ?? ''} />
            </label>
            <label className="field">
              <span>Zusatz</span>
              <input name="street2" defaultValue={partner.street2 ?? ''} />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input name="zip" defaultValue={partner.zip ?? ''} />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" defaultValue={partner.city ?? ''} />
            </label>
            <label className="field">
              <span>Land</span>
              <input name="country_code" defaultValue={partner.country_code} maxLength={2} />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>USt-ID</span>
              <input name="vat" defaultValue={partner.vat ?? ''} />
            </label>
            <label className="field">
              <span>Handelsregister</span>
              <input name="company_registry" defaultValue={partner.company_registry ?? ''} placeholder="HRB …" />
            </label>
            <label className="field">
              <span>Verkäufer</span>
              <select name="user_id" defaultValue={partner.user_id ?? ''}>
                <option value="">—</option>
                {benutzer.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Zahlungsbedingung (Kunde)</span>
              <select name="customer_payment_term_id" defaultValue={partner.customer_payment_term_id ?? ''}>
                <option value="">—</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Zahlungsbedingung (Lieferant)</span>
              <select name="supplier_payment_term_id" defaultValue={partner.supplier_payment_term_id ?? ''}>
                <option value="">—</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <label className="shrink"><input type="checkbox" name="is_company" defaultChecked={partner.is_company} /> Firma</label>
            <label className="shrink"><input type="checkbox" name="is_customer" defaultChecked={partner.is_customer} /> Kunde</label>
            <label className="shrink"><input type="checkbox" name="is_vendor" defaultChecked={partner.is_vendor} /> Lieferant</label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>
      </Card>

      <Card
        title={`Ansprechpartner & Adressen (${children.length})`}
        actions={<span className="muted small">abweichende Liefer-/Rechnungsadressen als Unterkontakte</span>}
        tight
      >
        {children.length > 0 && (
          <TableWrap>
            <table>
              <tbody>
                {children.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/kontakte/${c.id}`}>{c.name}</Link></td>
                    <td><span className="badge neutral">{TYPE_LABEL[c.partner_type]}</span></td>
                    <td className="small">{c.email ?? '—'}</td>
                    <td className="small">{c.city ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <div style={{ padding: 12 }}>
          <ActionForm action={createChildContact.bind(null, id)}>
            <div className="row">
              <input name="name" placeholder="Name" required style={{ flex: 2 }} />
              <select name="partner_type" defaultValue="contact">
                <option value="contact">Ansprechpartner</option>
                <option value="invoice">Rechnungsadresse</option>
                <option value="delivery">Lieferadresse</option>
                <option value="other">Sonstige</option>
              </select>
              <input name="email" placeholder="E-Mail" />
              <input name="street" placeholder="Straße (leer = wie Hauptkontakt)" />
              <input name="house_number" placeholder="Nr." style={{ maxWidth: 70 }} />
              <input name="zip" placeholder="PLZ" style={{ maxWidth: 90 }} />
              <input name="city" placeholder="Ort" />
              <div className="shrink">
                <button type="submit">Anlegen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>

      <div className="grid-2">
        <Card title={`Verkaufsaufträge (${orders.length})`} tight>
          {orders.length === 0 ? (
            <Empty>Keine Aufträge.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono"><Link href={`/verkauf/${o.id}`}>{o.number}</Link></td>
                      <td><Badge state={o.state} kind="sale" /></td>
                      <td className="nowrap small muted">{date(o.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Bestellungen (${purchases.length})`} tight>
          {purchases.length === 0 ? (
            <Empty>Keine Bestellungen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id}>
                      <td className="mono"><Link href={`/einkauf/${p.id}`}>{p.number}</Link></td>
                      <td><Badge state={p.state} kind="purchase" /></td>
                      <td className="nowrap small muted">{date(p.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <RecordComments model="partner" recordId={id} path={`/kontakte/${id}`} />
    </>
  )
}
