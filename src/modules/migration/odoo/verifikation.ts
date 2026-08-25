/**
 * Verifikation der Odoo-Übernahme: Zähl- und Summenabgleiche zwischen
 * Staging-Quelle und KRNL-Ziel, als lesbarer Report. Läuft nach jedem
 * Import (auch im Dry-Run, vor dem Rollback) — der Report ist die erste
 * Abnahme, der Daten-TÜV (Ledger-Invarianten) die zweite.
 *
 * Deckt alle Phasen ab: Zählungen je Entität, Bestandsmenge je Variante,
 * offene Liefermenge und die Netto-Auftragssumme als Substanzprobe. Nach
 * einem vollständigen Lauf müssen alle Zeilen ohne Hinweis exakt aufgehen.
 */

import type { Sql, TransactionSql } from 'postgres'
import type { OdooSql } from './quelle.ts'

type Ziel = Sql | TransactionSql

interface Abgleich {
  name: string
  quelle: number
  ziel: number
  /** Erwartete Abweichung mit Grund — dann gilt die Zeile nicht als Fehler. */
  hinweis?: string
}

async function zahl(sql: OdooSql | Ziel, query: Promise<{ n: number }[]>): Promise<number> {
  void sql
  const [zeile] = await query
  return Number(zeile?.n ?? 0)
}

