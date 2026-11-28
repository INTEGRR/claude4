import Link from 'next/link'
import { requireArea } from '@/modules/auth'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { dateTime, qty } from '@/modules/shared/format'
import { applyCount, createCount, deleteCount } from '../actions'
import { Auswahl } from '@/components/auswahl'

export const dynamic = 'force-dynamic'

export default async function InventurPage({
  searchParams,
}: {
  searchParams: Promise<{ alle?: string }>
}) {
  await requireArea('lager')
  // Standard: nur Lagerware. Varianten, die erst auf Bestellung gebaut werden
  // (Tastaturen), haben selten Bestand und verstopfen die Suche — auf Wunsch dazu.
  const alle = (await searchParams).alle === '1'
  const counts = await sql<
    {
      id: string
      product: string
      location: string
      counted_qty: number
      book_qty: number
      current_qty: number
      applied_at: string | null
      applied_by: string | null
    }[]
  >`
    select c.id, variant_display_name(c.variant_id) as product, l.full_path as location,
           c.counted_qty, c.book_qty, c.applied_at, c.applied_by,
           coalesce((select on_hand from stock_quants q
                      where q.location_id = c.location_id and q.variant_id = c.variant_id), 0) as current_qty
    from inventory_counts c
    join stock_locations l on l.id = c.location_id
    order by c.applied_at nulls first, c.created_at desc
    limit 100`

  // Artikelnummer und Barcode reisen als Suchtext mit — gezählt wird mit der Nummer in der Hand.
  const variants = await sql<{ id: string; label: string; sku: string | null; suche: string; on_hand: number }[]>`
    select pv.id, variant_display_name(pv.id) as label, nullif(pv.sku, '') as sku,
           pt.name || ' ' || coalesce(pv.sku, '') || ' ' || coalesce(pv.barcode, '') as suche,
           on_hand_qty(pv.id) as on_hand
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.active and pt.active and pt.type = 'goods'
      and (${alle} or not ist_made_to_order(pv.id))
    order by label limit 500`

  const open = counts.filter((c) => !c.applied_at)
  const applied = counts.filter((c) => c.applied_at)

  return (
    <>
      <PageHeader
        title="Inventur"
        subtitle="Gezählte Mengen erfassen und buchen — die Differenz läuft gegen den Inventurdifferenz-Ort"
      />

      <Card title="Zählung erfassen">
        <ActionForm action={createCount}>
          <div className="row">
            <label className="field" style={{ flex: 3 }}>
              <span>Produkt</span>
              <Auswahl nachladen={alle ? 'variante-ware' : 'variante-lager'} name="variant_id" required defaultValue="">
                <option value="" disabled>— auswählen —</option>
                {variants.map((v) => (
                  <option key={v.id} value={v.id} data-suche={v.suche}>
                    {v.label}{v.sku ? ` · ${v.sku}` : ''} (Bestand: {qty(v.on_hand)})
                  </option>
                ))}
              </Auswahl>
            </label>
            <label className="field">
              <span>Gezählte Menge</span>
              <input type="number" name="counted_qty" step="0.001" min="0" required />
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Erfassen</button>
            </div>
          </div>
        </ActionForm>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Suche nach Name, Artikelnummer oder Barcode — Schreibweise und Reihenfolge der Wörter sind egal.{' '}
          {alle ? (
            <>Gezeigt werden alle Artikel. <Link href="/lager/inventur">Nur Lagerware zeigen</Link></>
          ) : (
            <>
              Ausgeblendet sind Varianten, die erst auf Bestellung gebaut werden (Tastaturen).{' '}
              <Link href="/lager/inventur?alle=1">Auch diese zeigen</Link>
            </>
          )}
        </p>
      </Card>

      <Card title={`Offene Zählungen (${open.length})`} tight>
        {open.length === 0 ? (
          <Empty>Keine offenen Zählungen.</Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Lagerort</th>
                  <th className="num">Buchbestand</th>
                  <th className="num">Gezählt</th>
                  <th className="num">Differenz</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {open.map((c) => {
                  const diff = Number(c.counted_qty) - Number(c.book_qty)
                  const changed = Number(c.current_qty) !== Number(c.book_qty)
                  return (
                    <tr key={c.id}>
                      <td>{c.product}</td>
                      <td className="small muted mono">{c.location}</td>
                      <td className="num">{qty(c.book_qty)}</td>
                      <td className="num">{qty(c.counted_qty)}</td>
                      <td className="num">
                        <span className="mono">
                          {diff > 0 ? '+' : ''}
                          {qty(diff)}
                        </span>
                        <div className="small muted nowrap">
                          <span className={diff === 0 ? 'led off' : diff > 0 ? 'led ok' : 'led warn'} />{' '}
                          {diff === 0 ? 'keine Differenz' : diff > 0 ? 'Überschuss' : 'Fehlmenge'}
                        </div>
                      </td>
                      <td className="num">
                        <div className="actions" style={{ justifyContent: 'flex-end' }}>
                          {changed && (
                            <span className="small muted nowrap" title="Bestand hat sich seit der Zählung geändert">
                              <span className="led warn" /> Bestand geändert — jetzt{' '}
                              <span className="mono">{qty(c.current_qty)}</span>
                            </span>
                          )}
                          <ActionButton className="small primary" action={applyCount.bind(null, c.id)}>
                            Buchen
                          </ActionButton>
                          <ActionButton className="small" action={deleteCount.bind(null, c.id)}>
                            Verwerfen
                          </ActionButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {applied.length > 0 && (
        <Card title="Gebuchte Zählungen" tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th className="num">Vorher</th>
                  <th className="num">Gezählt</th>
                  <th>Gebucht</th>
                  <th>Von</th>
                </tr>
              </thead>
              <tbody>
                {applied.slice(0, 30).map((c) => (
                  <tr key={c.id}>
                    <td>{c.product}</td>
                    <td className="num muted">{qty(c.book_qty)}</td>
                    <td className="num">{qty(c.counted_qty)}</td>
                    <td className="nowrap small mono">{dateTime(c.applied_at)}</td>
                    <td className="small">{c.applied_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </>
  )
}
