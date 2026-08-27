import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { createMo } from './actions'
import { FertigungBulk } from './bulk'

export const dynamic = 'force-dynamic'

export default async function FertigungPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; produkt?: string; material?: string }>
}) {
  await requireArea('fertigung')
  const { status, produkt: produktRoh, material } = await searchParams
  // Das GET-Formular schickt produkt= auch leer mit — ''::uuid wäre ein 500.
  const produkt = produktRoh || undefined
  const nurStartbare = material === 'bereit'

  const rows = await sql<
    {
      id: string
      number: string
      product: string
      qty_to_produce: number
      qty_produced: number
      state: string
      scheduled_date: string
      sales_order_number: string | null
      sales_order_id: string | null
      missing: number
    }[]
  >`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as product,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date,
           so.number as sales_order_number, so.id as sales_order_id,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done','cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    left join sales_orders so on so.id = mo.sales_order_id
    where (${status ?? null}::text is null or mo.state = ${status ?? null}::mo_state)
      and (${produkt ?? null}::uuid is null or mo.variant_id = ${produkt ?? null}::uuid)
    order by
      case mo.state when 'progress' then 0 when 'confirmed' then 1 when 'draft' then 2 else 3 end,
      mo.scheduled_date
    limit 200`

  // „Nur startbare": bestätigt UND Material vollständig reserviert — die
  // Auswahlmenge des Bulk-Starts (BUG/00003).
  const gefiltert = nurStartbare
    ? rows.filter((r) => r.state === 'confirmed' && r.missing === 0)
    : rows

  const products = await sql<{ id: string; label: string }[]>`
    select distinct pv.id, coalesce(pv.display_name, pt.name) as label
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and resolve_bom(pv.id) is not null
    order by label limit 300`

  const filters = [
    { key: undefined, label: 'Alle' },
    { key: 'confirmed', label: 'Bestätigt' },
    { key: 'progress', label: 'In Bearbeitung' },
    { key: 'done', label: 'Erledigt' },
  ]

  return (
    <>
      <PageHeader
        title="Fertigungsaufträge"
        subtitle="Aufträge aus dem Verkauf (MTO) und manuell angelegte Aufträge"
        actions={<Link className="btn" href="/fertigung/demontage">Demontage</Link>}
      />

      <Card title="Neuer Fertigungsauftrag">
        <ActionForm action={createMo}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt (nur Produkte mit Stückliste)</span>
              <select name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Menge</span>
              <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
        {products.length === 0 && (
          <div className="notice warn" style={{ marginBottom: 0 }}>
            Es gibt noch kein Produkt mit Stückliste. Lege zuerst eine unter{' '}
            <Link href="/fertigung/stuecklisten">Stücklisten</Link> an.
          </div>
        )}
      </Card>

      <Card tight>
        {/* Filter: der aktive Zustand wird von der LED getragen, nicht von einer
            orangen Fläche — der Akzent bleibt der Primärtaste vorbehalten.
            Produkt/Material bleiben in den Status-Links erhalten. */}
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {filters.map((f) => {
            const params = new URLSearchParams()
            if (f.key) params.set('status', f.key)
            if (produkt) params.set('produkt', produkt)
            if (nurStartbare) params.set('material', 'bereit')
            const query = params.toString()
            return (
              <Link
                key={f.label}
                href={query ? `/fertigung?${query}` : '/fertigung'}
                className="btn small"
                aria-current={status === f.key ? 'page' : undefined}
              >
                <span className={`led ${status === f.key ? 'on' : 'off'}`} />
                {f.label}
              </Link>
            )
          })}
          <form method="get" className="actions" style={{ gap: 8 }}>
            {status && <input type="hidden" name="status" value={status} />}
            <select name="produkt" defaultValue={produkt ?? ''} aria-label="Nach Produkt filtern">
              <option value="">Alle Produkte</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" name="material" value="bereit" defaultChecked={nurStartbare} />
              <span>nur startbare</span>
            </label>
            <button className="small" type="submit">Filtern</button>
          </form>
        </div>

        {gefiltert.length === 0 ? (
          <Empty>Keine Fertigungsaufträge{nurStartbare ? ' mit vollständigem Material' : ''}.</Empty>
        ) : (
          <TableWrap>
            <FertigungBulk rows={gefiltert} />
          </TableWrap>
        )}
      </Card>
    </>
  )
}
