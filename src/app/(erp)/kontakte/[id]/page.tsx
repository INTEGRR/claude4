import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { RecordComments } from '@/components/record-comments'
import { TagEditor } from '@/components/tag-editor'
import { date } from '@/modules/shared/format'
import { herkunftHref } from '@/app/(erp)/lager/herkunft'
import { createChildContact, updatePartner } from '../actions'
import { Auswahl } from '@/components/auswahl'

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

  // Die Belege des Partners — jede Nummer und jeder Status ist ein Weg zum
  // Beleg dahinter (Betreiber 2026-10-01: „Status sind Wege").
  const orders = await sql<
    {
      id: string
      number: string
      state: string
      delivery_status: string
      order_date: string
      lieferungen: number
      lieferungen_offen: number
      lieferung_id: string | null
    }[]
  >`
    select so.id, so.number, so.state, so.delivery_status, so.order_date,
           coalesce(lf.anzahl, 0) as lieferungen,
           coalesce(lf.offen, 0) as lieferungen_offen,
           lf.ziel as lieferung_id
    from sales_orders so
    left join lateral (
      select count(*)::int as anzahl,
             (count(*) filter (where sp.state not in ('done', 'cancel')))::int as offen,
             (array_agg(sp.id order by (sp.state in ('done', 'cancel')), sp.scheduled_date desc))[1] as ziel
      from stock_pickings sp
      join operation_types ot on ot.id = sp.operation_type_id and ot.kind = 'delivery'
      where sp.origin_model = 'sales_order' and sp.origin_id = so.id
    ) lf on true
    where so.partner_id = ${id} order by so.order_date desc limit 10`
  const purchases = await sql<{ id: string; number: string; state: string; order_date: string }[]>`
    select id, number, state, created_at as order_date from purchase_orders
    where vendor_id = ${id} order by created_at desc limit 10`
  const transfers = await sql<
    {
      id: string
      number: string
      state: string
      type_name: string
      origin_model: string | null
      origin_id: string | null
      origin_label: string | null
      scheduled_date: string
    }[]
  >`
    select p.id, p.number, p.state, ot.name as type_name,
           p.origin_model, p.origin_id, p.origin_label, p.scheduled_date
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    where p.partner_id = ${id}
    order by p.scheduled_date desc limit 10`
  const reparaturen = await sql<
    { id: string; number: string; state: string; product: string; scheduled_date: string }[]
  >`
    select r.id, r.number, r.state, variant_display_name(r.variant_id) as product, r.scheduled_date
    from repair_orders r
    where r.partner_id = ${id}
    order by r.created_at desc limit 10`
  const vorgaenge = await sql<
    { id: string; number: string; state: string; titel: string | null; prozess_name: string; prozess_code: string }[]
  >`
    select v.id, v.number, v.state, v.titel, pz.name as prozess_name, v.prozess_code
    from vorgaenge v
    join prozesse pz on pz.code = v.prozess_code
    where v.partner_id = ${id}
    order by v.created_at desc limit 10`

  // Lieferstatus-Schild: eine (offene) Lieferung → direkt, sonst die
  // Transfers des Auftrags — dieselbe Regel wie in der Auftragsliste.
  const lieferungHref = (o: (typeof orders)[number]) => {
    if (o.lieferungen === 0) return undefined
    if (o.lieferung_id && (o.lieferungen_offen === 1 || o.lieferungen === 1)) {
      return `/lager/${o.lieferung_id}`
    }
    return `/lager?auftrag=${o.id}${o.lieferungen_offen > 0 ? '' : '&offen=0'}`
  }

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
            {partner.is_vendor && (
              <>
                Lieferant (<Link href={`/einkauf/lieferanten/${id}`}>Lieferantenakte</Link>)
              </>
            )}
            {partner.is_company ? ' · Firma' : ''}
            {partner.ref && (
              <> · Ref. <span className="mono">{partner.ref}</span></>
            )}
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
              <input className="mono" name="ref" defaultValue={partner.ref ?? ''} />
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
              <input className="mono" name="zip" defaultValue={partner.zip ?? ''} />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" defaultValue={partner.city ?? ''} />
            </label>
            <label className="field">
              <span>Land</span>
              <input className="mono" name="country_code" defaultValue={partner.country_code} maxLength={2} />
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>USt-ID</span>
              <input className="mono" name="vat" defaultValue={partner.vat ?? ''} />
            </label>
            <label className="field">
              <span>Handelsregister</span>
              <input className="mono" name="company_registry" defaultValue={partner.company_registry ?? ''} placeholder="HRB …" />
            </label>
            <label className="field">
              <span>Verkäufer</span>
              <Auswahl name="user_id" defaultValue={partner.user_id ?? ''}>
                <option value="">—</option>
                {benutzer.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </Auswahl>
            </label>
            <label className="field">
              <span>Zahlungsbedingung (Kunde)</span>
              <Auswahl name="customer_payment_term_id" defaultValue={partner.customer_payment_term_id ?? ''}>
                <option value="">—</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Auswahl>
            </label>
            <label className="field">
              <span>Zahlungsbedingung (Lieferant)</span>
              <Auswahl name="supplier_payment_term_id" defaultValue={partner.supplier_payment_term_id ?? ''}>
                <option value="">—</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Auswahl>
            </label>
          </div>
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <label className="shrink field"><input type="checkbox" name="is_company" defaultChecked={partner.is_company} /> Firma</label>
            <label className="shrink field"><input type="checkbox" name="is_customer" defaultChecked={partner.is_customer} /> Kunde</label>
            <label className="shrink field"><input type="checkbox" name="is_vendor" defaultChecked={partner.is_vendor} /> Lieferant</label>
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
              <label className="field" style={{ flex: 2 }}>
                <span>Name</span>
                <input name="name" required />
              </label>
              <label className="field">
                <span>Typ</span>
                <Auswahl name="partner_type" defaultValue="contact">
                  <option value="contact">Ansprechpartner</option>
                  <option value="invoice">Rechnungsadresse</option>
                  <option value="delivery">Lieferadresse</option>
                  <option value="other">Sonstige</option>
                </Auswahl>
              </label>
              <label className="field">
                <span>E-Mail</span>
                <input name="email" />
              </label>
              <label className="field">
                <span>Straße</span>
                <input name="street" placeholder="leer = wie Hauptkontakt" />
              </label>
              <label className="field" style={{ maxWidth: 70 }}>
                <span>Nr.</span>
                <input name="house_number" />
              </label>
              <label className="field" style={{ maxWidth: 90 }}>
                <span>PLZ</span>
                <input className="mono" name="zip" />
              </label>
              <label className="field">
                <span>Ort</span>
                <input name="city" />
              </label>
              <div className="shrink field">
                <button type="submit">Anlegen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>

      <div className="grid-2">
        <Card
          title={`Verkaufsaufträge (${orders.length}${orders.length === 10 ? '+' : ''})`}
          actions={
            orders.length === 10 ? (
              <Link className="small" href={`/verkauf?q=${encodeURIComponent(partner.name)}`}>
                alle im Verkauf
              </Link>
            ) : null
          }
          tight
        >
          {orders.length === 0 ? (
            <Empty>Keine Aufträge.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono"><Link href={`/verkauf/${o.id}`}>{o.number}</Link></td>
                      <td><Badge state={o.state} kind="sale" href={`/verkauf/${o.id}`} /></td>
                      <td>
                        {o.state === 'sale' && (
                          <Badge state={o.delivery_status} kind="delivery" href={lieferungHref(o)} />
                        )}
                      </td>
                      <td className="mono nowrap small muted">{date(o.order_date)}</td>
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
                      <td><Badge state={p.state} kind="purchase" href={`/einkauf/${p.id}`} /></td>
                      <td className="mono nowrap small muted">{date(p.order_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title={`Lieferungen & Transfers (${transfers.length}${transfers.length === 10 ? '+' : ''})`} tight>
          {transfers.length === 0 ? (
            <Empty>Keine Transfers.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {transfers.map((t) => {
                    const quelle = herkunftHref(t.origin_model, t.origin_id)
                    return (
                      <tr key={t.id}>
                        <td className="mono">
                          <Link href={`/lager/${t.id}`}>{t.number}</Link>
                          <div className="small muted">{t.type_name}</div>
                        </td>
                        <td className="mono small">
                          {t.origin_label && quelle ? (
                            <Link href={quelle}>{t.origin_label}</Link>
                          ) : (
                            (t.origin_label ?? <span className="muted">—</span>)
                          )}
                        </td>
                        <td><Badge state={t.state} kind="picking" href={`/lager/${t.id}`} /></td>
                        <td className="mono nowrap small muted">{date(t.scheduled_date)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title={`Reparaturen (${reparaturen.length}${reparaturen.length === 10 ? '+' : ''})`} tight>
          {reparaturen.length === 0 ? (
            <Empty>Keine Reparaturen.</Empty>
          ) : (
            <TableWrap>
              <table>
                <tbody>
                  {reparaturen.map((r) => (
                    <tr key={r.id}>
                      <td className="mono"><Link href={`/reparatur/${r.id}`}>{r.number}</Link></td>
                      <td className="small">{r.product}</td>
                      <td><Badge state={r.state} kind="repair" href={`/reparatur/${r.id}`} /></td>
                      <td className="mono nowrap small muted">{date(r.scheduled_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      {vorgaenge.length > 0 && (
        <Card title={`Vorgänge (${vorgaenge.length}${vorgaenge.length === 10 ? '+' : ''})`} tight>
          <TableWrap>
            <table>
              <tbody>
                {vorgaenge.map((v) => (
                  <tr key={v.id}>
                    <td className="mono"><Link href={`/vorgaenge/${v.id}`}>{v.number}</Link></td>
                    <td className="small">
                      <Link href={`/vorgaenge/prozess/${v.prozess_code}`}>{v.prozess_name}</Link>
                    </td>
                    <td>{v.titel ?? <span className="muted">—</span>}</td>
                    <td>
                      <Link
                        className="badge neutral mono"
                        href={`/vorgaenge/prozess/${v.prozess_code}?zustand=${encodeURIComponent(v.state)}`}
                        title="Alle Vorgänge dieses Ablaufs in diesem Zustand"
                      >
                        {v.state}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      <RecordComments model="partner" recordId={id} path={`/kontakte/${id}`} />
    </>
  )
}
