import { requireArea } from '@/modules/auth'
import { canAccess, canWrite } from '@/modules/auth/permissions'
import Link from 'next/link'
import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { Schublade } from '@/components/schublade'
import { money, qty } from '@/modules/shared/format'
import { createProduct, setShopProjekt } from './actions'
import { Auswahl } from '@/components/auswahl'
import { gesamtAus, seitenParameter } from '@/modules/shared/seiten'
import { GroesseBehalten, Seiten } from '@/components/seiten'

export const dynamic = 'force-dynamic'

export default async function ProduktePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; seite?: string; pro?: string }>
}) {
  const user = await requireArea('produkte')
  const params = await searchParams
  const { q } = params
  const seite = seitenParameter(params)
  const darf = canWrite(user.rollen, 'produkte', user.befugnisse)

  const rows = await sql<
    {
      id: string
      name: string
      uom: string
      list_price: number
      variants: number
      on_hand: number
      has_bom: boolean
      route_manufacture: boolean
      route_buy: boolean
      projekt: string | null
    }[]
  >`
    select count(*) over () as gesamt, pt.id, pt.name, u.name as uom, pt.list_price,
           (select count(*) from product_variants pv where pv.template_id = pt.id and pv.active)::int as variants,
           coalesce((select sum(on_hand_qty(pv.id)) from product_variants pv
                      where pv.template_id = pt.id and pv.active), 0) as on_hand,
           exists (select 1 from boms b where b.template_id = pt.id and b.active) as has_bom,
           pt.route_manufacture, pt.route_buy, pt.projekt
    from product_templates pt
    join uoms u on u.id = pt.uom_id
    where pt.active
      and (${q ?? null}::text is null or pt.name ilike ${'%' + (q ?? '') + '%'}
           or pt.projekt ilike ${'%' + (q ?? '') + '%'})
    order by pt.name limit ${seite.limit} offset ${seite.offset}`
  const gesamt = gesamtAus(rows)

  const uoms = await sql<{ id: string; name: string; category: string }[]>`
    select u.id, u.name, c.name as category from uoms u
    join uom_categories c on c.id = u.category_id
    where u.active order by c.name, u.ratio`

  return (
    <>
      <PageHeader
        title="Produkte"
        subtitle="Produktvorlagen mit Attributen und Varianten"
        actions={<>
            <Link className="btn" href="/p/artikel_anlegen">Anlage-Assistent</Link>
            <Link className="btn" href="/produkte/attribute">Attribute</Link>
            {/* Kategorien, Steuern, Zahlungsbedingungen: Einstellungen → Stammdaten (nur Admin). */}
            {canAccess(user.rollen, 'einstellungen', user.befugnisse) && (
              <Link className="btn" href="/einstellungen/stammdaten">Kategorien &amp; Steuern</Link>
            )}
            <Schublade id="neu-produkt" knopf="+ Neues Produkt" titel="Neues Produkt">
              <ActionForm action={createProduct}>
                <div className="row">
                  <label className="field" style={{ flex: 3 }}>
                    <span>Name</span>
                    <input name="name" required placeholder="z. B. Tastatur" />
                  </label>
                  <label className="field">
                    <span>Artikelnummer</span>
                    <input name="sku" className="mono" placeholder="optional" />
                  </label>
                  <label className="field">
                    <span>Einheit</span>
                    <Auswahl name="uom_id" required defaultValue={uoms.find((u) => u.name === 'Stück')?.id}>
                      {uoms.map((u) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.category})</option>
                      ))}
                    </Auswahl>
                  </label>
                  <label className="field">
                    <span>Verkaufspreis</span>
                    <input type="number" name="list_price" step="0.01" defaultValue={0} />
                  </label>
                  <label className="field">
                    <span>Gewicht (g)</span>
                    <input type="number" name="weight_g" step="1" defaultValue={0} />
                  </label>
                </div>
                <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
                  <label className="shrink"><input type="checkbox" name="can_be_sold" defaultChecked /> Verkaufbar</label>
                  <label className="shrink"><input type="checkbox" name="can_be_purchased" /> Einkaufbar</label>
                  <label className="shrink"><input type="checkbox" name="route_buy" /> Route: Einkaufen</label>
                  <label className="shrink"><input type="checkbox" name="route_manufacture" /> Route: Fertigen</label>
                  <label className="shrink"><input type="checkbox" name="route_mto" /> Route: Auf Bestellung (MTO)</label>
                </div>
                <button className="primary" type="submit">Produkt anlegen</button>
              </ActionForm>
  
            </Schublade>
          </>}
      />

      <Card tight>
        <div style={{ padding: 12 }}>
          <form className="row" style={{ maxWidth: 420 }}>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Suche</span>
              <GroesseBehalten params={params} />
              <input type="search" name="q" placeholder="Produkt oder Shop-Projekt" defaultValue={q ?? ''} />
            </label>
            <div className="shrink field">
              <button type="submit">Suchen</button>
            </div>
          </form>
        </div>

        {rows.length === 0 ? (
          <Empty>Keine Produkte gefunden.</Empty>
        ) : (
          // Eine Form um die Tabelle: Produkte anhaken und allen auf einmal
          // dasselbe Shop-Projekt geben (2026-11-27) — statt einzeln in der Shop-Verfügbarkeit.
          <ActionForm action={setShopProjekt}>
            {darf && (
              <div className="actions" style={{ padding: '0 12px 12px' }}>
                <span className="mono-label">Für angehakte</span>
                <input name="projekt" placeholder="Shop-Projekt, z. B. NATIVE 1800" aria-label="Shop-Projekt" style={{ width: 260 }} />
                <button type="submit" className="small">Shop-Projekt setzen</button>
                <span className="small muted">Leer lassen entfernt das Projekt.</span>
              </div>
            )}
            <TableWrap karten>
              <table>
                <thead>
                  <tr>
                    {darf && <th style={{ width: 32 }} aria-label="Auswahl" />}
                    <th>Name</th>
                    <th>Shop-Projekt</th>
                    <th className="num">Varianten</th>
                    <th className="num">Bestand</th>
                    <th>Einheit</th>
                    <th className="num">Preis</th>
                    <th>Beschaffung</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      {darf && (
                        <td>
                          <input type="checkbox" name="template_id" value={r.id} aria-label={`${r.name} auswählen`} />
                        </td>
                      )}
                      <td><Link href={`/produkte/${r.id}`}>{r.name}</Link></td>
                      <td className="small">{r.projekt ?? <span className="muted">—</span>}</td>
                      <td className="num">{r.variants}</td>
                      <td className="num">{qty(r.on_hand)}</td>
                      <td className="mono small">{r.uom}</td>
                      <td className="num">{money(r.list_price)}</td>
                      <td>
                        <span className="actions">
                          {r.route_manufacture && (
                            <span className={`badge ${r.has_bom ? 'info' : 'warn'}`}>
                              {r.has_bom ? 'Fertigung' : 'Fertigung ohne Stückliste'}
                            </span>
                          )}
                          {r.route_buy && <span className="badge neutral">Einkauf</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </ActionForm>
        )}
        <Seiten pfad="/produkte" params={params} seite={seite} gesamt={gesamt} />
      </Card>
    </>
  )
}
