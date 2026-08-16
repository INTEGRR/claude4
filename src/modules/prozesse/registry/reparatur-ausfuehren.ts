import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Reparatur-Aktionen — Fachlogik aus reparatur/actions.ts. */

export async function auftragAnlegen(
  p: { partner_id: string; variant_id: string; qty: number; under_warranty: boolean; note?: string },
): Promise<AktionsErgebnis> {
  const [repair] = await sql<{ id: string; number: string }[]>`
    insert into repair_orders (number, partner_id, variant_id, qty, under_warranty, note)
    values (next_sequence('repair'), ${p.partner_id}, ${p.variant_id}, ${p.qty},
            ${p.under_warranty}, ${p.note ?? null})
    returning id, number`
  return {
    text: `Reparaturauftrag ${repair.number} angelegt.`,
    link: `/reparatur/${repair.id}`,
    recordId: repair.id,
  }
}

export async function teilHinzufuegen(
  p: { variant_id: string; qty: number; part_type: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const repairId = ctx.recordId!
  const [info] = await sql<{ uom_id: string; price: number }[]>`
    select pt.uom_id, pt.list_price as price
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`
  if (!info) throw new Error('Teil nicht gefunden')

  await sql`
    insert into repair_parts (repair_id, sequence, part_type, variant_id, qty, uom_id, price_unit)
    values (${repairId},
            coalesce((select max(sequence) + 10 from repair_parts where repair_id = ${repairId}), 10),
            ${p.part_type}::repair_part_type, ${p.variant_id}, ${p.qty}, ${info.uom_id}, ${info.price})`
  return { recordId: repairId }
}

export async function teilEntfernen(
  p: { part_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const repairId = ctx.recordId!
  const [part] = await sql<{ move_id: string | null }[]>`
    select move_id from repair_parts where id = ${p.part_id} and repair_id = ${repairId}`
  if (part?.move_id) {
    await sql`select move_cancel(${part.move_id})`
  }
  await sql`delete from repair_parts where id = ${p.part_id} and repair_id = ${repairId}`
  return { recordId: repairId }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_confirm(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function beginnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_start(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function abschliessen(
  p: { mengen: Record<string, number> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select repair_end(${ctx.recordId!}, ${sql.json(p.mengen)}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select repair_cancel(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function angebotErstellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ repair_create_quotation: string }[]>`
    select repair_create_quotation(${ctx.recordId!}, ${ctx.actor})`
  const [order] = await sql<{ number: string }[]>`
    select number from sales_orders where id = ${row.repair_create_quotation}`
  return {
    text: `Angebot ${order?.number ?? ''} aus der Reparatur erstellt.`,
    link: `/verkauf/${row.repair_create_quotation}`,
    recordId: row.repair_create_quotation,
  }
}

export async function details(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update repair_orders set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}
