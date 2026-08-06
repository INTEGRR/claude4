import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canAccess, canWrite } from '@/modules/auth/permissions'

/**
 * Löst einen am Scanner-Arbeitsplatz gescannten Belegcode auf und liefert
 * die Positionen mit Barcode/SKU, damit Produkt-Scans clientseitig ohne
 * weitere Anfragen abgehakt werden können. Gebucht wird über die
 * bestehenden Server Actions — hier wird nur gelesen.
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

export async function GET(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'scanner')) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })

  // Lager-Rolle bucht Transfers, Fertigungs-Rolle Fertigungsaufträge;
  // admin und mitarbeiter dürfen beides.
  const darfPicking = canWrite(user.role, 'lager')
  const darfMo = canWrite(user.role, 'fertigung')

  const [picking] = await sql<
    { id: string; number: string; state: string; kind: string; origin_label: string | null }[]
  >`
    select p.id, p.number, p.state, ot.kind, p.origin_label
    from stock_pickings p join operation_types ot on ot.id = p.operation_type_id
    where p.number = ${code}`

  if (picking) {
    if (!darfPicking) {
      return NextResponse.json(
        { error: 'Transfers sind der Lager-Rolle vorbehalten' },
        { status: 403 },
      )
    }
    if (picking.state === 'done' || picking.state === 'cancel') {
      return NextResponse.json(
        { error: `${picking.number} ist bereits abgeschlossen` },
        { status: 409 },
      )
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
      return NextResponse.json({ error: `${picking.number} hat keine offenen Positionen` }, { status: 409 })
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
    return NextResponse.json(doc)
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
    from manufacturing_orders mo where mo.number = ${code}`

  if (mo) {
    if (!darfMo) {
      return NextResponse.json(
        { error: 'Fertigungsaufträge sind der Fertigungs-Rolle vorbehalten' },
        { status: 403 },
      )
    }
    if (mo.state === 'done' || mo.state === 'cancel') {
      return NextResponse.json({ error: `${mo.number} ist bereits abgeschlossen` }, { status: 409 })
    }
    if (mo.state === 'draft') {
      return NextResponse.json(
        { error: `${mo.number} ist noch ein Entwurf — bitte zuerst bestätigen` },
        { status: 409 },
      )
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
    return NextResponse.json(doc)
  }

  return NextResponse.json({ error: `Kein Beleg gefunden zu "${code}"` }, { status: 404 })
}
