import { sql } from '@/db/client'
import { scanVarianten } from '@/modules/shared/scan'
import { vorschlaegeFuerPickings } from '@/modules/versand/regeln'

/**
 * Löst einen Versand-Code (Packzettel: WH/OUT/…, auch Auftrags- oder
 * Shop-Bestellnummer) zur packbaren Lieferung auf: Auftrag, Lieferadresse,
 * Positionen (SKU/Barcode zum Gegenscannen) und Regelvorschlag für Gewicht
 * und DHL-Produkt. Nur lesend — der Abschluss läuft über die Registry-Aktion
 * versand.packtisch_abschliessen.
 *
 * Genutzt vom einen Scanfeld (/scanner: eine Lieferung startet den
 * Packablauf) und von der alten Packtisch-Route. Wächter mit Klartext statt
 * stummem 404: wartet auf Fertigung (mit den MO-Nummern), nicht reserviert,
 * bereits versendet. Ein vorhandenes Label ist KEIN Blocker — die Aktion
 * verwendet es wieder (Wiederholung nach Teilfehler).
 */

export interface PacktischZeile {
  /** Varianten-ID — Positionen sind je Variante aggregiert. */
  variantId: string
  product: string
  sku: string | null
  barcode: string | null
  qty: number
  uom: string
  /** Artikelgewicht in Gramm je Stück — 0 = nicht gepflegt (im Packablauf setzbar). */
  gewichtG: number
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
  /** Gesammelt beim Kommissionieren (0091) — nur Hinweis, gescannt wird trotzdem. */
  kommissioniert: { am: string; von: string | null } | null
  lines: PacktischZeile[]
}

interface PacktischTreffer {
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
  kommissioniert_am: string | null
  kommissioniert_von: string | null
}

export type PacktischErgebnis =
  | { ok: true; doc: PacktischDoc }
  | { ok: false; status: number; error: string }

export async function packtischBelegLaden(code: string): Promise<PacktischErgebnis> {
  let picking: PacktischTreffer | undefined
  for (const kandidat of scanVarianten(code)) {
    ;[picking] = await sql<PacktischTreffer[]>`
    select p.id, p.number, p.state, ot.kind,
           p.kommissioniert_am::text as kommissioniert_am, p.kommissioniert_von,
           so.number as auftrag, so.shopify_order_name as shopify,
           part.name as kunde,
           so.ship_name, so.ship_street, so.ship_house_number,
           so.ship_zip, so.ship_city, so.ship_country_code
    from stock_pickings p
    join operation_types ot on ot.id = p.operation_type_id
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners part on part.id = coalesce(so.partner_id, p.partner_id)
    where p.number = ${kandidat}
       or (ot.kind = 'delivery' and p.state <> 'cancel' and so.id is not null
           and (so.number = ${kandidat} or so.shopify_order_name = ${kandidat}
                or so.shopify_order_name = ${'#' + kandidat.replace(/^#/, '')}))
    order by (p.number = ${kandidat}) desc, p.created_at desc
    limit 1`
    if (picking) break
  }

  if (!picking) {
    return { ok: false, status: 404, error: `Keine Lieferung gefunden zu "${code}"` }
  }
  if (picking.kind !== 'delivery') {
    return { ok: false, status: 409, error: `${picking.number} ist keine Lieferung — am Packtisch werden Lieferungen gepackt` }
  }
  if (picking.state === 'done') {
    return { ok: false, status: 409, error: `${picking.number} ist bereits versendet (Warenausgang gebucht)` }
  }
  if (picking.state === 'cancel') {
    return { ok: false, status: 409, error: `${picking.number} ist storniert` }
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
    return { ok: false, status: 409, error: `${picking.number} wartet auf die Fertigung: ${mos.map((m) => m.number).join(', ')}` }
  }
  if (picking.state !== 'assigned') {
    return { ok: false, status: 409, error: `${picking.number} ist nicht reserviert (Status ${picking.state}) — erst Verfügbarkeit prüfen` }
  }

  // Positionen je VARIANTE aggregiert: gescannt wird gegen SKU/Barcode, und
  // zwei Auftragszeilen derselben Variante müssen als eine Sollmenge zählen.
  const lines = await sql<PacktischZeile[]>`
    select m.variant_id as "variantId",
           variant_display_name(m.variant_id) as product,
           pv.sku, pv.barcode,
           sum(m.qty)::float as qty, min(u.name) as uom,
           coalesce(max(pt.weight_g), 0)::int as "gewichtG"
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = m.uom_id
    where m.picking_id = ${picking.id} and m.state <> 'cancel'
    group by m.variant_id, pv.sku, pv.barcode
    order by min(m.created_at)`
  if (lines.length === 0) {
    return { ok: false, status: 409, error: `${picking.number} hat keine offenen Positionen` }
  }
  const ohneCode = lines.filter((l) => !l.sku && !l.barcode)
  if (ohneCode.length > 0) {
    return { ok: false, status: 409, error: `Position ohne SKU und Barcode: ${ohneCode.map((l) => l.product).join(', ')} — ` +
          'bitte am Produkt pflegen, sonst ist die Zeile nicht scannbar' }
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
    kommissioniert: picking.kommissioniert_am
      ? { am: picking.kommissioniert_am, von: picking.kommissioniert_von }
      : null,
    lines,
  }
  return { ok: true, doc }
}
