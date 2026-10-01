import { sql } from '@/db/client'
import { scanVarianten } from '@/modules/shared/scan'
import { type PacktischDoc, packtischBelegLaden } from '@/modules/versand/packtisch-beleg'

/**
 * Das EINE Scanfeld (Entscheidungslog 2026-10-01): löst einen gescannten
 * Code auf und entscheidet den Ablauf. Eine LIEFERUNG (Packzettel
 * WH/OUT/…, auch Auftrags- oder Shop-Nummer) geht in den Packablauf
 * ({ versand }: Artikel gegenscannen, dann Label, Warenausgang und
 * Shop-Rückmeldung); Wareneingang und interne Transfers werden eine
 * Checkliste mit Buchung, ein Fertigungsauftrag eine Komponenten-Checkliste
 * mit Fertigmeldung. Nur lesend — gebucht wird über die Registry.
 */

export interface ScannerLine {
  moveId: string
  product: string
  sku: string | null
  barcode: string | null
  qty: number
  uom: string
}

export interface ScannerDoc {
  type: 'picking' | 'mo'
  id: string
  number: string
  state: string
  label: string
  sub: string
  /** nur MO: noch zu fertigende Menge */
  remaining?: number
  lines: ScannerLine[]
}

/** Antwort: ein Beleg für die Checkliste oder eine Lieferung für den Packablauf. */
export type ScannerAntwort = ScannerDoc | { versand: PacktischDoc }

export type ScanErgebnis =
  | { ok: true; antwort: ScannerAntwort }
  | { ok: false; status: number; error: string }

export interface ScanRechte {
  picking: boolean
  mo: boolean
  versand: boolean
}

async function versandErgebnis(code: string): Promise<ScanErgebnis> {
  const r = await packtischBelegLaden(code)
  return r.ok ? { ok: true, antwort: { versand: r.doc } } : { ok: false, status: r.status, error: r.error }
}

export async function scanBelegLaden(code: string, rechte: ScanRechte): Promise<ScanErgebnis> {
  const kandidaten = scanVarianten(code)

  const [picking] = await sql<
    { id: string; number: string; state: string; kind: string; origin_label: string | null }[]
  >`
    select p.id, p.number, p.state, ot.kind, p.origin_label
    from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
    where p.number = any(${kandidaten}::text[])
    order by (p.number = ${code}) desc
    limit 1`

  // Lieferungen werden gepackt, nicht bloß gebucht: ohne Label ginge die
  // Ware sonst raus, ohne dass DHL oder der Shop davon wissen.
  if (picking?.kind === 'delivery') {
    if (!rechte.versand) {
      return { ok: false, status: 403, error: `${picking.number} ist eine Lieferung — Packen braucht Schreibrechte im Versand` }
    }
    return versandErgebnis(picking.number)
  }

  if (picking) {
    if (!rechte.picking) {
      return { ok: false, status: 403, error: 'Transfers sind der Lager-Rolle vorbehalten' }
    }
    if (picking.state === 'done' || picking.state === 'cancel') {
      return { ok: false, status: 409, error: `${picking.number} ist bereits abgeschlossen` }
    }
    const lines = await sql<ScannerLine[]>`
      select m.id as "moveId", variant_display_name(m.variant_id) as product,
             pv.sku, pv.barcode, m.qty, u.name as uom
      from stock_moves m
      join product_variants pv on pv.id = m.variant_id
      join uoms u on u.id = m.uom_id
      where m.picking_id = ${picking.id} and m.state not in ('done', 'cancel')
      order by m.created_at`
    if (lines.length === 0) {
      return { ok: false, status: 409, error: `${picking.number} hat keine offenen Positionen` }
    }
    const kindLabel =
      picking.kind === 'receipt' ? 'Wareneingang'
      : picking.kind === 'delivery' ? 'Lieferung'
      : 'Transfer'
    const doc: ScannerDoc = {
      type: 'picking',
      id: picking.id,
      number: picking.number,
      state: picking.state,
      label: kindLabel,
      sub: picking.origin_label ?? '',
      lines,
    }
    return { ok: true, antwort: doc }
  }

  const [mo] = await sql<
    {
      id: string
      number: string
      state: string
      product: string
      qty_to_produce: number
      qty_produced: number
    }[]
  >`
    select mo.id, mo.number, mo.state, variant_display_name(mo.variant_id) as product,
           mo.qty_to_produce, mo.qty_produced
    from manufacturing_orders mo where mo.number = any(${kandidaten}::text[])
    order by (mo.number = ${code}) desc
    limit 1`

  if (mo) {
    if (!rechte.mo) {
      return { ok: false, status: 403, error: 'Fertigungsaufträge sind der Fertigungs-Rolle vorbehalten' }
    }
    if (mo.state === 'done' || mo.state === 'cancel') {
      return { ok: false, status: 409, error: `${mo.number} ist bereits abgeschlossen` }
    }
    if (mo.state === 'draft') {
      return { ok: false, status: 409, error: `${mo.number} ist noch ein Entwurf — bitte zuerst bestätigen` }
    }
    const lines = await sql<ScannerLine[]>`
      select m.id as "moveId", variant_display_name(m.variant_id) as product,
             pv.sku, pv.barcode, greatest(m.qty - m.qty_done, 0) as qty, u.name as uom
      from stock_moves m
      join product_variants pv on pv.id = m.variant_id
      join uoms u on u.id = m.uom_id
      where m.production_id = ${mo.id} and m.reference = 'Komponentenverbrauch'
        and m.state not in ('done', 'cancel')
      order by m.created_at`
    const doc: ScannerDoc = {
      type: 'mo',
      id: mo.id,
      number: mo.number,
      state: mo.state,
      label: 'Fertigungsauftrag',
      sub: mo.product,
      remaining: Number(mo.qty_to_produce) - Number(mo.qty_produced),
      lines,
    }
    return { ok: true, antwort: doc }
  }

  // Auftrags- oder Shop-Bestellnummer (#1234) → deren Lieferung packen.
  if (rechte.versand) {
    const r = await packtischBelegLaden(code)
    if (r.ok) return { ok: true, antwort: { versand: r.doc } }
    if (r.status !== 404) return { ok: false, status: r.status, error: r.error }
  }

  return { ok: false, status: 404, error: `Kein Beleg gefunden zu "${code}"` }
}
