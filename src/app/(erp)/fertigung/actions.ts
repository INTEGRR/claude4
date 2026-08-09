'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { requireWrite } from '@/modules/auth'
import { parseQtyMap } from '@/modules/shared/form'
import { actionError, actionFail, actionInfo } from '@/modules/shared/action'

export async function createMo(formData: FormData) {
  const user = await requireWrite('fertigung')
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  if (!(qty > 0)) return actionError('Die Menge muss größer als 0 sein')

  let id: string
  try {
    const [row] = await sql<{ create_manufacturing_order: string }[]>`
      select create_manufacturing_order(${variantId}, ${qty}, null, null, ${user.name})`
    id = row.create_manufacturing_order
  } catch (err) {
    return actionFail(err)
  }
  redirect(`/fertigung/${id}`)
}

export async function confirmMo(moId: string) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select mo_confirm(${moId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
}

export async function startMo(moId: string) {
  const user = await requireWrite('fertigung')
  await sql`select mo_start(${moId}, ${user.name})`
  revalidatePath(`/fertigung/${moId}`)
}

export async function checkAvailability(moId: string) {
  await requireWrite('fertigung')
  await sql`select mo_check_availability(${moId})`
  revalidatePath(`/fertigung/${moId}`)

  // Ohne Rückmeldung wäre das ein Knopf, der scheinbar nichts tut, wenn kein
  // Bestand zum Reservieren da ist — genau die Sorte Stille, die Misstrauen sät.
  const [stand] = await sql<{ offen: number; gesamt: number }[]>`
    select count(*) filter (where state in ('confirmed', 'waiting'))::int as offen,
           count(*)::int as gesamt
    from stock_moves
    where production_id = ${moId} and state not in ('done', 'cancel')`
  if (!stand || stand.gesamt === 0) return
  return stand.offen === 0
    ? actionInfo('Alle Komponenten sind reserviert.')
    : actionInfo(
        `${stand.gesamt - stand.offen} von ${stand.gesamt} Positionen reserviert — für den Rest fehlt Bestand.`,
      )
}

/** Fertigmeldung inkl. abweichender Ist-Mengen aus dem Formular. */
export async function produceMo(moId: string, formData: FormData) {
  const user = await requireWrite('fertigung')
  const qtyRaw = formData.get('qty')
  const qty = qtyRaw ? Number(qtyRaw) : null
  const backorder = formData.get('backorder') !== 'no'

  const consumed = parseQtyMap(formData, 'consumed_')
  const lot = String(formData.get('lot') ?? '').trim() || null

  try {
    await sql`select mo_produce(${moId}, ${qty}, ${sql.json(consumed)}, ${backorder}, ${user.name}, ${lot})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
  revalidatePath('/fertigung')
  revalidatePath('/versand')
}

export async function cancelMo(moId: string) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select mo_cancel(${moId}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
}

// --- Demontage -------------------------------------------------------------

export async function createUnbuild(formData: FormData) {
  const user = await requireWrite('fertigung')
  const variantId = String(formData.get('variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  if (!variantId) return actionError('Bitte ein Produkt auswählen')
  if (!(qty > 0)) return actionError('Die Menge muss größer als 0 sein')

  const [bom] = await sql<{ resolve_bom: string | null }[]>`select resolve_bom(${variantId})`
  if (!bom.resolve_bom) return actionError('Für dieses Produkt existiert keine Stückliste')

  const [stock] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  const [row] = await sql<{ id: string }[]>`
    insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
    values (next_sequence('unbuild'), ${variantId}, ${bom.resolve_bom}, ${qty},
            ${stock.id}, ${stock.id})
    returning id`

  await sql`select log_event('unbuild_order', ${row.id}, 'state', 'Demontageauftrag angelegt', ${user.name})`
  revalidatePath('/fertigung/demontage')
}

export async function applyUnbuild(unbuildId: string, force: boolean) {
  const user = await requireWrite('fertigung')
  try {
    await sql`select unbuild_apply(${unbuildId}, ${force}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/fertigung/demontage')
}

// --- Stücklisten -----------------------------------------------------------

export async function createBom(formData: FormData) {
  await requireWrite('fertigung')
  const templateId = String(formData.get('template_id') ?? '')
  const qty = Number(formData.get('qty') ?? 1)
  if (!templateId) return actionError('Bitte ein Produkt auswählen')

  const [tpl] = await sql<{ uom_id: string }[]>`
    select uom_id from product_templates where id = ${templateId}`
  if (!tpl) return actionError('Produkt nicht gefunden')

  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${templateId}, ${qty}, ${tpl.uom_id})
    returning id`
  redirect(`/fertigung/stuecklisten/${bom.id}`)
}

export async function addBomLine(bomId: string, formData: FormData) {
  await requireWrite('fertigung')
  const variantId = String(formData.get('component_variant_id') ?? '')
  const qty = Number(formData.get('qty') ?? 0)
  const issueMethod = formData.get('issue_method') === 'manual' ? 'manual' : 'backflush'
  if (!variantId) return actionError('Bitte eine Komponente auswählen')
  if (!(qty > 0)) return actionError('Die Menge muss größer als 0 sein')

  const [info] = await sql<{ uom_id: string }[]>`
    select pt.uom_id from product_variants pv
    join product_templates pt on pt.id = pv.template_id where pv.id = ${variantId}`

  const [line] = await sql<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_lines where bom_id = ${bomId}), 10),
            ${variantId}, ${qty}, ${info.uom_id}, ${issueMethod}::component_issue_method)
    returning id`

  // "Auf Varianten anwenden": ausgewählte Attributwerte übernehmen.
  const ptavIds = formData.getAll('ptav_ids').map(String).filter(Boolean)
  for (const ptavId of ptavIds) {
    await sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
              values (${line.id}, ${ptavId}) on conflict do nothing`
  }

  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

export async function removeBomLine(bomId: string, lineId: string) {
  await requireWrite('fertigung')
  await sql`delete from bom_lines where id = ${lineId} and bom_id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

export async function setBomConsumption(bomId: string, formData: FormData) {
  await requireWrite('fertigung')
  const value = String(formData.get('consumption') ?? 'warning')
  await sql`update boms set consumption = ${value}::consumption_rule where id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

/** Verantwortlichen und Priorität des Fertigungsauftrags setzen. */
export async function updateMoDetails(moId: string, formData: FormData) {
  await requireWrite('fertigung')
  await sql`
    update manufacturing_orders set
      user_id = ${String(formData.get('user_id') ?? '') || null},
      priority = ${formData.get('priority') === 'on' ? '1' : '0'}
    where id = ${moId}`
  revalidatePath(`/fertigung/${moId}`)
}

/** Verbrauchsart einer Stücklistenposition umstellen (Backflush ⇄ manuell). */
export async function setBomLineIssueMethod(bomId: string, lineId: string, method: string) {
  await requireWrite('fertigung')
  const value = method === 'manual' ? 'manual' : 'backflush'
  await sql`
    update bom_lines
       set issue_method = ${value}::component_issue_method,
           manual_consumption = ${value === 'manual'}
     where id = ${lineId} and bom_id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

// --- Arbeitsplätze ---------------------------------------------------------

export async function createWorkCenter(formData: FormData) {
  await requireWrite('fertigung')
  const code = String(formData.get('code') ?? '').trim().toUpperCase()
  const name = String(formData.get('name') ?? '').trim()
  if (!code) return actionError('Bitte ein Kürzel vergeben')
  if (!name) return actionError('Bitte einen Namen vergeben')

  try {
    await sql`
      insert into work_centers (code, name, cost_per_hour, capacity, time_efficiency, note)
      values (${code}, ${name},
              ${Number(formData.get('cost_per_hour') ?? 0) || 0},
              ${Number(formData.get('capacity') ?? 1) || 1},
              ${Number(formData.get('time_efficiency') ?? 100) || 100},
              ${String(formData.get('note') ?? '').trim() || null})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/fertigung/arbeitsplaetze')
}

export async function updateWorkCenter(workCenterId: string, formData: FormData) {
  await requireWrite('fertigung')
  try {
    await sql`
      update work_centers set
        name = ${String(formData.get('name') ?? '').trim()},
        cost_per_hour = ${Number(formData.get('cost_per_hour') ?? 0) || 0},
        capacity = ${Number(formData.get('capacity') ?? 1) || 1},
        time_efficiency = ${Number(formData.get('time_efficiency') ?? 100) || 100},
        active = ${formData.get('active') === 'on'},
        note = ${String(formData.get('note') ?? '').trim() || null}
      where id = ${workCenterId}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/fertigung/arbeitsplaetze')
}

// --- Arbeitsgänge an der Stückliste ---------------------------------------

export async function addBomOperation(bomId: string, formData: FormData) {
  await requireWrite('fertigung')
  const name = String(formData.get('name') ?? '').trim()
  const workCenter = String(formData.get('work_center_id') ?? '')
  if (!name) return actionError('Bitte den Arbeitsgang benennen')
  if (!workCenter) return actionError('Bitte einen Arbeitsplatz auswählen')

  try {
    await sql`
      insert into bom_operations (bom_id, sequence, name, work_center_id,
                                  duration_minutes, setup_minutes)
      values (${bomId},
              coalesce((select max(sequence) + 10 from bom_operations where bom_id = ${bomId}), 10),
              ${name}, ${workCenter},
              ${Number(formData.get('duration_minutes') ?? 0) || 0},
              ${Number(formData.get('setup_minutes') ?? 0) || 0})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

export async function removeBomOperation(bomId: string, operationId: string) {
  await requireWrite('fertigung')
  await sql`delete from bom_operations where id = ${operationId} and bom_id = ${bomId}`
  revalidatePath(`/fertigung/stuecklisten/${bomId}`)
}

// --- Arbeitsgänge am Auftrag ----------------------------------------------

export async function startOperation(moId: string, operationId: string, formData?: FormData) {
  const user = await requireWrite('fertigung')
  const employeeId = String(formData?.get('employee_id') ?? '').trim() || null
  try {
    await sql`select mo_operation_start(${operationId}, ${user.name})`
    await sql`update mo_operations set user_id = ${user.id} where id = ${operationId}`
    await sql`select mo_start(${moId}, ${user.name})`
    // Mit Mitarbeiter läuft zusätzlich die Zeiterfassung — dann zählt beim
    // Abschluss der Personalkostensatz statt des Arbeitsplatzsatzes.
    if (employeeId) {
      await sql`select time_entry_start(${employeeId}, 'production', ${operationId}, ${user.name})`
    }
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
  revalidatePath('/zeiterfassung')
}

/** Arbeitsgang beenden — ohne Minutenangabe zählt die Zeit seit dem Start. */
export async function finishOperation(moId: string, operationId: string, formData: FormData) {
  const user = await requireWrite('fertigung')
  const raw = String(formData.get('minutes') ?? '').trim()
  const minutes = raw === '' ? null : Number(raw)
  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
    return actionError('Bitte eine gültige Dauer in Minuten erfassen')
  }
  try {
    await sql`select mo_operation_finish(${operationId}, ${minutes}, ${user.name})`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath(`/fertigung/${moId}`)
  revalidatePath('/zeiterfassung')
}
