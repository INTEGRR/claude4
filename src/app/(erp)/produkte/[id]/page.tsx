import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'
import { addAttribute, addVendorPrice, deleteVendorPrice, produktZuShopify, updateProduct } from '../actions'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { KLEINPAKET } from '@/modules/versand/regeln-logik'
import { RecordComments } from '@/components/record-comments'
import { TagEditor } from '@/components/tag-editor'

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
      category_id: string
      sale_delay: number
      hs_code: string | null
      country_of_origin: string | null
      sale_tax_id: string | null
      purchase_tax_id: string | null
      description_sale: string | null
      description_purchase: string | null
      description_picking: string | null
      responsible_id: string | null
      kleinpaket: boolean
      platzbedarf: number
    }[]
  >`
    select pt.*, u.name as uom from product_templates pt
    join uoms u on u.id = pt.uom_id where pt.id = ${id}`

  if (!tpl) notFound()

  const categories = await sql<{ id: string; full_path: string }[]>`
    select id, full_path from product_categories order by full_path`
  const taxes = await sql<{ id: string; name: string; type_tax_use: string }[]>`
    select id, name, type_tax_use from taxes where active order by type_tax_use, sequence`
  const benutzer = await sql<{ id: string; name: string }[]>`
    select id, name from users where active order by name`

  const variants = await sql<
    {
      id: string
      display_name: string | null
      sku: string | null
      barcode: string | null
      on_hand: number
      shopify_variant_id: string | null
    }[]
  >`
    select id, display_name, sku, barcode, on_hand_qty(id) as on_hand, shopify_variant_id
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

  // Lieferanten-Preisliste mit Staffeln: je Zeile eine Mindestmenge (MOQ) —
  // die Beschaffung empfiehlt Mengen ab der MOQ und zieht den Staffelpreis.
  const lieferantenpreise = await sql<
    {
      id: string
      vendor: string
      min_qty: number
      price: number
      discount: number
      netto: number
      lead_time_days: number
      date_start: string | null
      date_end: string | null
    }[]
  >`
    select vp.id, p.name as vendor, vp.min_qty, vp.price, vp.discount,
           vendor_price_net(vp.price, vp.discount) as netto,
           vp.lead_time_days, vp.date_start::text, vp.date_end::text
    from vendor_prices vp
    join partners p on p.id = vp.vendor_id
    where vp.template_id = ${id}
    order by p.name, vp.min_qty`

  const lieferanten = await sql<{ id: string; name: string }[]>`
    select id, name from partners where is_vendor and active order by name limit 500`

  return (
    <>
      <PageHeader
        title={tpl.name}
        subtitle={
          <>
            {variants.length} Variante(n) · Einheit <span className="mono">{tpl.uom}</span>
          </>
        }
        actions={
          <>
            {shopifyConfigured() &&
              (variants.some((v) => v.shopify_variant_id) ? (
                <span className="mono-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span className="led ok" />
                  im Shop
                </span>
              ) : tpl.can_be_sold ? (
                <ActionButton
                  action={produktZuShopify.bind(null, id)}
                  confirm="Produkt mit allen Varianten in Shopify anlegen? Es erscheint dort sofort als aktives Produkt."
                >
                  In Shopify anlegen
                </ActionButton>
              ) : null)}
            {boms.length > 0 ? (
            <Link className="btn" href={`/fertigung/stuecklisten/${boms[0].id}`}>
              Stückliste ({boms[0].lines} Positionen)
            </Link>
            ) : tpl.route_manufacture ? (
              <Link className="btn" href="/fertigung/stuecklisten">Stückliste anlegen</Link>
            ) : null}
          </>
        }
      />

      <div style={{ marginBottom: 12 }}>
        <TagEditor model="product_template" recordId={id} path={`/produkte/${id}`} />
      </div>

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
          <div className="row">
            <label className="field">
              <span>Kategorie</span>
              <select name="category_id" defaultValue={tpl.category_id}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.full_path}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Steuer Verkauf</span>
              <select name="sale_tax_id" defaultValue={tpl.sale_tax_id ?? ''}>
                <option value="">keine</option>
                {taxes.filter((t) => t.type_tax_use === 'sale').map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Steuer Einkauf</span>
              <select name="purchase_tax_id" defaultValue={tpl.purchase_tax_id ?? ''}>
                <option value="">keine</option>
                {taxes.filter((t) => t.type_tax_use === 'purchase').map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Lieferzeit an Kunden (Tage)</span>
              <input type="number" name="sale_delay" step="1" min="0" defaultValue={tpl.sale_delay} />
            </label>
            <label className="field">
              <span>Verantwortlich</span>
              <select name="responsible_id" defaultValue={tpl.responsible_id ?? ''}>
                <option value="">—</option>
                {benutzer.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Rückverfolgung</span>
              <select name="tracking" defaultValue={(tpl as { tracking?: string }).tracking ?? 'none'}>
                <option value="none">keine</option>
                <option value="lot">Losnummern (Chargen)</option>
                <option value="serial">Seriennummern</option>
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span>Zolltarifnummer (HS-Code)</span>
              <input name="hs_code" defaultValue={tpl.hs_code ?? ''} placeholder="für DHL-Auslandsversand" />
            </label>
            <label className="field">
              <span>Ursprungsland</span>
              <input
                name="country_of_origin"
                defaultValue={tpl.country_of_origin ?? ''}
                maxLength={2}
                placeholder="z. B. DE"
              />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Belegtext Verkauf</span>
              <input name="description_sale" defaultValue={tpl.description_sale ?? ''} />
            </label>
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field shrink" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" name="kleinpaket" defaultChecked={tpl.kleinpaket} />
              <span>passt ins DHL Kleinpaket (35,5 × 25 × 8 cm, bis 1 kg)</span>
            </label>
            <label className="field shrink">
              <span>Platzbedarf je Stück</span>
              <input
                type="number"
                name="platzbedarf"
                min={0.01}
                step={0.1}
                defaultValue={tpl.platzbedarf}
                style={{ width: 90 }}
              />
            </label>
            <div className="muted small field" style={{ flex: 2 }}>
              <strong>1 = ein volles Kleinpaket</strong> ({KLEINPAKET.maxLengthMm / 10} ×{' '}
              {KLEINPAKET.maxWidthMm / 10} × {KLEINPAKET.maxHeightMm / 10} cm) — zwei Stück je
              Kleinpaket sind also 0,5, eine Tastatur etwa 3. Daraus wählt der Versand die Kartonage.
              Fürs Kleinpaket zählt die ganze Lieferung:{' '}
              <strong>eine einzige nicht markierte Position genügt</strong>, und es wird ein Paket;
              über {KLEINPAKET.maxWeightG} g inklusive Karton ist ohnehin Schluss.
            </div>
          </div>
          <details style={{ marginBottom: 12 }}>
            <summary className="mono-label" style={{ cursor: 'pointer' }}>
              Weitere Belegtexte (Einkauf, Lieferschein)
            </summary>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="field">
                <span>Belegtext Einkauf</span>
                <input name="description_purchase" defaultValue={tpl.description_purchase ?? ''} />
              </label>
              <label className="field">
                <span>Belegtext Lieferschein</span>
                <input name="description_picking" defaultValue={tpl.description_picking ?? ''} />
              </label>
            </div>
          </details>
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
            <span className="led warn" />{' '}
            Route „Fertigen auf Bestellung" ist aktiv, aber es existiert keine Stückliste. Ohne
            Stückliste entsteht bei der Auftragsbestätigung kein Fertigungsauftrag.
          </div>
        )}
      </Card>

      {/* Preisliste je Lieferant — sichtbar, sobald das Produkt einkaufbar
          ist oder Zeilen existieren (Daten verschwinden nicht mit dem Haken). */}
      {(tpl.can_be_purchased || lieferantenpreise.length > 0) && (
        <Card title="Lieferantenpreise & Staffeln">
          {lieferantenpreise.length > 0 && (
            <TableWrap>
              <table style={{ marginBottom: 16 }}>
                <thead>
                  <tr>
                    <th>Lieferant</th>
                    <th className="num">ab Menge (MOQ)</th>
                    <th className="num">Preis</th>
                    <th className="num">Rabatt</th>
                    <th className="num">Netto</th>
                    <th className="num">Lieferzeit</th>
                    <th>Gültig</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lieferantenpreise.map((z) => (
                    <tr key={z.id}>
                      <td>{z.vendor}</td>
                      <td className="num mono">{qty(z.min_qty)}</td>
                      <td className="num mono">{Number(z.price).toFixed(2)} €</td>
                      <td className="num">{Number(z.discount) > 0 ? `${qty(z.discount)} %` : '—'}</td>
                      <td className="num mono">{Number(z.netto).toFixed(2)} €</td>
                      <td className="num">{z.lead_time_days > 0 ? `${z.lead_time_days} Tage` : '—'}</td>
                      <td className="small muted nowrap">
                        {z.date_start || z.date_end
                          ? `${z.date_start ?? '…'} – ${z.date_end ?? '…'}`
                          : 'unbegrenzt'}
                      </td>
                      <td className="num">
                        <ActionButton
                          className="small danger"
                          action={deleteVendorPrice.bind(null, id, z.id)}
                          confirm="Diese Preiszeile löschen?"
                        >
                          Löschen
                        </ActionButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}

          <ActionForm action={addVendorPrice.bind(null, id)}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 2 }}>
                <span>Lieferant</span>
                <select name="vendor_id" required defaultValue="">
                  <option value="" disabled>— auswählen —</option>
                  {lieferanten.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>ab Menge (MOQ)</span>
                <input type="number" name="moq" step="0.001" min="0" defaultValue={0} />
              </label>
              <label className="field">
                <span>Preis netto</span>
                <input type="number" name="preis" step="0.01" min="0" required />
              </label>
              <label className="field">
                <span>Rabatt %</span>
                <input type="number" name="rabatt" step="0.1" min="0" max="100" defaultValue={0} />
              </label>
              <label className="field">
                <span>Lieferzeit (Tage)</span>
                <input type="number" name="lieferzeit_tage" step="1" min="0" defaultValue={0} />
              </label>
              <label className="field">
                <span>Gültig von</span>
                <input type="date" name="gueltig_von" />
              </label>
              <label className="field">
                <span>Gültig bis</span>
                <input type="date" name="gueltig_bis" />
              </label>
              <div className="shrink field">
                <button className="primary" type="submit">Staffel anlegen</button>
              </div>
            </div>
          </ActionForm>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Mehrere Zeilen je Lieferant bilden Preisstaffeln: die Zeile mit der höchsten
            erreichten Mindestmenge gilt. Die Beschaffung empfiehlt Mengen ab der MOQ
            und rechnet mit dem Staffelpreis der bestellten Menge.
          </p>
        </Card>
      )}

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
                      <span className="actions">
                        {a.values.map((v) => (
                          <span key={v} className="badge neutral">{v}</span>
                        ))}
                      </span>
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
            {/* Für „info" gibt es keine LED-Klasse — die Farbe kommt als Token
                dazu (wie in ui.tsx). Ohne sie stünde hier ein grauer Punkt
                ohne Bedeutung auf der info-getönten Fläche. */}
            <span className="led" style={{ background: 'var(--info)' }} />{' '}
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
