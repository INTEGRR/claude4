import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { LABELS, date } from '@/modules/shared/format'
import { createRepair } from './actions'

export const dynamic = 'force-dynamic'

const ZUSTAENDE = Object.keys(LABELS.repair) as (keyof typeof LABELS.repair)[]

export default async function ReparaturPage({
  searchParams,
}: {
  searchParams: Promise<{ zustand?: string }>
}) {
  await requireArea('reparatur')
  const { zustand } = await searchParams
  const filter = ZUSTAENDE.find((z) => z === zustand) ?? null

  const rows = await sql<
    {
      id: string
      number: string
      customer: string
      product: string
      state: string
      under_warranty: boolean
      scheduled_date: string
      received_at: string | null
      origin_label: string | null
      parts: number
    }[]
  >`
    select r.id, r.number, p.name as customer, variant_display_name(r.variant_id) as product,
           r.state, r.under_warranty, r.scheduled_date, r.received_at, r.origin_label,
           (select count(*) from repair_parts rp where rp.repair_id = r.id)::int as parts
    from repair_orders r
    join partners p on p.id = r.partner_id
    where ${filter ? sql`r.state = ${filter}::repair_state` : sql`true`}
    order by
      case r.state
        when 'received' then 0 when 'under_repair' then 1 when 'confirmed' then 2
        when 'awaiting_device' then 3 when 'new' then 4 when 'repaired' then 5 else 6 end,
      r.scheduled_date desc
    limit 200`

  const partners = await sql<{ id: string; name: string }[]>`
    select id, name from partners where is_customer and active order by name limit 500`

  const products = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active order by label limit 500`

  return (
    <>
      <PageHeader
        title="Reparaturen"
        subtitle="Reparaturaufträge mit Teileverbrauch — Ersatzteile verlassen das Lager, ausgebaute Teile werden entsorgt oder wiederverwendet"
        actions={
          <>
            <Link className="btn" href="/vorgaenge/prozess/reparatur_anfrage">Reparaturanfragen</Link>
            <Link className="btn" href="/lager/zulauf">Zulauf</Link>
          </>
        }
      />

      <Card title="Neuer Reparaturauftrag">
        <ActionForm action={createRepair}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Kunde</span>
              <select name="partner_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Produkt</span>
              <select name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Menge</span>
              <input type="number" name="qty" step="1" min="1" defaultValue={1} />
            </label>
            <div className="shrink field">
              <label className="shrink" style={{ display: 'block', marginBottom: 8 }}>
                <input type="checkbox" name="under_warranty" /> <span className="mono-label">Garantie</span>
              </label>
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
          <label className="field">
            <span>Fehlerbeschreibung</span>
            <textarea name="note" rows={2} placeholder="z. B. Taste klemmt, Switch defekt" />
          </label>
        </ActionForm>
      </Card>

      <Card tight>
        {/* Filter als Links: die Adresszeile ist der Filterzustand. */}
        <div className="actions" style={{ padding: '10px 12px 0', flexWrap: 'wrap', gap: 6 }}>
          <Link className={`btn small${filter ? '' : ' primary'}`} href="/reparatur">alle</Link>
          {ZUSTAENDE.map((z) => (
            <Link
              key={z}
              className={`btn small${filter === z ? ' primary' : ''}`}
              href={`/reparatur?zustand=${z}`}
            >
              {LABELS.repair[z]}
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <Empty>Keine Reparaturaufträge{filter ? ` im Zustand „${LABELS.repair[filter]}"` : ''}.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nummer</th>
                  <th>Kunde</th>
                  <th>Produkt</th>
                  <th className="num">Teile</th>
                  <th>Status</th>
                  <th>Abrechnung</th>
                  <th>Eingang</th>
                  <th>Termin</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">
                      <Link href={`/reparatur/${r.id}`}>{r.number}</Link>
                      {r.origin_label && <span className="muted small"> · {r.origin_label}</span>}
                    </td>
                    <td>{r.customer}</td>
                    <td>{r.product}</td>
                    <td className="num">{r.parts}</td>
                    <td><Badge state={r.state} kind="repair" /></td>
                    <td>
                      {r.under_warranty ? (
                        <span className="badge success">Garantie</span>
                      ) : (
                        <span className="badge neutral">kostenpflichtig</span>
                      )}
                    </td>
                    <td className="mono nowrap">{r.received_at ? date(r.received_at) : '—'}</td>
                    <td className="mono nowrap">{date(r.scheduled_date)}</td>
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