export async function zaehlAbgleich(quelle: OdooSql, ziel: Ziel): Promise<string> {
  const zeilen: Abgleich[] = []

  zeilen.push({
    name: 'Partner',
    quelle: await zahl(quelle, quelle<{ n: number }[]>`select count(*)::int as n from res_partner`),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`
        select count(*)::int as n from partners p
        where exists (select 1 from odoo_verweise v
                      where v.krnl_tabelle = 'partners' and v.krnl_id = p.id)`,
    ),
  })
  zeilen.push({
    name: 'Produktvorlagen',
    quelle: await zahl(quelle, quelle<{ n: number }[]>`select count(*)::int as n from product_template`),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`
        select count(*)::int as n from product_templates t
        where exists (select 1 from odoo_verweise v
                      where v.krnl_tabelle = 'product_templates' and v.krnl_id = t.id)`,
    ),
  })
  zeilen.push({
    name: 'Varianten (zugeordnet)',
    quelle: await zahl(quelle, quelle<{ n: number }[]>`select count(*)::int as n from product_product`),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`
        select count(*)::int as n from odoo_verweise where odoo_tabelle = 'product_product'`,
    ),
    hinweis: 'tote Odoo-Varianten ohne Belegbezug bleiben bewusst unzugeordnet',
  })
  zeilen.push({
    name: 'Lieferantenpreise',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`select count(*)::int as n from product_supplierinfo`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`
        select count(*)::int as n from odoo_verweise where odoo_tabelle = 'product_supplierinfo'`,
    ),
  })
  zeilen.push({
    name: 'Stücklisten',
    quelle: await zahl(quelle, quelle<{ n: number }[]>`select count(*)::int as n from mrp_bom`),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'mrp_bom'`,
    ),
  })
  zeilen.push({
    name: 'Meldebestände',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`select count(*)::int as n from stock_warehouse_orderpoint`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`
        select count(*)::int as n from odoo_verweise where odoo_tabelle = 'stock_warehouse_orderpoint'`,
    ),
  })

  zeilen.push({
    name: 'Verkaufsaufträge',
    quelle: await zahl(quelle, quelle<{ n: number }[]>`select count(*)::int as n from sale_order`),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'sale_order'`,
    ),
  })
  zeilen.push({
    name: 'Auftragszeilen',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`select count(*)::int as n from sale_order_line`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'sale_order_line'`,
    ),
  })
  zeilen.push({
    name: 'Bestellungen',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`select count(*)::int as n from purchase_order`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'purchase_order'`,
    ),
  })
  zeilen.push({
    name: 'Fertigungsaufträge',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`select count(*)::int as n from mrp_production`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'mrp_production'`,
    ),
    hinweis: 'offene entstehen erst in Phase 7',
  })
  zeilen.push({
    name: 'Reparaturen (mit Produkt)',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`
        select count(*)::int as n from repair_order where product_id is not null`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'repair_order'`,
    ),
    hinweis: 'offene entstehen erst in Phase 7',
  })
  zeilen.push({
    name: 'Eingangsrechnungen',
    quelle: await zahl(
      quelle,
      quelle<{ n: number }[]>`
        select count(*)::int as n from account_move
        where move_type = 'in_invoice' and partner_id is not null`,
    ),
    ziel: await zahl(
      ziel,
      ziel<{ n: number }[]>`select count(*)::int as n from odoo_verweise where odoo_tabelle = 'account_move'`,
    ),
  })

  // Bestandsmenge je Variante: Σ interne Odoo-Quants ↔ KRNL on_hand.
  const quellBestand = new Map(
    (
      await quelle<{ variant_id: number; menge: number }[]>`
        select q.product_id as variant_id, round(sum(q.quantity)::numeric, 3) as menge
        from stock_quant q join stock_location l on l.id = q.location_id
        where l.usage = 'internal' group by q.product_id`
    ).map((z) => [z.variant_id, Number(z.menge)]),
  )
  const zielBestand = new Map(
    (
      await ziel<{ odoo_id: number; menge: number }[]>`
        select v.odoo_id, round(coalesce(sum(q.on_hand), 0)::numeric, 3) as menge
        from odoo_verweise v
        left join stock_quants q on q.variant_id = v.krnl_id
          and q.location_id in (select id from stock_locations where type in ('internal', 'transit'))
        where v.odoo_tabelle = 'product_product'
        group by v.odoo_id`
    ).map((z) => [Number(z.odoo_id), Number(z.menge)]),
  )
  let bestandAbweichungen = 0
  for (const [variantId, menge] of quellBestand) {
    if (Math.abs((zielBestand.get(variantId) ?? 0) - menge) > 0.0001) bestandAbweichungen++
  }
  for (const [variantId, menge] of zielBestand) {
    if (!quellBestand.has(variantId) && Math.abs(menge) > 0.0001) bestandAbweichungen++
  }
  zeilen.push({
    name: 'Bestand: Varianten mit Abweichung',
    quelle: 0,
    ziel: bestandAbweichungen,
  })

  // Offene Liefermenge (bestätigte, nicht voll gelieferte Aufträge).
  const [offenQuelle] = await quelle<{ summe: number }[]>`
    select coalesce(round(sum(l.product_uom_qty - coalesce(l.qty_delivered, 0))::numeric, 3), 0) as summe
    from sale_order_line l join sale_order o on o.id = l.order_id
    where o.state = 'sale' and l.display_type is null
      and l.product_uom_qty > coalesce(l.qty_delivered, 0)`
  const [offenZiel] = await ziel<{ summe: number }[]>`
    select coalesce(round(sum(l.qty - l.qty_delivered)::numeric, 3), 0) as summe
    from sales_order_lines l join sales_orders o on o.id = l.order_id
    where o.state = 'sale' and l.display_type is null and l.qty > l.qty_delivered
      and exists (select 1 from odoo_verweise v
                  where v.krnl_tabelle = 'sales_orders' and v.krnl_id = o.id)`
  zeilen.push({
    name: 'Offene Liefermenge',
    quelle: Number(offenQuelle.summe),
    ziel: Number(offenZiel.summe),
  })

  // Substanzprobe: Netto-Zeilensumme aller nicht stornierten Aufträge — die
  // Zählungen können stimmen und die Beträge trotzdem falsch sein.
  const [umsatzQuelle] = await quelle<{ summe: number }[]>`
    select coalesce(round(sum(l.price_unit * l.product_uom_qty
             * (1 - coalesce(l.discount, 0) / 100))::numeric, 2), 0) as summe
    from sale_order_line l
    join sale_order o on o.id = l.order_id
    where o.state <> 'cancel' and l.display_type is null`
  const [umsatzZiel] = await ziel<{ summe: number }[]>`
    select coalesce(round(sum(l.price_unit * l.qty * (1 - coalesce(l.discount, 0) / 100))::numeric, 2), 0) as summe
    from sales_order_lines l
    join sales_orders o on o.id = l.order_id
    where o.state <> 'cancel' and l.display_type is null
      and exists (select 1 from odoo_verweise v
                  where v.krnl_tabelle = 'sales_orders' and v.krnl_id = o.id)`
  zeilen.push({
    name: 'Netto-Auftragssumme (EUR)',
    quelle: Number(umsatzQuelle.summe),
    ziel: Number(umsatzZiel.summe),
  })

  const breite = Math.max(...zeilen.map((z) => z.name.length))
  const report = zeilen.map((z) => {
    const status = z.quelle === z.ziel ? 'ok' : z.hinweis ? `≠ (${z.hinweis})` : 'ABWEICHUNG'
    return `  ${z.name.padEnd(breite)}  Quelle ${String(z.quelle).padStart(6)}  Ziel ${String(z.ziel).padStart(6)}  ${status}`
  })
  const fehler = zeilen.filter((z) => z.quelle !== z.ziel && !z.hinweis)
  return [
    ...report,
    fehler.length > 0
      ? `  → ${fehler.length} unerklärte Abweichung(en) — vor dem nächsten Schritt klären.`
      : '  → alle Zählungen stimmen.',
  ].join('\n')
}
