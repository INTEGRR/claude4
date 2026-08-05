import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'

/**
 * Löst einen gescannten Code auf: Belegnummern führen zum Beleg,
 * Produkt-Barcodes und SKUs zur Variante.
 */
export async function GET(request: Request) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })

  const lookups: { url: string | null }[] = await sql`
    select url from (
      select '/lager/' || id as url, 1 as rank from stock_pickings where number = ${code}
      union all
      select '/verkauf/' || id, 2 from sales_orders where number = ${code} or shopify_order_name = ${code}
      union all
      select '/einkauf/' || id, 3 from purchase_orders where number = ${code}
      union all
      select '/fertigung/' || id, 4 from manufacturing_orders where number = ${code}
      union all
      select '/reparatur/' || id, 5 from repair_orders where number = ${code}
      union all
      select '/produkte/variante/' || id, 6 from product_variants
        where (barcode = ${code} or sku = ${code}) and active
      union all
      select '/versand?sendung=' || shipment_number, 7 from shipments where shipment_number = ${code}
    ) hits order by rank limit 1`

  const url = lookups[0]?.url
  if (!url) return NextResponse.json({ error: `Nichts gefunden zu "${code}"` }, { status: 404 })
  return NextResponse.json({ url })
}
