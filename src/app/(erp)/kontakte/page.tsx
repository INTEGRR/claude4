import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireArea, requireWrite } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'

export const dynamic = 'force-dynamic'

async function createPartner(formData: FormData) {
  'use server'
  await requireWrite('kontakte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Bitte einen Namen angeben')

  await sql`
    insert into partners (
      name, is_company, is_customer, is_vendor, email, phone,
      street, house_number, zip, city, country_code, vat)
    values (
      ${name},
      ${formData.get('is_company') === 'on'},
      ${formData.get('is_customer') === 'on'},
      ${formData.get('is_vendor') === 'on'},
      ${String(formData.get('email') ?? '') || null},
      ${String(formData.get('phone') ?? '') || null},
      ${String(formData.get('street') ?? '') || null},
      ${String(formData.get('house_number') ?? '') || null},
      ${String(formData.get('zip') ?? '') || null},
      ${String(formData.get('city') ?? '') || null},
      ${String(formData.get('country_code') ?? 'DE')},
      ${String(formData.get('vat') ?? '') || null})`

  revalidatePath('/kontakte')
}

export default async function KontaktePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; art?: string }>
}) {
  await requireArea('kontakte')
  const { q, art } = await searchParams

  const rows = await sql<
    {
      id: string
      name: string
      is_customer: boolean
      is_vendor: boolean
      email: string | null
      city: string | null
      country_code: string
      orders: number
    }[]
  >`
    select p.id, p.name, p.is_customer, p.is_vendor, p.email, p.city, p.country_code,
           ((select count(*) from sales_orders so where so.partner_id = p.id)
            + (select count(*) from purchase_orders po where po.vendor_id = p.id))::int as orders
    from partners p
    where p.active
      and (${q ?? null}::text is null or p.name ilike ${'%' + (q ?? '') + '%'}
           or coalesce(p.email,'') ilike ${'%' + (q ?? '') + '%'})
      and (${art ?? null}::text is null
           or (${art ?? null} = 'kunden' and p.is_customer)
           or (${art ?? null} = 'lieferanten' and p.is_vendor))
    order by p.name limit 300`

  return (
    <>
      <PageHeader title="Kontakte" subtitle="Kunden und Lieferanten" />

      <Card title="Neuer Kontakt">
        <ActionForm action={createPartner}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Name</span>
              <input name="name" required />
            </label>
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" placeholder="für Bestellungen nötig" />
            </label>
            <label className="field">
              <span>Telefon</span>
              <input name="phone" />
            </label>
            <label className="field">
              <span>USt-ID</span>
              <input name="vat" />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Straße</span>
              <input name="street" />
            </label>
            <label className="field">
              <span>Hausnummer</span>
              <input name="house_number" placeholder="für DHL nötig" />
            </label>
            <label className="field">
              <span>PLZ</span>
              <input name="zip" />
            </label>
            <label className="field">
              <span>Ort</span>
              <input name="city" />
            </label>
            <label className="field">
              <span>Land</span>
              <input name="country_code" defaultValue="DE" maxLength={2} />
            </label>
          </div>
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <label className="shrink"><input type="checkbox" name="is_company" defaultChecked /> Firma</label>
            <label className="shrink"><input type="checkbox" name="is_customer" defaultChecked /> Kunde</label>
            <label className="shrink"><input type="checkbox" name="is_vendor" /> Lieferant</label>
          </div>
          <button className="primary" type="submit">Kontakt anlegen</button>
        </ActionForm>
      </Card>

      <Card tight>
        <div style={{ padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { key: undefined, label: 'Alle' },
            { key: 'kunden', label: 'Kunden' },
            { key: 'lieferanten', label: 'Lieferanten' },
          ].map((f) => (
            <Link
              key={f.label}
              href={f.key ? `/kontakte?art=${f.key}` : '/kontakte'}
              className={`btn small${art === f.key ? ' primary' : ''}`}
            >
              {f.label}
            </Link>
          ))}
          <form style={{ marginLeft: 'auto' }}>
            <input type="search" name="q" placeholder="Suchen" defaultValue={q ?? ''} style={{ width: 220 }} />
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Kontakte gefunden.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Rolle</th>
                  <th>E-Mail</th>
                  <th>Ort</th>
                  <th className="num">Belege</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/kontakte/${r.id}`}>{r.name}</Link></td>
                    <td>
                      {r.is_customer && <span className="badge info" style={{ marginRight: 4 }}>Kunde</span>}
                      {r.is_vendor && <span className="badge neutral">Lieferant</span>}
                    </td>
                    <td className="small">{r.email ?? <span className="muted">—</span>}</td>
                    <td className="small">{r.city ? `${r.city} (${r.country_code})` : '—'}</td>
                    <td className="num">{r.orders}</td>
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
