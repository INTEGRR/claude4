import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { type NachladeArt, NACHLADE_ARTEN, suchWoerter } from '@/modules/shared/auswahl-suche'

/**
 * Serversuche für Auswahlfelder (A2, Entscheidungslog 2026-11-27).
 *
 * Auswahlfelder bekommen ihre Einträge mit der Seite — höchstens 500. Mit
 * 557 Varianten und 2 561 Kunden fehlte, was dahinter liegt. Dieses
 * Endpunkt sucht in ALLEN Einträgen: jedes Wort muss vorkommen (Name,
 * Artikelnummer, Barcode bzw. Name, Ort, E-Mail), höchstens 40 Treffer.
 * Nur lesend, nur für angemeldete Benutzer.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  const params = new URL(request.url).searchParams
  const art = params.get('art') as NachladeArt
  if (!NACHLADE_ARTEN.includes(art)) return NextResponse.json({ error: 'Unbekannte Art' }, { status: 400 })
  const woerter = suchWoerter(params.get('q') ?? '')
  if (woerter.length === 0) return NextResponse.json({ treffer: [] })
  const muster = woerter.map((w) => `%${w.replace(/[\\%_]/g, (z) => `\\${z}`)}%`)

  if (art.startsWith('variante')) {
    const treffer = await sql<{ wert: string; text: string; suche: string }[]>`
      select pv.id as wert,
             coalesce(pv.display_name, pt.name) || coalesce(' · ' || nullif(pv.sku, ''), '') as text,
             coalesce(pv.barcode, '') || ' ' || pt.name as suche
      from product_variants pv join product_templates pt on pt.id = pv.template_id
      where pv.active and pt.active
        and (${art} <> 'variante-ware' or pt.type = 'goods')
        and (${art} <> 'variante-verkauf' or pt.can_be_sold)
        and (${art} <> 'variante-einkauf' or pt.can_be_purchased)
        and (select bool_and(lower(pt.name || ' ' || coalesce(pv.display_name, '') || ' ' || coalesce(pv.sku, '') || ' ' || coalesce(pv.barcode, '')) like m)
             from unnest(${muster}::text[]) m)
      order by 2 limit 40`
    return NextResponse.json({ treffer })
  }
  const treffer = await sql<{ wert: string; text: string; suche: string }[]>`
    select p.id as wert, p.name || coalesce(' · ' || nullif(p.city, ''), '') as text, coalesce(p.email, '') as suche
    from partners p
    where p.active
      and (${art} <> 'kunde' or p.is_customer)
      and (${art} <> 'lieferant' or p.is_vendor)
      and (select bool_and(lower(p.name || ' ' || coalesce(p.city, '') || ' ' || coalesce(p.email, '')) like m)
           from unnest(${muster}::text[]) m)
    order by lower(p.name) limit 40`
  return NextResponse.json({ treffer })
}
