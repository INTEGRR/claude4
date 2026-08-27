import { requireArea } from '@/modules/auth'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { barcodeSvg, code128 } from '@/modules/shared/barcode'
import { PrintButton } from '@/components/print-button'
import { date, qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/** Beschrifteter Barcode — zwei nackte Code128 sind am Tisch nicht unterscheidbar. */
function CodeBlock({ svg, label }: { svg: string; label: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        className="barcode"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

/**
 * Druckbeleg für die Werkstatt UND den Packtisch: Kopfdaten mit zwei
 * beschrifteten Barcodes — FERTIGUNG (schließt am Scanner die Produktion
 * ab) und VERSAND (öffnet am Packtisch die Lieferung des Auftrags) —,
 * dazu der Artikel-Code des Erzeugnisses und die eingefrorene,
 * variantengefilterte Komponentenliste zum Abhaken. Der Zettel wandert
 * mit der Ware bis zum Packtisch (docs/module/versand.md).
 */
export default async function MoPrintPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('fertigung')
  const { id } = await params

  const [mo] = await sql<
    {
      number: string
      product: string
      sku: string | null
      barcode: string | null
      qty_to_produce: number
      uom: string
      scheduled_date: string
      state: string
      sales_order_id: string | null
      sales_order_number: string | null
      shopify_order_name: string | null
      customer: string | null
      note: string | null
    }[]
  >`
    select mo.number, variant_display_name(mo.variant_id) as product, pv.sku, pv.barcode,
           mo.qty_to_produce, u.name as uom, mo.scheduled_date, mo.state,
           mo.sales_order_id, so.number as sales_order_number, so.shopify_order_name,
           p.name as customer, mo.note
    from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id
    join uoms u on u.id = mo.uom_id
    left join sales_orders so on so.id = mo.sales_order_id
    left join partners p on p.id = so.partner_id
    where mo.id = ${id}`

  if (!mo) notFound()

  // Die Lieferung des Auftrags — deren Nummer wird am Packtisch gescannt.
  // Jüngstes nicht storniertes Delivery-Picking; Lagerfertigung ohne
  // Auftrag hat keins, dann entfällt der zweite Barcode.
  const [lieferung] = mo.sales_order_id
    ? await sql<{ number: string }[]>`
        select p.number from stock_pickings p
        join operation_types ot on ot.id = p.operation_type_id
        where p.origin_model = 'sales_order' and p.origin_id = ${mo.sales_order_id}
          and ot.kind = 'delivery' and p.state <> 'cancel'
        order by p.created_at desc limit 1`
    : []

  const components = await sql<
    { id: string; product: string; sku: string | null; qty: number; uom: string }[]
  >`
    select m.id, variant_display_name(m.variant_id) as product, pv.sku, m.qty, u.name as uom
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join uoms u on u.id = m.uom_id
    where m.production_id = ${id} and m.reference = 'Komponentenverbrauch'
      and m.state <> 'cancel'
    order by m.created_at`

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  const fertigungCode = code128(mo.number)
  const versandCode = lieferung ? code128(lieferung.number) : null
  const artikelCode = mo.barcode || mo.sku ? barcodeSvg(mo.barcode ?? mo.sku ?? '', { height: 9, scale: 2 }) : null

  return (
    <>
      <div className="print-doc">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
          <div>
            <h1>Fertigungsauftrag {mo.number}</h1>
            <div style={{ fontSize: 13 }}>{company?.name}</div>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            <CodeBlock svg={fertigungCode} label="FERTIGUNG" />
            {versandCode && <CodeBlock svg={versandCode} label="VERSAND" />}
          </div>
        </div>

        <table style={{ marginTop: 16, marginBottom: 20 }}>
          <tbody>
            <tr>
              <th style={{ width: '25%' }}>Produkt</th>
              <td>
                {mo.product}
                {mo.sku && <span style={{ color: '#555' }}> · {mo.sku}</span>}
              </td>
            </tr>
            {artikelCode && (
              <tr>
                <th>Artikel-Code</th>
                <td>
                  {/* Wird am Packtisch je gepacktem Stück gescannt — derselbe
                      Code klebt auch auf dem fertigen Artikel. */}
                  <span
                    className="barcode"
                    aria-label={`Artikel ${mo.barcode ?? mo.sku}`}
                    dangerouslySetInnerHTML={{ __html: artikelCode }}
                  />
                </td>
              </tr>
            )}
            <tr>
              <th>Menge</th>
              <td style={{ fontSize: 16, fontWeight: 700 }}>
                {qty(mo.qty_to_produce)} {mo.uom}
              </td>
            </tr>
            <tr>
              <th>Termin</th>
              <td>{date(mo.scheduled_date)}</td>
            </tr>
            {mo.sales_order_number && (
              <tr>
                <th>Verkaufsauftrag</th>
                <td>
                  {mo.sales_order_number}
                  {mo.shopify_order_name && ` (${mo.shopify_order_name})`}
                  {mo.customer && ` · ${mo.customer}`}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginBottom: 6 }}>Komponenten</h2>
        <table>
          <thead>
            <tr>
              <th style={{ width: 34 }}>✓</th>
              <th>Komponente</th>
              <th>Artikelnr.</th>
              <th style={{ textAlign: 'right', width: 90 }}>Menge</th>
              <th style={{ width: 70 }}>Einheit</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td style={{ textAlign: 'center' }}>☐</td>
                <td>{c.product}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{c.sku ?? '—'}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{qty(c.qty)}</td>
                <td>{c.uom}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {mo.note && (
          <div style={{ marginTop: 20, fontSize: 12 }}>
            <strong>Notizen:</strong> {mo.note}
          </div>
        )}

        <div style={{ marginTop: 32, display: 'flex', gap: 40, fontSize: 12 }}>
          <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Gefertigt von / Datum</div>
          <div style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 4 }}>Geprüft von / Datum</div>
        </div>
      </div>

      <div className="print-actions no-print">
        <PrintButton />
        <a className="btn" href={`/fertigung/${id}`}>Zurück zum Auftrag</a>
      </div>
    </>
  )
}
