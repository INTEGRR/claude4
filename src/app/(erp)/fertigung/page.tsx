import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { createMo } from './actions'
import { FertigungBulk } from './bulk'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function FertigungPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; produkt?: string; material?: string; auftrag?: string }>
}) {
  await requireArea('fertigung')
  const { status, produkt: produktRoh, material, auftrag: auftragRoh } = await searchParams
  // Das GET-Formular schickt produkt= auch leer mit — ''::uuid wäre ein 500.
  const produkt = produktRoh || undefined
  const nurStartbare = material === 'bereit'
  // Filter „Fertigung zum Auftrag" (Querverweis vom Verkauf, „N offen"):
  // nur gültige UUIDs, sonst wäre Unsinn in der Adresszeile ein 500.
  const auftrag = auftragRoh && UUID.test(auftragRoh) ? auftragRoh : undefined
  const [auftragKopf] = auftrag
    ? await sql<{ id: string; number: string; shopify_order_name: string | null }[]>`
        select id, number, shopify_order_name from sales_orders where id = ${auftrag}`
    : []

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
      template_id: string
      lieferung_id: string | null
      lieferung_number: string | null
      missing: number
    }[]
  >`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as product,
           mo.qty_to_produce, mo.qty_produced, mo.state, mo.scheduled_date,
           so.number as sales_order_number, so.id as sales_order_id,
           pv.template_id, lf.id as lieferung_id, lf.number as lieferung_number,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done','cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id
    left join sales_orders so on so.id = mo.sales_order_id
    -- Die Lieferung, auf die der Auftrag wartet: die offene zuerst, sonst
    -- die jüngste (Index origin_model/origin_id).
    left join lateral (
      select sp.id, sp.number
      from stock_pickings sp
      join operation_types ot on ot.id = sp.operation_type_id and ot.kind = 'delivery'
      where sp.origin_model = 'sales_order' and sp.origin_id = so.id
      order by (sp.state in ('done', 'cancel')), sp.scheduled_date desc
      limit 1
    ) lf on true
    where (${status ?? null}::text is null or mo.state = ${status ?? null}::mo_state)
      and (${produkt ?? null}::uuid is null or mo.variant_id = ${produkt ?? null}::uuid)
      and (${auftrag ?? null}::uuid is null or mo.sales_order_id = ${auftrag ?? null}::uuid)
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

  // Adresse mit den übrigen Filtern — Produkt, Material und Auftrag bleiben
  // beim Umschalten des Status erhalten.
  const filterHref = (f: { status?: string; auftrag?: string }) => {
    const params = new URLSearchParams()
    if (f.status) params.set('status', f.status)
    if (produkt) params.set('produkt', produkt)
    if (nurStartbare) params.set('material', 'bereit')
    if (f.auftrag) params.set('auftrag', f.auftrag)
    const query = params.toString()
    return query ? `/fertigung?${query}` : '/fertigung'
  }

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
              <Auswahl name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </Auswahl>
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

      {auftrag && (
        <div className="notice info">
          <span className="led" style={{ background: 'var(--info)' }} /> Gefiltert auf Auftrag{' '}
          {auftragKopf ? (
            <Link className="mono" href={`/verkauf/${auftragKopf.id}`}>
              {auftragKopf.number}
              {auftragKopf.shopify_order_name ? ` · ${auftragKopf.shopify_order_name}` : ''}
            </Link>
          ) : (
            <span className="muted">(nicht gefunden)</span>
          )}
          {' '}·{' '}
          <Link href={filterHref({ status })}>Filter aufheben</Link>
        </div>
      )}

      <Card tight>
        {/* Filter: der aktive Zustand wird von der LED getragen, nicht von einer
            orangen Fläche — der Akzent bleibt der Primärtaste vorbehalten.
            Produkt/Material bleiben in den Status-Links erhalten. */}
        <div className="actions" style={{ padding: 12, flexWrap: 'wrap' }}>
          {filters.map((f) => {
            return (
              <Link
                key={f.label}
                href={filterHref({ status: f.key, auftrag })}
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
            {auftrag && <input type="hidden" name="auftrag" value={auftrag} />}
            <Auswahl name="produkt" defaultValue={produkt ?? ''} aria-label="Nach Produkt filtern">
              <option value="">Alle Produkte</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </Auswahl>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" name="material" value="bereit" defaultChecked={nurStartbare} />
              <span>nur startbare</span>
            </label>
            <button className="small" type="submit">Filtern</button>
          </form>
        </div>

        {gefiltert.length === 0 ? (
          <Empty>
            Keine Fertigungsaufträge{nurStartbare ? ' mit vollständigem Material' : ''}
            {auftrag ? ' zu diesem Auftrag' : ''}.
          </Empty>
        ) : (
          <TableWrap>
            <FertigungBulk rows={gefiltert} />
          </TableWrap>
        )}
      </Card>
    </>
  )
}
