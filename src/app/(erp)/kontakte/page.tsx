import Link from 'next/link'
import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { Schublade } from '@/components/schublade'
import { createPartner } from './actions'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { GroesseBehalten, Seiten } from '@/components/seiten'

export const dynamic = 'force-dynamic'

export default async function KontaktePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; art?: string; seite?: string; pro?: string }>
}) {
  await requireArea('kontakte')
  const params = await searchParams
  const { q, art } = params
  const seite = seitenParameter(params)

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
    select count(*) over () as gesamt, p.id, p.name, p.is_customer, p.is_vendor, p.email, p.city, p.country_code,
           ((select count(*) from sales_orders so where so.partner_id = p.id)
            + (select count(*) from purchase_orders po where po.vendor_id = p.id))::int as orders
    from partners p
    where p.active
      and (${q ?? null}::text is null or p.name ilike ${'%' + (q ?? '') + '%'}
           or coalesce(p.email,'') ilike ${'%' + (q ?? '') + '%'})
      and (${art ?? null}::text is null
           or (${art ?? null} = 'kunden' and p.is_customer)
           or (${art ?? null} = 'lieferanten' and p.is_vendor))
    order by p.name limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(rows)

  return (
    <>
      <PageHeader title="Kontakte" subtitle="Kunden und Lieferanten" actions={
            <Schublade id="neu-kontakt" knopf="+ Neuer Kontakt" titel="Neuer Kontakt">
            <ActionForm action={createPartner}>
              {/* BUG/00013: Personen brauchen Vor- UND Nachname — daraus entsteht
                  der Anzeigename. Firmen tragen genau einen Namen. Welche Felder
                  zählen, entscheidet der Haken „Firma"; geprüft wird das in der
                  Registry-Aktion, nicht nur hier. */}
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Firmenname</span>
                  <input name="name" placeholder="nur bei Firmen" />
                </label>
                <label className="field">
                  <span>Vorname</span>
                  <input name="vorname" placeholder="bei Personen" />
                </label>
                <label className="field">
                  <span>Nachname</span>
                  <input name="nachname" placeholder="bei Personen" />
                </label>
              </div>
              <div className="row">
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
                  <input className="mono" name="vat" />
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
                  <input className="mono" name="zip" />
                </label>
                <label className="field">
                  <span>Ort</span>
                  <input name="city" />
                </label>
                <label className="field">
                  <span>Land</span>
                  <input className="mono" name="country_code" defaultValue="DE" maxLength={2} />
                </label>
              </div>
              <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
                <label className="shrink field"><input type="checkbox" name="is_company" defaultChecked /> Firma</label>
                <label className="shrink field"><input type="checkbox" name="is_customer" defaultChecked /> Kunde</label>
                <label className="shrink field"><input type="checkbox" name="is_vendor" /> Lieferant</label>
              </div>
              <button className="primary" type="submit">Kontakt anlegen</button>
            </ActionForm>

          </Schublade>
        }
      />

      <Card tight>
        <div className="actions" style={{ padding: 12, alignItems: 'flex-end' }}>
          {[
            { key: undefined, label: 'Alle' },
            { key: 'kunden', label: 'Kunden' },
            { key: 'lieferanten', label: 'Lieferanten' },
          ].map((f) => {
            // Aktiver Filter: Akzentkante statt oranger Fläche.
            const aktiv = art === f.key
            return (
              <Link
                key={f.label}
                href={f.key ? `/kontakte?art=${f.key}` : '/kontakte'}
                className="btn small"
                aria-current={aktiv ? 'page' : undefined}
              >
                {f.label}
              </Link>
            )
          })}
          <form style={{ marginLeft: 'auto' }}>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Suche</span>
              <GroesseBehalten params={params} />
              <input type="search" name="q" placeholder="Name oder E-Mail" defaultValue={q ?? ''} style={{ width: 220 }} />
            </label>
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Kontakte gefunden.</Empty>
        ) : (
          <TableWrap karten>
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
                      <span className="actions" style={{ gap: 6 }}>
                        {r.is_customer && <span className="badge info">Kunde</span>}
                        {r.is_vendor && <span className="badge neutral">Lieferant</span>}
                      </span>
                    </td>
                    <td className="small">{r.email ?? <span className="muted">—</span>}</td>
                    <td className="small">
                      {r.city ? (
                        <>
                          {r.city} <span className="mono">({r.country_code})</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{r.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <Seiten pfad="/kontakte" params={params} seite={seite} gesamt={gesamt} />
      </Card>
    </>
  )
}
