import { sql } from '@/db/client'
import { requireArea } from '@/modules/auth'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, TableWrap } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { qty } from '@/modules/shared/format'

export const dynamic = 'force-dynamic'

/**
 * Stammdaten-Konfiguration (Odoo: product.category, account.tax,
 * account.payment.term, die Tag-Modelle) — seit 2026-09-26 unter den
 * Einstellungen und damit nur für Administratoren; alle Schreibwege über die
 * Registry (einstellungen.kategorie_anlegen, …steuer_anlegen,
 * …zahlungsbedingung_anlegen, …tag_loeschen).
 */

async function kategorieAnlegen(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.kategorie_anlegen', { formData })
}

async function steuerAnlegen(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.steuer_anlegen', { formData })
}

async function zahlungsbedingungAnlegen(formData: FormData) {
  'use server'
  return serverAktion('einstellungen.zahlungsbedingung_anlegen', { formData })
}

async function tagLoeschen(tagId: string) {
  'use server'
  return serverAktion('einstellungen.tag_loeschen', { recordId: tagId, parameter: {} })
}

const TAG_BEREICH: Record<string, string> = {
  partner: 'Kontakt',
  product: 'Produkt',
  sale: 'Verkauf',
  repair: 'Reparatur',
}

export default async function StammdatenPage() {
  await requireArea('einstellungen')

  const kategorien = await sql<{ id: string; full_path: string; produkte: number }[]>`
    select c.id, c.full_path,
           (select count(*) from product_templates pt where pt.category_id = c.id)::int as produkte
    from product_categories c order by c.full_path`

  const steuern = await sql<
    { id: string; name: string; amount: number; type_tax_use: string; price_include: boolean }[]
  >`select id, name, amount, type_tax_use, price_include from taxes where active
    order by type_tax_use, sequence, name`

  const zahlungsbedingungen = await sql<
    {
      id: string
      name: string
      nb_days: number
      delay_type: string
      early_discount: boolean
      discount_percentage: number | null
      discount_days: number | null
    }[]
  >`select id, name, nb_days, delay_type, early_discount, discount_percentage, discount_days
    from payment_terms where active order by sequence, nb_days, name`

  const tags = await sql<{ id: string; kind: string; name: string; verwendet: number }[]>`
    select t.id, t.kind, t.name,
           ((select count(*) from partner_tag_links l where l.tag_id = t.id)
            + (select count(*) from product_tag_links l where l.tag_id = t.id)
            + (select count(*) from sales_order_tag_links l where l.tag_id = t.id)
            + (select count(*) from repair_order_tag_links l where l.tag_id = t.id))::int as verwendet
    from tags t order by t.kind, t.name`

  return (
    <>
      <EinstellungenKopf href="/einstellungen/stammdaten" />

      <div className="grid-2">
        <Card title={`Produktkategorien (${kategorien.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Kategorie</th>
                  <th className="num">Produkte</th>
                </tr>
              </thead>
              <tbody>
                {kategorien.map((k) => (
                  <tr key={k.id}>
                    <td className="mono small">{k.full_path}</td>
                    <td className="num">{qty(k.produkte)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div style={{ padding: 12 }}>
            <ActionForm action={kategorieAnlegen}>
              <div className="row">
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Neue Kategorie</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Übergeordnet</span>
                  <select name="parent_id" defaultValue="">
                    <option value="">— oberste Ebene —</option>
                    {kategorien.map((k) => (
                      <option key={k.id} value={k.id}>{k.full_path}</option>
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

        <Card title={`Steuern (${steuern.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Satz</th>
                  <th>Verwendung</th>
                  <th>Preis</th>
                </tr>
              </thead>
              <tbody>
                {steuern.map((t) => (
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
            <ActionForm action={steuerAnlegen}>
              <div className="row">
                <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                  <span>Name</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Satz %</span>
                  <input type="number" name="amount" step="0.01" min="0" max="100" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Verwendung</span>
                  <select name="type_tax_use" defaultValue="sale">
                    <option value="sale">Verkauf</option>
                    <option value="purchase">Einkauf</option>
                  </select>
                </label>
                <label className="shrink" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" name="price_include" /> inkl.
                </label>
                <div className="shrink">
                  <button type="submit">Anlegen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title={`Zahlungsbedingungen (${zahlungsbedingungen.length})`} tight>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Tage</th>
                  <th>Skonto</th>
                </tr>
              </thead>
              <tbody>
                {zahlungsbedingungen.map((z) => (
                  <tr key={z.id}>
                    <td>{z.name}</td>
                    <td className="num">
                      {z.nb_days}
                      {z.delay_type === 'days_after_end_of_month' && (
                        <div className="small muted nowrap">nach Monatsende</div>
                      )}
                    </td>
                    <td className="small muted">
                      {z.early_discount
                        ? `${qty(z.discount_percentage ?? 0)} % binnen ${z.discount_days} Tagen`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <div style={{ padding: 12 }}>
            <ActionForm action={zahlungsbedingungAnlegen}>
              <div className="row">
                <label className="field" style={{ flex: 2, marginBottom: 0 }}>
                  <span>Name</span>
                  <input name="name" required />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Tage</span>
                  <input type="number" name="nb_days" min="0" max="365" required />
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
                <label className="shrink" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" name="early_discount" /> Skonto
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>Skonto %</span>
                  <input type="number" name="discount_percentage" step="0.1" min="0" max="100" />
                </label>
                <label className="field" style={{ marginBottom: 0 }}>
                  <span>binnen Tagen</span>
                  <input type="number" name="discount_days" min="0" max="365" />
                </label>
                <div className="shrink">
                  <button type="submit">Anlegen</button>
                </div>
              </div>
            </ActionForm>
          </div>
        </Card>

        <Card title={`Tags (${tags.length})`} tight>
          {tags.length === 0 ? (
            <Empty>Noch keine Tags — sie entstehen direkt an Kontakt, Produkt, Auftrag oder Reparatur.</Empty>
          ) : (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Bereich</th>
                    <th>Name</th>
                    <th className="num">Verwendet</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tags.map((t) => (
                    <tr key={t.id}>
                      <td>{TAG_BEREICH[t.kind] ?? t.kind}</td>
                      <td><span className="badge neutral">{t.name}</span></td>
                      <td className="num">{qty(t.verwendet)}</td>
                      <td className="num">
                        <ActionButton
                          className="small danger"
                          action={tagLoeschen.bind(null, t.id)}
                          confirm={
                            t.verwendet > 0
                              ? `Tag „${t.name}" löschen? Er verschwindet von ${t.verwendet} Datensätzen.`
                              : `Tag „${t.name}" löschen?`
                          }
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
        </Card>
      </div>

      <p className="small muted">
        Maßeinheiten, Lagerorte und Nummernkreise kommen aus den Migrationen bzw. der
        Datenübernahme und haben keine eigene Pflegemaske; die Nummernkreise stehen unter Belege
        &amp; Freigaben.
      </p>
    </>
  )
}
