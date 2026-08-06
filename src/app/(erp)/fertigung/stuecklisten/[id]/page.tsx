import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { addBomLine, removeBomLine, setBomConsumption } from '../../actions'
import { RecordComments } from '@/components/record-comments'

export const dynamic = 'force-dynamic'

export default async function BomPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ variante?: string }>
}) {
  await requireArea('fertigung')
  const { id } = await params
  const { variante } = await searchParams

  const [bom] = await sql<
    {
      id: string
      template_id: string
      product: string
      variant: string | null
      qty: number
      uom: string
      consumption: string
    }[]
  >`
    select b.id, b.template_id, pt.name as product,
           case when b.variant_id is not null then variant_display_name(b.variant_id) end as variant,
           b.qty, u.name as uom, b.consumption
    from boms b
    join product_templates pt on pt.id = b.template_id
    join uoms u on u.id = b.uom_id
    where b.id = ${id}`

  if (!bom) notFound()

  const lines = await sql<
    {
      id: string
      component: string
      sku: string | null
      qty: number
      uom: string
      filters: string[]
    }[]
  >`
    select l.id, variant_display_name(l.component_variant_id) as component, pv.sku, l.qty,
           u.name as uom,
           coalesce(array_agg(a.name || ': ' || av.name order by a.name)
                    filter (where av.id is not null), '{}') as filters
    from bom_lines l
    join product_variants pv on pv.id = l.component_variant_id
    join uoms u on u.id = l.uom_id
    left join bom_line_variant_filters f on f.bom_line_id = l.id
    left join product_template_attribute_values ptav on ptav.id = f.ptav_id
    left join product_attribute_values av on av.id = ptav.value_id
    left join product_template_attribute_lines al on al.id = ptav.line_id
    left join product_attributes a on a.id = al.attribute_id
    where l.bom_id = ${id}
    group by l.id, pv.sku, u.name, l.sequence
    order by l.sequence`

  // Attributwerte des Endprodukts - die Auswahl für "Auf Varianten anwenden".
  const ptavs = await sql<{ id: string; label: string }[]>`
    select ptav.id, a.name || ': ' || av.name as label
    from product_template_attribute_lines al
    join product_attributes a on a.id = al.attribute_id
    join product_template_attribute_values ptav on ptav.line_id = al.id
    join product_attribute_values av on av.id = ptav.value_id
    where al.template_id = ${bom.template_id}
    order by al.sequence, av.sequence`

  const variants = await sql<{ id: string; label: string }[]>`
    select id, coalesce(display_name, '(ohne Varianten)') as label
    from product_variants where template_id = ${bom.template_id} and active
    order by display_name`

  // Vorschau: welche Positionen gelten für die gewählte Variante?
  const preview = variante
    ? await sql<{ component: string; qty: number; uom: string; available: number }[]>`
        select variant_display_name(c.component_variant_id) as component, c.qty,
               u.name as uom, free_to_use(c.component_variant_id) as available
        from bom_components_for_variant(${id}, ${variante}) c
        join uoms u on u.id = c.uom_id
        order by c.sequence`
    : []

  const components = await sql<{ id: string; label: string }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) ||
           coalesce(' · ' || pv.sku, '') as label
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.id <> ${bom.template_id}
    order by label limit 500`

  return (
    <>
      <PageHeader
        title={`Stückliste ${bom.product}`}
        subtitle={
          <>
            Referenzmenge {qty(bom.qty)} {bom.uom}
            {bom.variant && <> · gilt nur für {bom.variant}</>}
            {!bom.variant && <> · gilt für alle Varianten</>}
          </>
        }
        actions={<Link className="btn" href="/fertigung/stuecklisten">Zur Übersicht</Link>}
      />

      {ptavs.length > 0 && (
        <div className="notice info">
          Dieses Produkt hat Varianten. Positionen ohne Auswahl bei „Auf Varianten anwenden" gelten für{' '}
          <strong>alle</strong> Varianten; mit Auswahl nur für die passenden — so kommt z. B. das weiße
          Gehäuse nur in die weiße Tastatur.
        </div>
      )}

      <Card
        title="Positionen"
        actions={
          <ActionForm action={setBomConsumption.bind(null, id)}>
            <div className="row">
              <select name="consumption" defaultValue={bom.consumption} style={{ width: 220 }}>
                <option value="warning">Abweichender Verbrauch: Warnung</option>
                <option value="allowed">Abweichender Verbrauch: erlaubt</option>
                <option value="blocked">Abweichender Verbrauch: gesperrt</option>
              </select>
              <div className="shrink">
                <button className="small" type="submit">Speichern</button>
              </div>
            </div>
          </ActionForm>
        }
        tight
      >
        {lines.length === 0 ? (
          <Empty>Noch keine Komponenten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Komponente</th>
                  <th>Artikelnr.</th>
                  <th className="num">Menge</th>
                  <th>Einheit</th>
                  <th>Auf Varianten anwenden</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.component}</td>
                    <td className="mono small">{l.sku ?? '—'}</td>
                    <td className="num">{qty(l.qty)}</td>
                    <td>{l.uom}</td>
                    <td>
                      {l.filters.length === 0 ? (
                        <span className="muted small">alle Varianten</span>
                      ) : (
                        l.filters.map((f) => (
                          <span key={f} className="badge info" style={{ marginRight: 4 }}>{f}</span>
                        ))
                      )}
                    </td>
                    <td className="num">
                      <ActionButton className="small danger" action={removeBomLine.bind(null, id, l.id)}>
                        Entfernen
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          <ActionForm action={addBomLine.bind(null, id)}>
            <div className="row">
              <label className="field" style={{ flex: 3 }}>
                <span>Komponente</span>
                <select name="component_variant_id" required defaultValue="">
                  <option value="" disabled>— auswählen —</option>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Menge</span>
                <input type="number" name="qty" step="0.001" min="0.001" defaultValue={1} required />
              </label>
              {ptavs.length > 0 && (
                <label className="field" style={{ flex: 2 }}>
                  <span>Auf Varianten anwenden (leer = alle)</span>
                  <select name="ptav_ids" multiple size={Math.min(ptavs.length, 4)}>
                    {ptavs.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="shrink field">
                <button className="primary" type="submit">Hinzufügen</button>
              </div>
            </div>
          </ActionForm>
        </div>
      </Card>

      {variants.length > 0 && (
        <Card title="Vorschau je Variante">
          <form style={{ marginBottom: 12 }}>
            <div className="row">
              <label className="field" style={{ maxWidth: 320 }}>
                <span>Variante</span>
                <select name="variante" defaultValue={variante ?? ''}>
                  <option value="">— auswählen —</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </label>
              <div className="shrink field">
                <button type="submit">Anzeigen</button>
              </div>
            </div>
          </form>

          {variante &&
            (preview.length === 0 ? (
              <Empty>Für diese Variante gelten keine Positionen.</Empty>
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Komponente</th>
                      <th className="num">Menge</th>
                      <th>Einheit</th>
                      <th className="num">Frei verfügbar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p, i) => (
                      <tr key={i}>
                        <td>{p.component}</td>
                        <td className="num">{qty(p.qty)}</td>
                        <td>{p.uom}</td>
                        <td className="num">
                          {Number(p.available) >= Number(p.qty) ? (
                            <span className="badge success">{qty(p.available)}</span>
                          ) : (
                            <span className="badge warn">{qty(p.available)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            ))}
        </Card>
      )}
      <RecordComments model="bom" recordId={id} path={`/fertigung/stuecklisten/${id}`} />
    </>
  )
}
