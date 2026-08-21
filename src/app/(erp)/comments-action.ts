'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { requireUser } from '@/modules/auth'
import { type Area, canAccess } from '@/modules/auth/permissions'
import { actionError } from '@/modules/shared/action'

/**
 * Gemeinsame Kommentar-Action für alle Belege und Stammdaten. Kommentare
 * landen als 'note' im audit_log — dieselbe Quelle, aus der der Verlauf
 * auf den Detailseiten gespeist wird.
 */

const MODELS: Record<string, { table: string; area: Area }> = {
  sales_order: { table: 'sales_orders', area: 'verkauf' },
  purchase_order: { table: 'purchase_orders', area: 'einkauf' },
  vendor_bill: { table: 'vendor_bills', area: 'einkauf' },
  manufacturing_order: { table: 'manufacturing_orders', area: 'fertigung' },
  bom: { table: 'boms', area: 'fertigung' },
  unbuild_order: { table: 'unbuild_orders', area: 'fertigung' },
  stock_picking: { table: 'stock_pickings', area: 'lager' },
  repair_order: { table: 'repair_orders', area: 'reparatur' },
  product_template: { table: 'product_templates', area: 'produkte' },
  product_variant: { table: 'product_variants', area: 'produkte' },
  partner: { table: 'partners', area: 'kontakte' },
  shipment: { table: 'shipments', area: 'versand' },
  vorgang: { table: 'vorgaenge', area: 'verkauf' },
  vertrag: { table: 'vertraege', area: 'finanzen' },
  darlehen: { table: 'darlehen', area: 'finanzen' },
  employee: { table: 'employees', area: 'personal' },
  bug_report: { table: 'bug_reports', area: 'fehler' },
}

/**
 * Die kommentierbaren Modelle als Typ — er koppelt diese Registry an ihre
 * Aufrufer. Eine Detailseite, die <RecordComments model="…"> mit einem hier
 * fehlenden Modell rendert, bricht ab jetzt den Typecheck. Genau das fehlte:
 * fuenf Seiten (vorgaenge, vertraege, darlehen, personal, tickets) zeigten
 * das Kommentarfeld an, waehrend jeder Absendeversuch mit „nicht vorgesehen"
 * scheiterte — der Fehler war nur fuer den Benutzer sichtbar, nie fuer den
 * Compiler.
 */
export type KommentarModell = keyof typeof MODELS

export async function addComment(
  model: KommentarModell,
  recordId: string,
  path: string,
  formData: FormData,
) {
  const user = await requireUser()
  const target = MODELS[model]
  if (!target) return actionError(`Kommentare sind für "${model}" nicht vorgesehen`)
  // Kommentieren darf, wer den Bereich sehen kann (auch die Lese-Rollen).
  if (!canAccess(user.role, target.area)) {
    return actionError('Dafür fehlt Ihrer Rolle die Berechtigung')
  }

  const note = String(formData.get('note') ?? '').trim()
  if (!note) return
  if (note.length > 2000) return actionError('Der Kommentar ist zu lang (max. 2000 Zeichen)')

  const [exists] = await sql`select 1 from ${sql(target.table)} where id = ${recordId}`
  if (!exists) return actionError('Der Datensatz existiert nicht (mehr)')

  await sql`select log_event(${model}, ${recordId}, 'note', ${note}, ${user.name})`
  revalidatePath(path)
}
