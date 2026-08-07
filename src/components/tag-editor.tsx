import { sql } from '@/db/client'
import { setTags } from '@/app/(erp)/tags-action'
import { ActionForm } from '@/components/action-button'

/**
 * Tag-Anzeige + -Bearbeitung für einen Datensatz (Kontakt, Produkt,
 * Auftrag, Reparatur). Aufklappbar, damit die Detailseiten ruhig bleiben.
 */

const KIND_BY_MODEL: Record<string, { kind: string; table: string; column: string }> = {
  partner: { kind: 'partner', table: 'partner_tag_links', column: 'partner_id' },
  product_template: { kind: 'product', table: 'product_tag_links', column: 'template_id' },
  sales_order: { kind: 'sale', table: 'sales_order_tag_links', column: 'order_id' },
  repair_order: { kind: 'repair', table: 'repair_order_tag_links', column: 'repair_id' },
}

export async function TagEditor({
  model,
  recordId,
  path,
}: {
  model: keyof typeof KIND_BY_MODEL
  recordId: string
  path: string
}) {
  const target = KIND_BY_MODEL[model]
  const assigned = await sql<{ id: string; name: string }[]>`
    select t.id, t.name from tags t
    join ${sql(target.table)} l on l.tag_id = t.id
    where l.${sql(target.column)} = ${recordId}
    order by t.name`
  const available = await sql<{ id: string; name: string }[]>`
    select id, name from tags where kind = ${target.kind} order by name`

  return (
    <div className="actions">
      {/* Tags sind Etiketten, keine Zustände — deshalb grau. Die Statusfarben
          bleiben dem Status vorbehalten, sonst stehen beide gleichrangig. */}
      {assigned.length === 0 && <span className="mono-label">Keine Tags</span>}
      {assigned.map((t) => (
        <span key={t.id} className="badge neutral">{t.name}</span>
      ))}
      <details style={{ display: 'inline-block' }}>
        <summary className="btn small">Tags…</summary>
        <ActionForm
          action={setTags.bind(null, model, recordId, path)}
          style={{
            position: 'absolute',
            zIndex: 20,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 12,
            marginTop: 4,
            minWidth: 240,
            boxShadow: 'var(--shadow)',
          }}
        >
          {available.length > 0 && (
            <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 8 }}>
              {available.map((t) => (
                <label key={t.id} style={{ display: 'block', padding: '2px 0' }}>
                  <input
                    type="checkbox"
                    name="tag_ids"
                    value={t.id}
                    defaultChecked={assigned.some((a) => a.id === t.id)}
                  />{' '}
                  {t.name}
                </label>
              ))}
            </div>
          )}
          <div className="row">
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Neues Tag</span>
              <input name="new_tag" placeholder="Neues Tag…" />
            </label>
            <div className="shrink">
              <button className="small" type="submit">Speichern</button>
            </div>
          </div>
        </ActionForm>
      </details>
    </div>
  )
}
