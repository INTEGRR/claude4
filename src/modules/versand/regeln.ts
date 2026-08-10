import 'server-only'
import { sql } from '@/db/client'
import { productForCountry, zoneForCountry } from './dhl-codes'
import {
  type RegelKontext,
  type Regelergebnis,
  type Versandregel,
  type Zone,
  wendeRegelnAn,
} from './regeln-logik'

/** Aktive Regeln in Auswertungsreihenfolge. */
export async function ladeRegeln(): Promise<Versandregel[]> {
  const rows = await sql<
    {
      id: string
      name: string
      min_weight_g: number | null
      max_weight_g: number | null
      zone: Zone | null
      skus: string[] | null
      sku_scope: 'any' | 'all'
      require_kleinpaket_fit: boolean
      dhl_product: string | null
      billing_number: string | null
      insurance_from_value: number | null
    }[]
  >`
    select id, name, min_weight_g, max_weight_g, zone, skus, sku_scope,
           require_kleinpaket_fit, dhl_product, billing_number, insurance_from_value
    from shipping_rules
    where active
    order by sequence, name`

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    minWeightG: r.min_weight_g === null ? null : Number(r.min_weight_g),
    maxWeightG: r.max_weight_g === null ? null : Number(r.max_weight_g),
    zone: r.zone,
    skus: r.skus,
    skuScope: r.sku_scope,
    requireKleinpaketFit: r.require_kleinpaket_fit,
    dhlProduct: r.dhl_product,
    billingNumber: r.billing_number,
    insuranceFromValue: r.insurance_from_value === null ? null : Number(r.insurance_from_value),
  }))
}

export interface Versandvorschlag extends Regelergebnis {
  weightG: number
  zone: Zone
  orderValue: number
  /** Zahl der Auftragspositionen (für den Einzelposition-Filter). */
  positionen: number
  skus: string[]
}

/**
 * Regel-Kontext und -Ergebnis für eine Menge Lieferungen — eine Abfrage für
 * die Zeilen, eine für Land und Auftragswert, Auswertung im Speicher.
 */
export async function vorschlaegeFuerPickings(
  pickingIds: string[],
): Promise<Map<string, Versandvorschlag>> {
  const ergebnis = new Map<string, Versandvorschlag>()
  if (pickingIds.length === 0) return ergebnis

  const regeln = await ladeRegeln()

  const zeilen = await sql<
    {
      picking_id: string
      sku: string | null
      qty: number
      weight_g: number
      kleinpaket: boolean
      kleinpaket_max_qty: number
    }[]
  >`
    select m.picking_id, pv.sku, sum(m.qty)::float as qty,
           coalesce(sum(m.qty * pt.weight_g), 0)::int as weight_g,
           pt.kleinpaket, pt.kleinpaket_max_qty
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    join product_templates pt on pt.id = pv.template_id
    where m.picking_id = any(${pickingIds}) and m.state <> 'cancel'
    group by m.picking_id, pv.sku, pt.kleinpaket, pt.kleinpaket_max_qty`

  const koepfe = await sql<
    { id: string; country: string | null; order_value: number }[]
  >`
    select p.id,
           coalesce(so.ship_country_code, part.country_code, 'DE') as country,
           coalesce(sales_order_total(so.id), 0)::float as order_value
    from stock_pickings p
    left join sales_orders so on so.id = p.origin_id and p.origin_model = 'sales_order'
    left join partners part on part.id = p.partner_id
    where p.id = any(${pickingIds})`

  for (const kopf of koepfe) {
    const meine = zeilen.filter((z) => z.picking_id === kopf.id)
    const kontext: RegelKontext = {
      weightG: meine.reduce((sum, z) => sum + Number(z.weight_g), 0),
      zone: zoneForCountry(kopf.country),
      orderValue: Number(kopf.order_value),
      zeilen: meine.map((z) => ({
        sku: z.sku,
        qty: Number(z.qty),
        kleinpaket: z.kleinpaket,
        kleinpaketMaxQty: Number(z.kleinpaket_max_qty),
      })),
    }
    ergebnis.set(kopf.id, {
      ...wendeRegelnAn(regeln, kontext),
      weightG: kontext.weightG,
      zone: kontext.zone,
      orderValue: kontext.orderValue,
      positionen: meine.length,
      skus: meine.map((z) => z.sku ?? '').filter(Boolean),
    })
  }

  return ergebnis
}

export interface VersandbereitFilter {
  nurEinzelposition?: boolean
  sku?: string
  land?: string
  produkt?: string
}

export interface VersandbereitZeile {
  picking_id: string
  picking_number: string
  sales_order_id: string | null
  sales_order_number: string | null
  shopify_order_name: string | null
  customer_name: string | null
  ship_zip: string | null
  ship_city: string | null
  ship_country_code: string | null
  weight_g: number
  shipment_count: number
  vorschlag: Versandvorschlag | undefined
}

/**
 * Versandbereite Lieferungen samt Regelvorschlag, gefiltert — dieselbe
 * Funktion speist die Packtisch-Liste und den Massendruck, damit „was ich
 * sehe" und „was gedruckt wird" nie auseinanderlaufen.
 */
export async function versandbereitMitVorschlag(
  filter: VersandbereitFilter = {},
): Promise<VersandbereitZeile[]> {
  const rows = await sql<Omit<VersandbereitZeile, 'vorschlag'>[]>`
    select picking_id, picking_number, sales_order_id, sales_order_number,
           shopify_order_name, customer_name, ship_zip, ship_city,
           ship_country_code, weight_g, shipment_count
    from shipping_ready order by scheduled_date limit 200`

  const vorschlaege = await vorschlaegeFuerPickings(rows.map((r) => r.picking_id))
  const skuFilter = (filter.sku ?? '').trim().toLowerCase()
  const land = (filter.land ?? '').trim().toUpperCase()

  return rows
    .map((r) => ({ ...r, vorschlag: vorschlaege.get(r.picking_id) }))
    .filter((r) => {
      const v = r.vorschlag
      if (filter.nurEinzelposition && (v?.positionen ?? 0) !== 1) return false
      if (skuFilter && !v?.skus.some((s) => s.toLowerCase().includes(skuFilter))) return false
      if (land && (r.ship_country_code ?? 'DE').toUpperCase() !== land) return false
      // Der Produktfilter vergleicht das WIRKSAME Produkt: Regelvorschlag,
      // sonst die Länder-Rückfallebene — genau das käme aufs Label.
      const wirksam = v?.product ?? productForCountry(r.ship_country_code)
      if (filter.produkt && wirksam !== filter.produkt) return false
      return true
    })
}
