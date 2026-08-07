'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { type Area, canWrite } from '@/modules/auth/permissions'

/**
 * Gemeinsame Tag-Verwaltung für Kontakte, Produkte, Verkaufsaufträge und
 * Reparaturen (Odoo: category_id / product_tag_ids / tag_ids / tags).
 */

const MODELS: Record<
  string,
  { kind: string; table: string; column: string; area: Area }
> = {
  partner: { kind: 'partner', table: 'partner_tag_links', column: 'partner_id', area: 'kontakte' },
  product_template: { kind: 'product', table: 'product_tag_links', column: 'template_id', area: 'produkte' },
  sales_order: { kind: 'sale', table: 'sales_order_tag_links', column: 'order_id', area: 'verkauf' },
  repair_order: { kind: 'repair', table: 'repair_order_tag_links', column: 'repair_id', area: 'reparatur' },
}

/** Setzt die Tag-Menge des Datensatzes; ein nichtleerer Name legt neu an. */
export async function setTags(model: string, recordId: string, path: string, formData: FormData) {
  const user = await requireUser()
  const target = MODELS[model]
  if (!target) throw new Error(`Tags sind für "${model}" nicht vorgesehen`)
  if (!canWrite(user.role, target.area)) {
    throw new Error('Dafür fehlt Ihrer Rolle die Berechtigung')
  }

  const selected = formData.getAll('tag_ids').map(String).filter(Boolean)

  const neu = String(formData.get('new_tag') ?? '').trim()
  if (neu) {
    const [tag] = await sql<{ id: string }[]>`
      insert into tags (kind, name) values (${target.kind}, ${neu})
      on conflict (kind, name) do update set name = excluded.name
      returning id`
    selected.push(tag.id)
  }

  await sql`delete from ${sql(target.table)} where ${sql(target.column)} = ${recordId}`
  for (const tagId of selected) {
    await sql`insert into ${sql(target.table)} (${sql(target.column)}, tag_id)
              values (${recordId}, ${tagId}) on conflict do nothing`
  }
  revalidatePath(path)
}
