import { requireArea } from '@/modules/auth'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from '@/db/client'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui'
import { money, qty } from '@/modules/shared/format'
import {
  addBomLine,
  addBomOperation,
  removeBomLine,
  removeBomOperation,
  setBomConsumption,
  setBomLineIssueMethod,
} from '../../actions'
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
      bom_type: string
    }[]
  >`
    select b.id, b.template_id, pt.name as product,
           case when b.variant_id is not null then variant_display_name(b.variant_id) end as variant,
           b.qty, u.name as uom, b.consumption, b.bom_type
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
      issue_method: string
      is_phantom: boolean
    }[]
  >`
    select l.id, variant_display_name(l.component_variant_id) as component, pv.sku, l.qty,
           u.name as uom, l.issue_method,
           resolve_kit(l.component_variant_id) is not null as is_phantom,
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
    group by l.id, pv.sku, u.name, l.sequence, l.issue_method, l.component_variant_id
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
    ? await sql<
        {
          component: string
          qty: number
          uom: string
          available: number
          issue_method: string
          phantom_path: string | null
        }[]
      >`
        select variant_display_name(c.component_variant_id) as component, c.qty,
               u.name as uom, free_to_use(c.component_variant_id) as available,
               c.issue_method, c.phantom_path
        from bom_explode(${id}, ${variante}, ${1}) c
        join uoms u on u.id = c.uom_id
        order by c.phantom_path nulls first, 1`
    : []

  const operations = await sql<
    {
      id: string
      sequence: number
      name: string
      work_center: string
      code: string
      cost_per_hour: number
      duration_minutes: number
      setup_minutes: number
    }[]
  >`
    select o.id, o.sequence, o.name, w.name as work_center, w.code,
           w.cost_per_hour, o.duration_minutes, o.setup_minutes
    from bom_operations o
    join work_centers w on w.id = o.work_center_id
    where o.bom_id = ${id}
    order by o.sequence, o.id`

  const workCenters = await sql<{ id: string; label: string; cost_per_hour: number }[]>`
    select id, code || ' — ' || name as label, cost_per_hour
    from work_centers where active order by code`

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
            {bom.bom_type === 'kit' && <> · Baugruppe (wird beim Verwenden aufgelöst)</>}
          </>
        }
        actions={<Link className="btn" href="/fertigung/stuecklisten">Zur Übersicht</Link>}
      />

      {bom.bom_type === 'kit' && (
        <div className="notice info">
          Diese Stückliste ist eine <strong>Baugruppe</strong> (Odoo: Kit/Phantom). Das Produkt wird
          nie selbst gelagert: In Fertigungsaufträgen, Lieferungen und Demontagen treten immer die
          Bestandteile an seine Stelle — auch mehrstufig, wenn eine Baugruppe wieder eine Baugruppe
          enthält.
        </div>
      )}

      {ptavs.length > 0 && (
        <div className="notice info">
          Dieses Produkt hat Varianten. Positionen ohne Auswahl bei „Auf Varianten anwenden“ gelten für{' '}
          <strong>alle</strong> Varianten; mit Auswahl nur für die passenden — so kommt z. B. das weiße
          Gehäuse nur in die weiße Tastatur.
        </div>
      )}

      <Card
        title="Positionen"
        actions={
          <ActionForm action={setBomConsumption.bind(null, id)}>
            <div className="row">
              {/* Label statt dreifach wiederholtem Präfix in den Optionen. */}
              <label className="field" style={{ marginBottom: 0, width: 220 }}>
                <span>Verbrauchsregel</span>
                <select name="consumption" defaultValue={bom.consumption}>
                  <option value="warning">Abweichung mit Warnung</option>
                  <option value="allowed">Abweichung erlaubt</option>
                  <option value="blocked">Abweichung gesperrt</option>
                </select>
              </label>
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
                  <th>Verbrauch</th>
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
                    <td className="nowrap">
                      {l.is_phantom ? (
                        <span className="badge info" title="Baugruppe — wird in ihre Bestandteile aufgelöst">
                          Baugruppe
                        </span>
                      ) : (
                        <ActionButton
                          className="small"
                          action={setBomLineIssueMethod.bind(
                            null,
                            id,
                            l.id,
                            l.issue_method === 'manual' ? 'backflush' : 'manual',
                          )}
                          title={
                            l.issue_method === 'manual'
                              ? 'Muss bei der Fertigmeldung erfasst werden — zum Umstellen klicken'
                              : 'Wird bei der Fertigmeldung automatisch verbraucht — zum Umstellen klicken'
                          }
                        >
                          {l.issue_method === 'manual' ? 'manuell' : 'automatisch'}
                        </ActionButton>
                      )}
                    </td>
                    <td>
                      {l.filters.length === 0 ? (
                        <span className="muted small">alle Varianten</span>
                      ) : (
                        <span className="actions">
                          {l.filters.map((f) => (
                            <span key={f} className="badge info">{f}</span>
                          ))}
                        </span>
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
              <label className="field">
                <span>Verbrauch</span>
                <select name="issue_method" defaultValue="backflush">
                  <option value="backflush">automatisch (Backflush)</option>
                  <option value="manual">manuell erfassen</option>
                </select>
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

          {variante && preview.some((p) => p.phantom_path) && (
            <p className="muted small">
              Baugruppen sind aufgelöst: die Vorschau zeigt die Teile, die im Fertigungsauftrag
              tatsächlich als Bedarf stehen — bezogen auf <strong>ein</strong> Stück.
            </p>
          )}

          {variante &&
            (preview.length === 0 ? (
              <Empty>Für diese Variante gelten keine Positionen.</Empty>
            ) : (
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Komponente</th>
                      <th>Aus Baugruppe</th>
                      <th className="num">Menge</th>
                      <th>Einheit</th>
                      <th>Verbrauch</th>
                      <th className="num">Frei verfügbar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p, i) => {
                      const covered = Number(p.available) >= Number(p.qty)
                      return (
                        <tr key={i}>
                          <td>{p.component}</td>
                          <td className="small muted">{p.phantom_path ?? '—'}</td>
                          <td className="num">{qty(p.qty)}</td>
                          <td>{p.uom}</td>
                          <td className="small muted">
                            {p.issue_method === 'manual' ? 'manuell' : 'automatisch'}
                          </td>
                          {/* LED plus Wort statt eingefärbter Zahl. */}
                          <td className="num">
                            <span className={`led ${covered ? 'ok' : 'warn'}`} />{' '}
                            <span className="muted small">{covered ? 'gedeckt' : 'zu wenig'}</span>{' '}
                            {qty(p.available)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
            ))}
        </Card>
      )}
      <Card
        title="Arbeitsgänge"
        actions={
          <Link className="btn small" href="/fertigung/arbeitsplaetze">Arbeitsplätze pflegen</Link>
        }
        tight
      >
        {operations.length === 0 ? (
          <Empty>
            Keine Arbeitsgänge — der Fertigungsauftrag trägt dann nur Materialkosten.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Arbeitsgang</th>
                  <th>Arbeitsplatz</th>
                  <th className="num">Rüstzeit</th>
                  <th className="num">Zeit je {qty(bom.qty)} {bom.uom}</th>
                  <th className="num">Kosten je {qty(bom.qty)} {bom.uom}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {operations.map((o) => (
                  <tr key={o.id}>
                    <td className="mono small">{o.sequence}</td>
                    <td>{o.name}</td>
                    <td>
                      <span className="mono small">{o.code}</span> {o.work_center}
                      <div className="small muted">{money(o.cost_per_hour)} / Std.</div>
                    </td>
                    <td className="num mono">{qty(o.setup_minutes)} Min.</td>
                    <td className="num mono">{qty(o.duration_minutes)} Min.</td>
                    <td className="num mono">
                      {money((Number(o.duration_minutes) / 60) * Number(o.cost_per_hour))}
                    </td>
                    <td className="num">
                      <ActionButton className="small danger" action={removeBomOperation.bind(null, id, o.id)}>
                        Entfernen
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} className="num mono-label">Lohnkosten je {qty(bom.qty)} {bom.uom}</td>
                  <td className="num mono" style={{ fontWeight: 600 }}>
                    {money(
                      operations.reduce(
                        (sum, o) => sum + (Number(o.duration_minutes) / 60) * Number(o.cost_per_hour),
                        0,
                      ),
                    )}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}

        <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
          {workCenters.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Zuerst einen <Link href="/fertigung/arbeitsplaetze">Arbeitsplatz</Link> anlegen — ohne
              Stundensatz gibt es keine Lohnkosten.
            </p>
          ) : (
            <ActionForm action={addBomOperation.bind(null, id)}>
              <div className="row">
                <label className="field" style={{ flex: 2 }}>
                  <span>Arbeitsgang</span>
                  <input name="name" placeholder="Montage" required />
                </label>
                <label className="field" style={{ flex: 2 }}>
                  <span>Arbeitsplatz</span>
                  <select name="work_center_id" required defaultValue="">
                    <option value="" disabled>— auswählen —</option>
                    {workCenters.map((w) => (
                      <option key={w.id} value={w.id}>{w.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Zeit (Min. je {qty(bom.qty)} {bom.uom})</span>
                  <input type="number" name="duration_minutes" step="0.01" min="0" defaultValue={0} />
                </label>
                <label className="field">
                  <span>Rüstzeit (Min. je Auftrag)</span>
                  <input type="number" name="setup_minutes" step="0.01" min="0" defaultValue={0} />
                </label>
                <div className="shrink field">
                  <button className="primary" type="submit">Hinzufügen</button>
                </div>
              </div>
            </ActionForm>
          )}
        </div>
      </Card>

      <RecordComments model="bom" recordId={id} path={`/fertigung/stuecklisten/${id}`} />
    </>
  )
}
