import { sql } from '@/db/client'
import { druckbrueckeKonfiguriert, zettelDruckEinreihen } from '@/modules/versand/druckbruecke'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Fertigungs-Aktionen — Fachlogik unverändert aus fertigung/actions.ts. */

export async function auftragAnlegen(
  p: { variant_id: string; qty: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ create_manufacturing_order: string }[]>`
    select create_manufacturing_order(${p.variant_id}, ${p.qty}, null, null, ${ctx.actor})`
  return {
    text: 'Fertigungsauftrag angelegt.',
    link: `/fertigung/${row.create_manufacturing_order}`,
    recordId: row.create_manufacturing_order,
  }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_confirm(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function beginnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_start(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/**
 * Bulk-Zettel: Druckaufträge fürs Ziel „zetteldrucker" einreihen. Ohne
 * konfigurierte Druckbrücke gibt es stattdessen den Link auf den
 * Browser-Sammeldruck — der Knopf tut dann sichtbar das Nächstbeste.
 */
export async function zettelDrucken(p: { ids: string[] }): Promise<AktionsErgebnis> {
  if (!druckbrueckeKonfiguriert()) {
    return {
      text: 'Druckbrücke nicht konfiguriert — Sammeldruck im Browser geöffnet.',
      link: `/fertigung/druck?ids=${p.ids.join(',')}`,
    }
  }
  const eingereiht = await zettelDruckEinreihen(p.ids)
  const doppelt = p.ids.length - eingereiht
  return {
    text:
      `${eingereiht} Zettel an der Druckbrücke eingereiht` +
      (doppelt > 0 ? ` (${doppelt} warteten dort schon)` : '') +
      '.',
  }
}

/**
 * Bulk-Start (BUG/00003): jeden Auftrag einzeln starten — startbar ist,
 * was bestätigt ist und dessen Material vollständig reserviert wurde.
 * Wer zwischen Druck und Start herausgefallen ist, wird übersprungen und
 * namentlich gemeldet; ein Einzelfehler bricht den Lauf nicht ab.
 */
export async function massenstart(
  p: { ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const kandidaten = await sql<{ id: string; number: string; state: string; missing: number }[]>`
    select mo.id, mo.number, mo.state,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.state not in ('done', 'cancel')
               and m.reserved_qty < m.qty)::int as missing
    from manufacturing_orders mo
    where mo.id = any(${p.ids})`

  const gestartet: string[] = []
  const uebersprungen: string[] = []
  for (const mo of kandidaten) {
    if (mo.state !== 'confirmed') {
      uebersprungen.push(`${mo.number} (Status ${mo.state})`)
      continue
    }
    if (mo.missing > 0) {
      uebersprungen.push(`${mo.number} (Material nicht vollständig reserviert)`)
      continue
    }
    try {
      await sql`select mo_start(${mo.id}, ${ctx.actor})`
      gestartet.push(mo.number)
    } catch (err) {
      uebersprungen.push(
        `${mo.number} (${(err instanceof Error ? err.message : String(err)).replace(/^error: /, '')})`,
      )
    }
  }

  if (gestartet.length === 0) {
    throw new Error(
      uebersprungen.length > 0
        ? `Kein Auftrag gestartet — übersprungen: ${uebersprungen.join(', ')}.`
        : 'Keiner der ausgewählten Aufträge wurde gefunden.',
    )
  }
  return {
    text:
      `${gestartet.length} Fertigungsauftrag/-aufträge gestartet.` +
      (uebersprungen.length > 0 ? ` Übersprungen: ${uebersprungen.join(', ')}.` : ''),
  }
}

export async function verfuegbarkeitPruefen(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const moId = ctx.recordId!
  await sql`select mo_check_availability(${moId})`

  // Ohne Rückmeldung wäre das ein Knopf, der scheinbar nichts tut, wenn kein
  // Bestand zum Reservieren da ist — genau die Sorte Stille, die Misstrauen sät.
  const [stand] = await sql<{ offen: number; gesamt: number }[]>`
    select count(*) filter (where state in ('confirmed', 'waiting'))::int as offen,
           count(*)::int as gesamt
    from stock_moves
    where production_id = ${moId} and state not in ('done', 'cancel')`
  if (!stand || stand.gesamt === 0) return { recordId: moId }
  return {
    recordId: moId,
    text:
      stand.offen === 0
        ? 'Alle Komponenten sind reserviert.'
        : `${stand.gesamt - stand.offen} von ${stand.gesamt} Positionen reserviert — für den Rest fehlt Bestand.`,
  }
}

export async function fertigMelden(
  p: { qty?: number; mengen: Record<string, number>; backorder: boolean; lot?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select mo_produce(${ctx.recordId!}, ${p.qty ?? null}, ${sql.json(p.mengen)},
    ${p.backorder}, ${ctx.actor}, ${p.lot ?? null})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select mo_cancel(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

// --- Arbeitsgänge am Auftrag ------------------------------------------------

export async function arbeitsgangStarten(
  p: { operation_id: string; employee_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const moId = ctx.recordId!
  await sql`select mo_operation_start(${p.operation_id}, ${ctx.actor})`
  await sql`update mo_operations set user_id = ${ctx.userId ?? null} where id = ${p.operation_id}`
  await sql`select mo_start(${moId}, ${ctx.actor})`
  // Mit Mitarbeiter läuft zusätzlich die Zeiterfassung — dann zählt beim
  // Abschluss der Personalkostensatz statt des Arbeitsplatzsatzes.
  if (p.employee_id) {
    await sql`select time_entry_start(${p.employee_id}, 'production', ${p.operation_id}, ${ctx.actor})`
  }
  return { recordId: moId }
}

export async function arbeitsgangBeenden(
  p: { operation_id: string; minutes?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Ein zweiter Klick auf einen erledigten Arbeitsgang soll nicht stumm
  // verpuffen — sagen, dass es nichts zu tun gibt.
  const [vorher] = await sql<{ state: string }[]>`
    select state from mo_operations where id = ${p.operation_id}`
  if (vorher?.state === 'done') {
    return { recordId: ctx.recordId, text: 'Dieser Arbeitsgang war bereits abgeschlossen.' }
  }
  await sql`select mo_operation_finish(${p.operation_id}, ${p.minutes ?? null}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

// --- Demontage --------------------------------------------------------------

export async function demontageAnlegen(
  p: { variant_id: string; qty: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [bom] = await sql<{ resolve_bom: string | null }[]>`select resolve_bom(${p.variant_id})`
  if (!bom.resolve_bom) throw new Error('Für dieses Produkt existiert keine Stückliste')

  const [stock] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`

  const [row] = await sql<{ id: string }[]>`
    insert into unbuild_orders (number, variant_id, bom_id, qty, src_location_id, dest_location_id)
    values (next_sequence('unbuild'), ${p.variant_id}, ${bom.resolve_bom}, ${p.qty},
            ${stock.id}, ${stock.id})
    returning id`

  await sql`select log_event('unbuild_order', ${row.id}, 'state', 'Demontageauftrag angelegt', ${ctx.actor})`
  return { text: 'Demontageauftrag angelegt.', recordId: row.id }
}

export async function demontageBuchen(
  p: { force: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select unbuild_apply(${ctx.recordId!}, ${p.force}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

// --- Stücklisten ------------------------------------------------------------

export async function stuecklisteAnlegen(p: {
  template_id: string
  qty: number
}): Promise<AktionsErgebnis> {
  const [tpl] = await sql<{ uom_id: string }[]>`
    select uom_id from product_templates where id = ${p.template_id}`
  if (!tpl) throw new Error('Produkt nicht gefunden')

  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id) values (${p.template_id}, ${p.qty}, ${tpl.uom_id})
    returning id`
  return {
    text: 'Stückliste angelegt.',
    link: `/fertigung/stuecklisten/${bom.id}`,
    recordId: bom.id,
  }
}

export async function stuecklistePositionHinzufuegen(
  p: {
    component_variant_id: string
    qty: number
    issue_method: 'backflush' | 'manual'
    ptav_ids: string[]
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const bomId = ctx.recordId!
  const [info] = await sql<{ uom_id: string }[]>`
    select pt.uom_id from product_variants pv
    join product_templates pt on pt.id = pv.template_id where pv.id = ${p.component_variant_id}`
  if (!info) throw new Error('Komponente nicht gefunden')

  const [line] = await sql<{ id: string }[]>`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_lines where bom_id = ${bomId}), 10),
            ${p.component_variant_id}, ${p.qty}, ${info.uom_id},
            ${p.issue_method}::component_issue_method)
    returning id`

  // "Auf Varianten anwenden": ausgewählte Attributwerte übernehmen.
  for (const ptavId of p.ptav_ids) {
    await sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
              values (${line.id}, ${ptavId}) on conflict do nothing`
  }

  return { recordId: bomId }
}

export async function stuecklistePositionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from bom_lines where id = ${p.line_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function stuecklisteVerbrauch(
  p: { consumption: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update boms set consumption = ${p.consumption}::consumption_rule
            where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function stuecklisteVerbrauchsart(
  p: { line_id: string; method: 'backflush' | 'manual' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update bom_lines
       set issue_method = ${p.method}::component_issue_method,
           manual_consumption = ${p.method === 'manual'}
     where id = ${p.line_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function auftragDetails(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update manufacturing_orders set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

// --- Arbeitsplätze + Arbeitsgänge an der Stückliste --------------------------

export async function arbeitsplatzAnlegen(p: {
  code: string
  name: string
  cost_per_hour: number
  capacity: number
  time_efficiency: number
  note?: string
}): Promise<AktionsErgebnis> {
  await sql`
    insert into work_centers (code, name, cost_per_hour, capacity, time_efficiency, note)
    values (${p.code}, ${p.name}, ${p.cost_per_hour}, ${p.capacity}, ${p.time_efficiency},
            ${p.note ?? null})`
  return { text: `Arbeitsplatz ${p.code} angelegt.` }
}

export async function arbeitsplatzAendern(
  p: {
    name: string
    cost_per_hour: number
    capacity: number
    time_efficiency: number
    active: boolean
    note?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update work_centers set
      name = ${p.name},
      cost_per_hour = ${p.cost_per_hour},
      capacity = ${p.capacity},
      time_efficiency = ${p.time_efficiency},
      active = ${p.active},
      note = ${p.note ?? null}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function arbeitsgangHinzufuegen(
  p: { name: string; work_center_id: string; duration_minutes: number; setup_minutes: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const bomId = ctx.recordId!
  await sql`
    insert into bom_operations (bom_id, sequence, name, work_center_id,
                                duration_minutes, setup_minutes)
    values (${bomId},
            coalesce((select max(sequence) + 10 from bom_operations where bom_id = ${bomId}), 10),
            ${p.name}, ${p.work_center_id}, ${p.duration_minutes}, ${p.setup_minutes})`
  return { recordId: bomId }
}

export async function arbeitsgangEntfernen(
  p: { operation_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from bom_operations where id = ${p.operation_id} and bom_id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}
