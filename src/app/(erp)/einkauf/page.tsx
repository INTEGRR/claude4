import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { date, money } from '@/modules/shared/format'
import { createPurchaseOrder } from './actions'
import { belegLink } from './querverweise'
import { Auswahl } from '@/components/auswahl'
import { kurzLieferant } from '@/app/(erp)/kurzanlage'

export const dynamic = 'force-dynamic'

export default async function EinkaufPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const user = await requireArea('einkauf')
  const { filter } = await searchParams

  const rows = await sql<
    {
      id: string
      number: string
      state: string
      vendor_id: string
      vendor: string
      order_deadline: string | null
      expected_arrival: string | null
      billing_status: string
      gross: number
      late: boolean
      projekt_id: string | null
      projekt_nummer: string | null
      receipt_ids: string[]
      bill_ids: string[]
    }[]
  >`
    select po.id, po.number, po.state, po.vendor_id, p.name as vendor, po.order_deadline, po.expected_arrival,
           po.billing_status, t.gross,
           (po.order_deadline is not null and po.order_deadline < now()
            and po.state in ('draft','sent')) as late,
           po.einkaufsprojekt_id as projekt_id, ep.nummer as projekt_nummer,
           -- Querverweise (Belege hinter den Schildern): Wareneingänge und Rechnungen.
           array(select sp.id from stock_pickings sp
                 where sp.origin_model = 'purchase_order' and sp.origin_id = po.id
                   and sp.state <> 'cancel'
                 order by sp.created_at) as receipt_ids,
           array(select vb.id from vendor_bills vb
                 where vb.purchase_order_id = po.id and vb.state <> 'cancel'
                 order by vb.created_at) as bill_ids
    from purchase_orders po
    join partners p on p.id = po.vendor_id
    left join einkaufsprojekte ep on ep.id = po.einkaufsprojekt_id
    cross join lateral purchase_order_total(po.id) t
    order by po.created_at desc
    limit 200`

  const filtered =
    filter === 'to_send'
      ? rows.filter((r) => r.state === 'draft')
      : filter === 'waiting'
        ? rows.filter((r) => r.state === 'sent')
        : filter === 'late'
          ? rows.filter((r) => r.late)
          : rows

  const vendors = await sql<{ id: string; name: string }[]>`
    select id, name from partners where is_vendor and active order by name limit 500`

  // Belegsignal folgt dem Prozessschritt: ist der Rechnungsschritt für diese
  // Firma abgeschaltet (Abrechnung läuft extern), verschwindet die Spalte
  // „Rechnung erwartet" — die Daten bleiben und kämen beim Wieder-Einschalten
  // sofort zurück.
  const [{ rechnung_aktiv: rechnungAktiv }] = await sql<{ rechnung_aktiv: boolean }[]>`
    select prozessschritt_aktiv('einkauf_wareneingang_rechnung', 'rechnung') as rechnung_aktiv`

  // Zähler getrennt vom Text, damit die Zahl in Mono gesetzt werden kann.
  const filters: { key?: string; label: string; count?: number }[] = [
    { key: undefined, label: 'Alle' },
    { key: 'to_send', label: 'Zu senden', count: rows.filter((r) => r.state === 'draft').length },
    { key: 'waiting', label: 'Wartend', count: rows.filter((r) => r.state === 'sent').length },
    { key: 'late', label: 'Verspätet', count: rows.filter((r) => r.late).length },
  ]

  return (
    <>
      <PageHeader
        title="Bestellungen"
        subtitle="Angebotsanfragen und Bestellungen bei Lieferanten"
        actions={<Link className="btn" href="/einkauf/rechnungen">Rechnungen</Link>}
      />

      <Card title="Neue Bestellung">
        <ActionForm action={createPurchaseOrder}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Lieferant</span>
              <Auswahl kurzanlage={kurzLieferant(user)} name="vendor_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </Auswahl>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        {vendors.length === 0 && (
          <div className="notice warn" style={{ marginBottom: 0 }}>
            Noch keine Lieferanten. Lege einen unter <Link href="/kontakte">Kontakte</Link> an.
          </div>
        )}
      </Card>

      <Card tight>
        <div className="actions" style={{ padding: 12 }}>
          {filters.map((f) => {
            // Der aktive Filter bekommt eine schmale Akzentkante statt einer
            // orangen Fläche — die Primärtaste bleibt das einzige Orange.
            const aktiv = filter === f.key
            return (
              <Link
                key={f.label}
                href={f.key ? `/einkauf?filter=${f.key}` : '/einkauf'}
                className="btn small"
                aria-current={aktiv ? 'page' : undefined}
                style={
                  aktiv
                    ? {
                        background: 'var(--surface-2)',
                        borderLeft: '2px solid var(--accent)',
                        fontWeight: 600,
                      }
                    : undefined
                }
              >
                {f.label}
                {f.count !== undefined && <span className="mono">({f.count})</span>}
              </Link>
            )
          })}
        </div>

        {filtered.length === 0 ? (
          <Empty>Keine Bestellungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Lieferant</th>
                  <th>Status</th>
                  {rechnungAktiv && <th>Abrechnung</th>}
                  <th>Erwartet</th>
                  <th className="num">Summe</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <span className="actions" style={{ gap: 6 }}>
                        <Link href={`/einkauf/${r.id}`}>{r.number}</Link>
                        {r.late && (
                          <>
                            {/* Einziger echter Alarmzustand der Liste: LED plus Wort. */}
                            <span className="led on" />
                            <span className="badge danger">verspätet</span>
                          </>
                        )}
                      </span>
                      {r.projekt_id && (
                        <div className="small">
                          <Link className="muted" href={`/einkauf/projekte/${r.projekt_id}`}>{r.projekt_nummer}</Link>
                        </div>
                      )}
                    </td>
                    <td>
                      <Link href={`/einkauf/lieferanten/${r.vendor_id}`}>{r.vendor}</Link>
                    </td>
                    <td>
                      {/* Bestellt → der Wareneingang dahinter (einer direkt, mehrere an der Bestellung). */}
                      <Badge
                        state={r.state}
                        kind="purchase"
                        href={belegLink(r.receipt_ids, (x) => `/lager/${x}`, `/einkauf/${r.id}#wareneingaenge`) ?? `/einkauf/${r.id}`}
                        title={r.receipt_ids.length > 0 ? 'Wareneingang öffnen' : 'Bestellung öffnen'}
                      />
                    </td>
                    {rechnungAktiv && (
                      <td>
                        <Badge
                          state={r.billing_status}
                          kind="billing"
                          href={belegLink(r.bill_ids, (x) => `/einkauf/rechnungen/${x}`, `/einkauf/${r.id}#rechnungen`) ?? `/einkauf/${r.id}#rechnungen`}
                          title={r.bill_ids.length > 0 ? 'Rechnung öffnen' : 'Rechnungen der Bestellung'}
                        />
                      </td>
                    )}
                    <td className="mono nowrap">{date(r.expected_arrival)}</td>
                    <td className="num nowrap">{money(r.gross)}</td>
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
