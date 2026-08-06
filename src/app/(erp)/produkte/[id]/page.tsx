import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { addAttribute, updateProduct } from '../actions'
import { RecordComments } from '@/components/record-comments'

export const dynamic = 'force-dynamic'

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('produkte')
  const { id } = await params

  const [tpl] = await sql<
    {
      id: string
      name: string
      uom_id: string
      purchase_uom_id: string | null
      list_price: number
      standard_cost: number
      weight_g: number
      invoice_policy: string
      bill_policy: string
      can_be_sold: boolean
      can_be_purchased: boolean
      route_buy: boolean
      route_manufacture: boolean
      route_mto: boolean
      uom: string
    }[]
  >`
    select pt.*, u.name as uom from product_templates pt
    join uoms u on u.id = pt.uom_id where pt.id = ${id}`

  if (!tpl) notFound()

  const variants = await sql<
    { id: string; display_name: string | null; sku: string | null; barcode: string | null; on_hand: number }[]
  >`
    select id, display_name, sku, barcode, on_hand_qty(id) as on_hand
    from product_variants where template_id = ${id} and active order by display_name`

  const attributes = await sql<{ attribute: string; values: string[] }[]>`
    select a.name as attribute,
           array_agg(av.name order by av.sequence) as values
    from product_template_attribute_lines al
    join product_attributes a on a.id = al.attribute_id
    join product_template_attribute_values ptav on ptav.line_id = al.id
    join product_attribute_values av on av.id = ptav.value_id
    where al.template_id = ${id}
    group by a.name, al.sequence order by al.sequence`

  const allAttributes = await sql<{ id: string; name: string }[]>`
    select id, name from product_attributes order by name`

  const attributeValues = await sql<{ id: string; attribute_id: string; label: string }[]>`
    select av.id, av.attribute_id, a.name || ': ' || av.name as label
    from product_attribute_values av join product_attributes a on a.id = av.attribute_id
    order by a.name, av.sequence`

  const uoms = await sql<{ id: string; name: string }[]>`
    select u.id, u.name from uoms u
    join uom_categories c on c.id = u.category_id
    where u.active and c.id = (select category_id from uoms where id = ${tpl.uom_id})
    order by u.ratio`

  const boms = await sql<{ id: string; lines: number }[]>`
    select b.id, (select count(*) from bom_lines l where l.bom_id = b.id)::int as lines
    from boms b where b.template_id = ${id} and b.active`

  return (
    <>
      <PageHeader
        title={tpl.name}
        subtitle={`${variants.length} Variante(n) · Einheit ${tpl.uom}`}
        actions={
          boms.length > 0 ? (
            <Link className="btn" href={`/fertigung/stuecklisten/${boms[0].id}`}>
              Stückliste ({boms[0].lines} Positionen)
            </Link>
          ) : tpl.route_manufacture ? (
            <Link className="btn primary" href="/fertigung/stuecklisten">Stückliste anlegen</Link>
          ) : null
        }
      />

      <Card title="Eigenschaften">
        <ActionForm action={updateProduct.bind(null, id)}>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Name</span>
              <input name="name" defaultValue={tpl.name} required />
            </label>
            <label className="field">
              <span>Verkaufspreis</span>
              <input type="number" name="list_price" step="0.01" defaultValue={tpl.list_price} />
            </label>
            <label className="field">
              <span>Einkaufspreis (Standard)</span>
              <input type="number" name="standard_cost" step="0.01" defaultValue={tpl.standard_cost} />
            </label>
            <label className="field">
              <span>Gewicht (g)</span>
              <input type="number" name="weight_g" step="1" defaultValue={tpl.weight_g} />
            </label>
            <label className="field">
              <span>Einkaufseinheit</span>
              <select name="purchase_uom_id" defaultValue={tpl.purchase_uom_id ?? ''}>
                <option value="">wie Lagereinheit</option>
                {uoms.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Abrechnung Verkauf</span>
              <select name="invoice_policy" defaultValue={tpl.invoice_policy}>
                <option value="order">nach bestellter Menge</option>
                <option value="delivery">nach gelieferter Menge</option>
              </select>
            </label>
            <label className="field">
              <span>Abrechnung Einkauf</span>
              <select name="bill_policy" defaultValue={tpl.bill_policy}>
                <option value="received">nach erhaltener Menge</option>
                <option value="ordered">nach bestellter Menge</option>
              </select>
            </label>
          </div>
          <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
            <label className="shrink">
              <input type="checkbox" name="can_be_sold" defaultChecked={tpl.can_be_sold} /> Verkaufbar
            </label>
            <label className="shrink">
              <input type="checkbox" name="can_be_purchased" defaultChecked={tpl.can_be_purchased} /> Einkaufbar
            </label>
            <label className="shrink">
              <input type="checkbox" name="route_buy" defaultChecked={tpl.route_buy} /> Route: Einkaufen
            </label>
            <label className="shrink">
              <input type="checkbox" name="route_manufacture" defaultChecked={tpl.route_manufacture} /> Route: Fertigen
            </label>
            <label className="shrink">
              <input type="checkbox" name="route_mto" defaultChecked={tpl.route_mto} /> Route: Auf Bestellung (MTO)
            </label>
          </div>
          <button className="primary" type="submit">Speichern</button>
        </ActionForm>

        {tpl.route_manufacture && tpl.route_mto && boms.length === 0 && (
          <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>
            Route „Fertigen auf Bestellung" ist aktiv, aber es existiert keine Stückliste. Ohne
            Stückliste entsteht bei der Auftragsbestätigung kein Fertigungsauftrag.
          </div>
        )}
      </Card>

      <Card title="Attribute & Varianten">
        {attributes.length > 0 && (
          <TableWrap>
            <table style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Attribut</th>
                  <th>Werte</th>
                </tr>
              </thead>
              <tbody>
                {attributes.map((a) => (
                  <tr key={a.attribute}>
                    <td>{a.attribute}</td>
                    <td>
                      {a.values.map((v) => (
                        <span key={v} className="badge neutral" style={{ marginRight: 4 }}>{v}</span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <ActionForm action={addAttribute.bind(null, id)}>
          <div className="row">
            <label className="field">
              <span>Attribut</span>
              <select name="attribute_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {allAttributes.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Werte (Mehrfachauswahl)</span>
              <select name="value_ids" multiple size={5} required>
                {attributeValues.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Varianten erzeugen</button>
            </div>
          </div>
        </ActionForm>
        {allAttributes.length === 0 && (
          <div className="notice info" style={{ marginBottom: 0 }}>
            Noch keine Attribute definiert. Lege sie unter <Link href="/produkte/attribute">Attribute</Link> an.
          </div>
        )}
      </Card>

      <Card title={`Varianten (${variants.length})`} tight>
        {variants.length === 0 ? (
          <Empty>Keine Varianten.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Variante</th>
                  <th>Artikelnummer</th>
                  <th>Barcode</th>
                  <th className="num">Bestand</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link href={`/produkte/variante/${v.id}`}>{v.display_name ?? tpl.name}</Link>
                    </td>
                    <td className="mono small">{v.sku ?? <span className="muted">—</span>}</td>
                    <td className="mono small">{v.barcode ?? <span className="muted">—</span>}</td>
                    <td className="num">{qty(v.on_hand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <RecordComments model="product_template" recordId={id} path={`/produkte/${id}`} />
    </>
  )
}
