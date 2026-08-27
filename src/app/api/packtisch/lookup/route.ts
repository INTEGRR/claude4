import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { vorschlaegeFuerPickings } from '@/modules/versand/regeln'

/**
 * Löst den am Packtisch gescannten Versand-Code auf: die Lieferung mit
 * Auftrag, Lieferadresse, Positionen (SKU/Barcode zum Gegenscannen) und
 * dem Regelvorschlag für Gewicht und DHL-Produkt. Nur lesend — der
 * Abschluss läuft über die Registry-Aktion versand.packtisch_abschliessen.
 *
 * Wächter mit Klartext statt stummem 404: wartet auf Fertigung (mit den
 * WH/MO-Nummern für die Suche nach dem Zettel), nicht reserviert, bereits
 * versendet. Ein vorhandenes Label ist KEIN Blocker — die Aktion verwendet
 * es wieder (Wiederholung nach Teilfehler).
 */

export interface PacktischZeile {
  /** Varianten-ID — Positionen sind je Variante aggregiert. */
  variantId: string
  product: string
  sku: string | null
  barcode: string | null
  qty: number
  uom: string
}

export interface PacktischDoc {
  pickingId: string
  number: string
  auftrag: string | null
  shopify: string | null
  kunde: string | null
  adresse: string[]
  /** Regelvorschlag als Vorbelegung fürs Label. */
  weightG: number | null
  dhlProduct: string | null
  labelVorhanden: boolean
  lines: PacktischZeile[]
}

export async function GET(request: Request) {
  const user = await currentUser()
  if (!user || !canWrite(user.role, 'versand', user.befugnisse)) {
    return NextResponse.json({ error: 'Der Packtisch braucht Schreibrechte im Versand' }, {
      status: 401,
    })
  }

  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })

  // Primär die Picking-Nummer (der VERSAND-Barcode der Zettel); als
  // Tipp-Fallback die Auftragsnummer (S…) oder der Shopify-Name (#1234) —
  // dann die jüngste nicht stornierte Lieferung dieses Auftrags.
  const [picking] = await sql<
    {
      id: string
      number: string
      state: string
      kind: string
      auftrag: string | null
      shopify: string | null
      kunde: string | null
      ship_name: string | null
      ship_street: string | null
      ship_house_number: string | null
      ship_zip: string | null
      ship_city: string | null
      ship_country_code: string | null
    }[]
  >`
    select p.id, p.number, p.state, ot.kind,
           so.number as auftrag, so.shopify_order_name as shopify,
           part.name as kunde,
           so.ship_name, so.ship_street, so.ship_house_number,
           so.ship_zip, so.ship_city, so.ship_country_code
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners part on part.id = coalesce(so.partner_id, p.partner_id)
    where p.number = ${code}
       or (ot.kind = 'delivery' and p.state <> 'cancel' and so.id is not null
           and (so.number = ${code} or so.shopify_order_name = ${code}
                or so.shopify_order_name = ${'#' + code.replace(/^#/, '')}))
    order by (p.number = ${code}) desc, p.created_at desc
    limit 1`

  if (!picking) {
    return NextResponse.json({ error: `Keine Lieferung gefunden zu "${code}"` }, { status: 404 })
  }
  if (picking.kind !== 'delivery') {
    return NextResponse.json(
      { error: `${picking.number} ist keine Lieferung — am Packtisch werden Lieferungen gepackt` },
      { status: 409 },
    )
  }
  if (picking.state === 'done') {
    return NextResponse.json(
      { error: `${picking.number} ist bereits versendet (Warenausgang gebucht)` },
      { status: 409 },
    )
  }
  if (picking.state === 'cancel') {
    return NextResponse.json({ error: `${picking.number} ist storniert` }, { status: 409 })
  }

  // „Versand wartet immer auf MTO": offene Fertigungen des Auftrags mit
  // Nummern nennen — der Zettel dazu hängt noch in der Fertigung.
  const mos = await sql<{ number: string }[]>`
    select mo.number
    from manufacturing_orders mo
    join stock_pickings p on p.origin_model = 'sales_order' and p.origin_id = mo.sales_order_id
    where p.id = ${picking.id} and mo.state not in ('done', 'cancel')
    order by mo.number`
  if (mos.length > 0) {
    return NextResponse.json(
      {
        error: `${picking.number} wartet auf die Fertigung: ${mos.map((m) => m.number).join(', ')}`,
      },
      { status: 409 },
    )
  }
  if (picking.state !== 'assigned') {
    return NextResponse.json(
      { error: `${picking.number} ist nicht reserviert (Status ${picking.state}) — erst Verfügbarkeit prüfen` },
      { status: 409 },
    )
  }

  // Positionen je VARIANTE aggregiert: gescannt wird gegen SKU/Barcode, und
  // zwei Auftragszeilen derselben Variante müssen als eine Sollmenge zählen.
  const lines = await sql<PacktischZeile[]>`
    select m.variant_id as "variantId",
           variant_display_name(m.variant_id) as product,
           pv.sku, pv.barcode,
           sum(m.qty)::float as qty, min(u.name) as uom
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join uoms u on u.id = m.uom_id
    where m.picking_id = ${picking.id} and m.state <> 'cancel'
    group by m.variant_id, pv.sku, pv.barcode
    order by min(m.created_at)`
  if (lines.length === 0) {
    return NextResponse.json(
      { error: `${picking.number} hat keine offenen Positionen` },
      { status: 409 },
    )
  }
  const ohneCode = lines.filter((l) => !l.sku && !l.barcode)
  if (ohneCode.length > 0) {
    return NextResponse.json(
      {
        error:
          `Position ohne SKU und Barcode: ${ohneCode.map((l) => l.product).join(', ')} — ` +
          'bitte am Produkt pflegen, sonst ist die Zeile nicht scannbar',
      },
      { status: 409 },
    )
  }

  const [label] = await sql<{ id: string }[]>`
    select id from shipments
    where picking_id = ${picking.id} and state <> 'cancelled'
      and (label_pdf is not null or label_path is not null)
    limit 1`

  const vorschlag = (await vorschlaegeFuerPickings([picking.id])).get(picking.id)

  const adresse = [
    picking.ship_name,
    [picking.ship_street, picking.ship_house_number].filter(Boolean).join(' '),
    [picking.ship_zip, picking.ship_city].filter(Boolean).join(' '),
    picking.ship_country_code,
  ].filter((z): z is string => Boolean(z && z.trim()))

  const doc: PacktischDoc = {
    pickingId: picking.id,
    number: picking.number,
    auftrag: picking.auftrag,
    shopify: picking.shopify,
    kunde: picking.kunde,
    adresse,
    weightG: vorschlag ? vorschlag.weightG : null,
    dhlProduct: vorschlag?.product ?? null,
    labelVorhanden: Boolean(label),
    lines,
  }
  return NextResponse.json(doc)
}
