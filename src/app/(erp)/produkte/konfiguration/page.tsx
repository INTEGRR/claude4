import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireArea, requireWrite } from '@/modules/auth'
import { ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Stammdaten-Konfiguration: Produktkategorien, Steuern, Zahlungsbedingungen
 * und Tags (Odoo: product.category, account.tax, account.payment.term,
 * die vier Tag-Modelle).
 */

async function createCategory(formData: FormData) {
  'use server'
  await requireWrite('produkte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Bitte einen Namen angeben')
  await sql`insert into product_categories (name, parent_id, full_path)
            values (${name}, ${String(formData.get('parent_id') ?? '') || null}, '')`
  revalidatePath('/produkte/konfiguration')
}

async function createTax(formData: FormData) {
  'use server'
  await requireWrite('produkte')
  const name = String(formData.get('name') ?? '').trim()
  const amount = Number(formData.get('amount') ?? 0)
  if (!name) throw new Error('Bitte einen Namen angeben')
  await sql`insert into taxes (name, amount, type_tax_use, price_include, description)
            values (${name}, ${amount}, ${String(formData.get('type_tax_use') ?? 'sale')},
                    ${formData.get('price_include') === 'on'},
                    ${String(formData.get('description') ?? '').trim() || null})`
  revalidatePath('/produkte/konfiguration')
}

async function createPaymentTerm(formData: FormData) {
  'use server'
  await requireWrite('produkte')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Bitte einen Namen angeben')
  const early = formData.get('early_discount') === 'on'
  await sql`insert into payment_terms
              (name, nb_days, delay_type, early_discount, discount_percentage, discount_days)
            values (${name}, ${Number(formData.get('nb_days') ?? 0)},
                    ${String(formData.get('delay_type') ?? 'days_after')},
                    ${early},
                    ${early ? Number(formData.get('discount_percentage') ?? 0) : null},
                    ${early ? Number(formData.get('discount_days') ?? 0) : null})`
  revalidatePath('/produkte/konfiguration')
}

async function deleteTag(tagId: string) {
  'use server'
  await requireWrite('produkte')
  await sql`delete from tags where id = ${tagId}`
  revalidatePath('/produkte/konfiguration')
}

export default async function KonfigurationPage() {
  await requireArea('produkte')

  const categories = await sql<{ id: string; full_path: string; products: number }[]>`
    select c.id, c.full_path,
           (select count(*) from product_templates pt where pt.category_id = c.id)::int as products
    from product_categories c order by c.full_path`

  const taxes = await sql<
    { id: string; name: string; amount: number; type_tax_use: string; price_include: boolean }[]
  >`select id, name, amount, type_tax_use, price_include from taxes where active
    order by type_tax_use, sequence`

  const terms = await sql<
    {
      id: string
      name: string
      nb_days: number
      delay_type: string
      early_discount: boolean
      discount_percentage: number | null
      discount_days: number | null
    }[]
  >`select * from payment_terms where active order by sequence, nb_days`

  const tags = await sql<{ id: string; kind: string; name: string; used: number }[]>`
    select t.id, t.kind, t.name,
           ((select count(*) from partner_tag_links l where l.tag_id = t.id)
            + (select count(*) from product_tag_links l where l.tag_id = t.id)
            + (select count(*) from sales_order_tag_links l where l.tag_id = t.id)
            + (select count(*) from repair_order_tag_links l where l.tag_id = t.id))::int as used
    from tags t order by t.kind, t.name`

  const KIND_LABEL: Record<string, string> = {
    partner: 'Kontakt', product: 'Produkt', sale: 'Verkauf', repair: 'Reparatur',
  }

  return (
    <>
      <PageHeader
        title="Konfiguration"
        subtitle="Kategorien, Steuern, Zahlungsbedingungen und Tags"
      />

      <div className="grid-2">
        <Card title="Produktkategorien" tight>
          <TableWrap>
            <table>
              <thead>
                <tr><th>Kategorie</th><th className="num">Produkte</th></tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td className="mono small">{c.full_path}</td>
                    <td className="num">{qty(c.products)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div style={{ padding: 12 }}>
            <ActionForm action={createCategory}>
              <div className="row">
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Neue Kategorie</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Übergeordnet</span>
                  <select name="parent_id" defaultValue="">
                    <option value="">— oberste Ebene —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.full_path}</option>
                    ))}
                  </select>
                </label>
                <div className="shrink">
                  <button type="submit">Anlegen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>

        <Card title="Steuern" tight>
          <TableWrap>
            <table>
              <thead>
                <tr><th>Name</th><th className="num">Satz</th><th>Verwendung</th><th>Preis</th></tr>
              </thead>
              <tbody>
                {taxes.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="num">{qty(t.amount)} %</td>
                    <td>{t.type_tax_use === 'sale' ? 'Verkauf' : 'Einkauf'}</td>
                    <td className="small muted">{t.price_include ? 'inkl. Steuer' : 'zzgl. Steuer'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div style={{ padding: 12 }}>
            <ActionForm action={createTax}>
              <div className="row">
                <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                  <span>Name</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Satz %</span>
                  <input type="number" name="amount" step="0.01" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Verwendung</span>
                  <select name="type_tax_use" defaultValue="sale">
                    <option value="sale">Verkauf</option>
                    <option value="purchase">Einkauf</option>
                  </select>
                </label>
                <label className="shrink"><input type="checkbox" name="price_include" /> inkl.</label>
                <div className="shrink">
                  <button type="submit">Anlegen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Zahlungsbedingungen" tight>
          <TableWrap>
            <table>
              <thead>
                <tr><th>Name</th><th className="num">Tage</th><th>Skonto</th></tr>
              </thead>
              <tbody>
                {terms.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="num">
                      {t.nb_days}
                      {t.delay_type === 'days_after_end_of_month' && (
                        <div className="small muted nowrap">nach Monatsende</div>
                      )}
                    </td>
                    <td className="small muted">
                      {t.early_discount
                        ? `${qty(t.discount_percentage ?? 0)} % binnen ${t.discount_days} Tagen`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div style={{ padding: 12 }}>
            <ActionForm action={createPaymentTerm}>
              <div className="row">
                <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                  <span>Name</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Tage</span>
                  <input type="number" name="nb_days" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Fälligkeit</span>
                  <select name="delay_type" defaultValue="days_after">
                    <option value="days_after">nach Rechnungsdatum</option>
                    <option value="days_after_end_of_month">nach Monatsende</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <label className="shrink"><input type="checkbox" name="early_discount" /> Skonto</label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Skonto %</span>
                  <input type="number" name="discount_percentage" step="0.1" />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>binnen Tagen</span>
                  <input type="number" name="discount_days" />
                </label>
                <div className="shrink">
                  <button type="submit">Anlegen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>

        <Card title="Tags" tight>
          {tags.length === 0 ? (
            <Empty>Noch keine Tags — sie entstehen direkt an Kontakt, Produkt, Auftrag oder Reparatur.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr><th>Bereich</th><th>Name</th><th className="num">Verwendet</th><th /></tr>
                </thead>
                <tbody>
                  {tags.map((t) => (
                    <tr key={t.id}>
                      <td>{KIND_LABEL[t.kind] ?? t.kind}</td>
                      <td><span className="badge neutral">{t.name}</span></td>
                      <td className="num">{qty(t.used)}</td>
                      <td className="num">
                        <ActionForm action={deleteTag.bind(null, t.id)}>
                          <button className="small danger" type="submit">Löschen</button>
                        </ActionForm>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  )
}
