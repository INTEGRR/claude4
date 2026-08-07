import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, Stat, TableWrap } from '@/components/ui'
import { barcodeSvg } from '@/modules/shared/barcode'
import { dateTime, qty } from '@/modules/shared/format'
import { setVariantCodes } from '../../actions'
import { RecordComments } from '@/components/record-comments'

export const dynamic = 'force-dynamic'

export default async function VariantPage({ params }: { params: Promise<{ id: string }> }) {
  await requireArea('produkte')
  const { id } = await params

  const [variant] = await sql<
    {
      id: string
      template_id: string
      product: string
      display_name: string | null
      sku: string | null
      barcode: string | null
      shopify_variant_id: string | null
      uom: string
      on_hand: number
      free: number
      incoming: number
      outgoing: number
      forecasted: number
    }[]
  >`
    select pv.id, pv.template_id, pt.name as product, pv.display_name, pv.sku, pv.barcode,
           pv.shopify_variant_id, u.name as uom,
           on_hand_qty(pv.id) as on_hand, free_to_use(pv.id) as free,
           incoming_qty(pv.id) as incoming, outgoing_qty(pv.id) as outgoing,
           forecasted_qty(pv.id) as forecasted
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = pt.uom_id
    where pv.id = ${id}`

  if (!variant) notFound()

  const moves = await sql<
    {
      id: string
      qty_done: number
      src: string
      dest: string
      date_done: string
      reference: string | null
      picking_number: string | null
      picking_id: string | null
      mo_number: string | null
      mo_id: string | null
    }[]
  >`
    select m.id, m.qty_done, src.full_path as src, dst.full_path as dest, m.date_done, m.reference,
           p.number as picking_number, p.id as picking_id,
           mo.number as mo_number, mo.id as mo_id
    from stock_moves m
    join stock_locations src on src.id = m.src_location_id
    join stock_locations dst on dst.id = m.dest_location_id
    left join stock_pickings p on p.id = m.picking_id
    left join manufacturing_orders mo on mo.id = m.production_id
    where m.variant_id = ${id} and m.state = 'done'
    order by m.date_done desc limit 60`

  const label = variant.display_name ?? variant.product
  const codeValue = variant.barcode ?? variant.sku

  return (
    <>
      <PageHeader
        title={label}
        subtitle={
          <Link href={`/produkte/${variant.template_id}`}>zum Produkt {variant.product}</Link>
        }
      />

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Bestand" value={`${qty(variant.on_hand)} ${variant.uom}`} />
        <Stat label="Frei verfügbar" value={qty(variant.free)} hint="abzüglich Reservierungen" />
        <Stat
          label="Prognose"
          value={qty(variant.forecasted)}
          hint={
            <>
              {Number(variant.forecasted) < 0 && (
                <>
                  <span className="led warn" /> Unterdeckung ·{' '}
                </>
              )}
              {`+${qty(variant.incoming)} eingehend / −${qty(variant.outgoing)} ausgehend`}
            </>
          }
        />
      </div>

      <div className="grid-2">
        <Card title="Kennzeichnung">
          <ActionForm action={setVariantCodes.bind(null, id)}>
            <label className="field" style={{ marginBottom: 4 }}>
              <span>Artikelnummer (SKU)</span>
              <input name="sku" className="mono" defaultValue={variant.sku ?? ''} />
            </label>
            <div className="small muted" style={{ marginBottom: 12 }}>
              muss der Shopify-SKU entsprechen
            </div>
            <label className="field" style={{ marginBottom: 4 }}>
              <span>Barcode</span>
              <input name="barcode" className="mono" defaultValue={variant.barcode ?? ''} />
            </label>
            <div className="small muted" style={{ marginBottom: 12 }}>
              EAN oder frei
            </div>
            <label className="field">
              <span>Shopify-Varianten-ID</span>
              <input
                name="shopify_variant_id"
                className="mono"
                defaultValue={variant.shopify_variant_id ?? ''}
                placeholder="gid://shopify/ProductVariant/…"
              />
            </label>
            <button className="primary" type="submit">Speichern</button>
          </ActionForm>
        </Card>

        <Card title="Etikett" actions={codeValue && <span className="mono-label">zum Drucken scannen</span>}>
          {codeValue ? (
            <div className="display-panel">
              <div className="display-head">
                <span>Etikett</span>
                <span>{codeValue}</span>
              </div>
              {/* Der Barcode kommt schwarz auf transparent. Er sitzt daher auf
                  einem hellen Feld (--display-bright ist in beiden Themes gleich),
                  damit die Striche kontrastreich und scannbar bleiben. */}
              <div
                style={{
                  textAlign: 'center',
                  background: 'var(--display-bright)',
                  padding: 12,
                  borderRadius: 'var(--radius-sm)',
                }}
                dangerouslySetInnerHTML={{ __html: barcodeSvg(codeValue) }}
              />
            </div>
          ) : (
            <Empty>Hinterlege eine Artikelnummer oder einen Barcode, dann erscheint hier das Etikett.</Empty>
          )}
        </Card>
      </div>

      <Card title="Bewegungen" tight>
        {moves.length === 0 ? (
          <Empty>Noch keine Bewegungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Von → Nach</th>
                  <th className="num">Menge</th>
                  <th>Beleg</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td className="nowrap small mono">{dateTime(m.date_done)}</td>
                    <td className="small muted mono">{m.src} → {m.dest}</td>
                    <td className="num">{qty(m.qty_done)}</td>
                    <td className="mono small">
                      {m.picking_id ? (
                        <Link href={`/lager/${m.picking_id}`}>{m.picking_number}</Link>
                      ) : m.mo_id ? (
                        <Link href={`/fertigung/${m.mo_id}`}>{m.mo_number}</Link>
                      ) : (
                        <span className="muted">{m.reference ?? '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
      <RecordComments model="product_variant" recordId={id} path={`/produkte/variante/${id}`} />
    </>
  )
}
