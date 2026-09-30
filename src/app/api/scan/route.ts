import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { scanVarianten } from '@/modules/shared/scan'

/**
 * Löst einen gescannten Code auf: Belegnummern führen zum Beleg,
 * Produkt-Barcodes und SKUs zur Variante. Erst wie getippt, dann in
 * US-Belegung rückübersetzt (US-Scanner an deutschem Windows macht aus
 * „WH/OUT/00003" ein „WH-OUT-00003" — shared/scan.ts).
 */
export async function GET(request: Request) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })

  let url: string | null = null
  for (const kandidat of scanVarianten(code)) {
    const lookups: { url: string | null }[] = await sql`
      select url from (
        select '/lager/' || id as url, 1 as rank from stock_pickings where number = ${kandidat}
        union all
        select '/verkauf/' || id, 2 from sales_orders where number = ${kandidat} or shopify_order_name = ${kandidat}
        union all
        select '/einkauf/' || id, 3 from purchase_orders where number = ${kandidat}
        union all
        select '/fertigung/' || id, 4 from manufacturing_orders where number = ${kandidat}
        union all
        -- RMA-Nummer: wartet der Auftrag auf das Gerät, öffnet die Seite gleich
        -- das Formular „Gerät eingegangen" (Wareneingang per Scan).
        select '/reparatur/' || id
               || case when state in ('new', 'awaiting_device') then '?schritt=eingang' else '' end,
               5
        from repair_orders where number = ${kandidat}
        union all
        -- Retouren-Sendungsnummer vom DHL-Label des Kundenpakets → derselbe Weg.
        select '/reparatur/' || rl.repair_order_id || '?schritt=eingang', 5
        from return_labels rl
        where rl.shipment_number = ${kandidat} and rl.repair_order_id is not null
        union all
        -- Vorgangsnummer (z. B. aus der Bestätigungsmail einer Reparaturanfrage,
        -- die der Kunde auf den Karton schreibt) → der Vorgang selbst.
        select '/vorgaenge/' || id, 5 from vorgaenge where number = ${kandidat}
        union all
        select '/produkte/variante/' || id, 6 from product_variants
          where (barcode = ${kandidat} or sku = ${kandidat}) and active
        union all
        select '/versand?sendung=' || shipment_number, 7 from shipments where shipment_number = ${kandidat}
      ) hits order by rank limit 1`
    url = lookups[0]?.url ?? null
    if (url) break
  }

  if (!url) return NextResponse.json({ error: `Nichts gefunden zu "${code}"` }, { status: 404 })
  return NextResponse.json({ url })
}
