import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'

/**
 * Belegsuche fürs Befehlsfeld: Nummern, Kunden, Lieferanten, Produkte —
 * je Bereich nur, was die Rolle sehen darf. Bewusst klein gehalten
 * (max. 4 Treffer je Gruppe), die Vollansichten haben eigene Listen.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ treffer: [] })
  const muster = `%${q}%`

  const treffer: { label: string; hinweis: string; link: string }[] = []
  const sieht = (bereich: Parameters<typeof canAccess>[1]) => canAccess(user.role, bereich)

  if (sieht('verkauf')) {
    for (const r of await sql<{ id: string; number: string; name: string | null; kunde: string }[]>`
      select so.id, so.number, so.shopify_order_name as name, p.name as kunde
      from sales_orders so join partners p on p.id = so.partner_id
      where so.number ilike ${muster} or so.shopify_order_name ilike ${muster}
         or p.name ilike ${muster}
      order by so.created_at desc limit 4`) {
      treffer.push({
        label: `${r.name ?? r.number} · ${r.kunde}`,
        hinweis: 'Verkaufsauftrag',
        link: `/verkauf/${r.id}`,
      })
    }
  }
  if (sieht('einkauf')) {
    for (const r of await sql<{ id: string; number: string; vendor: string }[]>`
      select po.id, po.number, p.name as vendor
      from purchase_orders po join partners p on p.id = po.vendor_id
      where po.number ilike ${muster} or p.name ilike ${muster}
      order by po.created_at desc limit 4`) {
      treffer.push({ label: `${r.number} · ${r.vendor}`, hinweis: 'Bestellung', link: `/einkauf/${r.id}` })
    }
  }
  if (sieht('fertigung')) {
    for (const r of await sql<{ id: string; number: string; produkt: string }[]>`
      select mo.id, mo.number, variant_display_name(mo.variant_id) as produkt
      from manufacturing_orders mo
      where mo.number ilike ${muster}
      order by mo.created_at desc limit 4`) {
      treffer.push({ label: `${r.number} · ${r.produkt}`, hinweis: 'Fertigungsauftrag', link: `/fertigung/${r.id}` })
    }
  }
  if (sieht('lager')) {
    for (const r of await sql<{ id: string; number: string }[]>`
      select id, number from stock_pickings
      where number ilike ${muster}
      order by created_at desc limit 4`) {
      treffer.push({ label: r.number, hinweis: 'Transfer', link: `/lager/${r.id}` })
    }
  }
  if (sieht('produkte')) {
    for (const r of await sql<{ id: string; label: string; sku: string | null }[]>`
      select pv.id, variant_display_name(pv.id) as label, pv.sku
      from product_variants pv join product_templates pt on pt.id = pv.template_id
      where pv.active and (pv.sku ilike ${muster} or pv.display_name ilike ${muster}
         or pt.name ilike ${muster})
      order by 2 limit 4`) {
      treffer.push({
        label: r.sku ? `${r.label} · ${r.sku}` : r.label,
        hinweis: 'Produkt',
        link: `/produkte/variante/${r.id}`,
      })
    }
  }
  if (sieht('kontakte')) {
    for (const r of await sql<{ id: string; name: string; art: string }[]>`
      select id, name,
             case when is_vendor and is_customer then 'Kunde + Lieferant'
                  when is_vendor then 'Lieferant' else 'Kunde' end as art
      from partners where active and name ilike ${muster}
      order by name limit 4`) {
      treffer.push({ label: r.name, hinweis: r.art, link: `/kontakte/${r.id}` })
    }
  }

  return NextResponse.json({ treffer: treffer.slice(0, 14) })
}
