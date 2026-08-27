import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { barcodeSvg, code128 } from '@/modules/shared/barcode'
import { PrintButton } from '@/components/print-button'
import { qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Packzettel für eine Lieferung — das Gegenstück zum Fertigungszettel für
 * Bestellungen ohne Fertigung: der VERSAND-Barcode öffnet die Lieferung
 * am Packtisch, die Positionsliste trägt je Zeile den Artikel-Code zum
 * Gegenscannen. Dient zugleich als Kommissionierbeleg
 * (docs/module/versand.md).
 */
export default async function PackzettelPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('lager')
  const { id } = await params

  const [picking] = await sql<
    {
      number: string
      state: string
      kind: string
      origin_label: string | null
      sales_order_number: string | null
      shopify_order_name: string | null
      customer: string | null
      ship_name: string | null
      ship_street: string | null
      ship_house_number: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
    }[]
  >`
    select p.number, p.state, ot.kind, p.origin_label,
           so.number as sales_order_number, so.shopify_order_name,
           pa.name as customer,
           so.ship_name, so.ship_street, so.ship_house_number,
           so.ship_zip, so.ship_city, so.ship_country_code
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners pa on pa.id = so.partner_id
    where p.id = ${id}`

  if (!picking) notFound()

  const lines = await sql<
    { id: string; product: string; sku: string | null; barcode: string | null; qty: number; uom: string }[]
  >`
    select m.id, variant_display_name(m.variant_id) as product, pv.sku, pv.barcode,
           m.qty, u.name as uom
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join uoms u on u.id = m.uom_id
    where m.picking_id = ${id} and m.state <> 'cancel'
    order by m.created_at`

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  const versandCode = code128(picking.number)

  return (
    <>
      <div className="print-doc">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
          <div>
            <h1>Packzettel {picking.number}</h1>
            <div style={{ fontSize: 13 }}>{company?.name}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              className="barcode"
              aria-label={`Versand ${picking.number}`}
              dangerouslySetInnerHTML={{ __html: versandCode }}
            />
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 2 }}>
              VERSAND
            </div>
          </div>
        </div>

        <table style={{ marginTop: 16, marginBottom: 20 }}>
          <tbody>
            {picking.sales_order_number && (
              <tr>
                <th style={{ width: '25%' }}>Auftrag</th>
                <td>
                  {picking.sales_order_number}
                  {picking.shopify_order_name && ` (${picking.shopify_order_name})`}
                  {picking.customer && ` · ${picking.customer}`}
                </td>
              </tr>
            )}
            {!picking.sales_order_number && picking.origin_label && (
              <tr>
                <th style={{ width: '25%' }}>Herkunft</th>
                <td>{picking.origin_label}</td>
              </tr>
            )}
            {picking.ship_name && (
              <tr>
                <th>Lieferadresse</th>
                <td>
                  {picking.ship_name}
                  {' · '}
                  {picking.ship_street} {picking.ship_house_number}, {picking.ship_zip}{' '}
                  {picking.ship_city}
                  {picking.ship_country_code && picking.ship_country_code !== 'DE'
                    ? ` (${picking.ship_country_code})`
                    : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginBottom: 6 }}>Positionen</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34 }}>✓</th>
              <th>Artikel</th>
              <th>Artikel-Code</th>
              <th style={{ textAlign: 'right', width: 90 }}>Menge</th>
              <th style={{ width: 70 }}>Einheit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td style={{ textAlign: 'center' }}>☐</td>
                <td>{l.product}</td>
                <td>
                  {l.barcode || l.sku ? (
                    <span
                      className="barcode"
                      aria-label={`Artikel ${l.barcode ?? l.sku}`}
                      dangerouslySetInnerHTML={{
                        __html: barcodeSvg(l.barcode ?? l.sku ?? '', { height: 8, scale: 2 }),
                      }}
                    />
                  ) : (
                    '—'
                  )}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty(l.qty)}</td>
                <td>{l.uom}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 32, display: 'flex', gap: 40, fontSize: 12 }}>
          <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Gepackt von / Datum</div>
        </div>
      </div>

      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href={`/lager/${id}`}>Zurück zur Lieferung</a>
      </div>
    </>
  )
}
