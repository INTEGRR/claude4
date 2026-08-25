/**
 * Verifikation der Odoo-Übernahme: Zähl- und Summenabgleiche zwischen
 * Staging-Quelle und KRNL-Ziel, als lesbarer Report. Läuft nach jedem
 * Import (auch im Dry-Run, vor dem Rollback) — der Report ist die erste
 * Abnahme, der Daten-TÜV (Ledger-Invarianten) die zweite.
 *
 * Wächst mit den Phasen: aktuell Stammdaten + Produkte; Belege, Bestand
 * und Werte kommen mit den Phasen 3–8 dazu.
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
