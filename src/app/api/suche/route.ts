import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { aktionErlaubt } from '@/modules/prozesse/torwaechter'
import { formularFelder } from '@/modules/prozesse/schema-felder'

interface SuchTreffer {
  label: string
  hinweis: string
  link: string
  /** „P01670 freigeben": ausführbarer Prozessschritt am gefundenen Beleg. */
  aktion?: { name: string; record_id: string; felder_noetig: boolean }
}

/** Beleg + Aktion in einem Zug: „<nummer> <schritt>" matcht die JETZT
 *  möglichen Prozessschritte des Belegs. */
async function belegAktionen(
  q: string,
  role: Parameters<typeof canAccess>[0],
  befugnisse: readonly string[] = [],
): Promise<SuchTreffer[]> {
  const teile = q.split(/\s+/)
  if (teile.length < 2) return []
  const belegQ = `%${teile[0]}%`
  const rest = teile.slice(1).join(' ').toLowerCase()

  // Nur beleggebundene Modelle mit Prozess; je Art höchstens ein Treffer,
  // damit die Liste eine Antwort bleibt und kein zweites Suchergebnis.
  const belege = await sql<{ id: string; nummer: string; modell: string; link: string }[]>`
    (select id, number as nummer, 'sales_order' as modell, '/verkauf/' || id as link
       from sales_orders where number ilike ${belegQ} or shopify_order_name ilike ${belegQ}
       order by created_at desc limit 1)
    union all
    (select id, number, 'purchase_order', '/einkauf/' || id
       from purchase_orders where number ilike ${belegQ} order by created_at desc limit 1)
    union all
    (select id, number, 'manufacturing_order', '/fertigung/' || id
       from manufacturing_orders where number ilike ${belegQ} order by created_at desc limit 1)
    union all
    (select id, number, 'stock_picking', '/lager/' || id
       from stock_pickings where number ilike ${belegQ} order by created_at desc limit 1)`

  const ergebnis: SuchTreffer[] = []
  for (const beleg of belege) {
    const [wahl] = await sql<{ code: string | null }[]>`
      select prozess_fuer_beleg(${beleg.modell}, ${beleg.id}) as code`
    if (!wahl?.code) continue
    const schritte = await sql<
      { code: string; name: string; art: string; aktion: string | null;
        rollen: string[] | null; params: Record<string, unknown> | null }[]
    >`
      select code, name, art::text as art, aktion, rollen, params
      from prozess_naechste_schritte(${wahl.code}, ${beleg.id})`
    for (const s of schritte) {
      if (s.art !== 'aktion' || !s.aktion) continue
      if (!`${s.name}`.toLowerCase().includes(rest)) continue
      const eintrag = registrierteAktion(s.aktion)
      if (!eintrag || !aktionErlaubt(eintrag, role, befugnisse)) continue
      if (role !== 'admin' && s.rollen && s.rollen.length > 0 && !s.rollen.includes(role)) continue
      const vorbelegt = s.params ?? {}
      const offeneFelder = formularFelder(eintrag).filter((f) => !(f.name in vorbelegt))
      ergebnis.push({
        label: `${beleg.nummer} — ${s.name}`,
        hinweis: offeneFelder.length > 0 ? 'Aktion am Beleg (mit Angaben)' : 'Aktion am Beleg',
        link: beleg.link,
        aktion: {
          name: s.aktion,
          record_id: beleg.id,
          felder_noetig: offeneFelder.length > 0,
        },
      })
    }
  }
  return ergebnis.slice(0, 5)
}

/**
 * Belegsuche fürs Befehlsfeld: Nummern, Kunden, Lieferanten, Produkte —
 * je Bereich nur, was die Rolle sehen darf. Bewusst klein gehalten
 * (max. 4 Treffer je Gruppe), die Vollansichten haben eigene Listen.
 * Mit zweitem Wort („P01670 freigeben") kommen die passenden
 * Prozessschritte des Belegs als ausführbare Treffer dazu.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ treffer: [] })
  const muster = `%${q}%`

  const treffer: SuchTreffer[] = []
  const sieht = (bereich: Parameters<typeof canAccess>[1]) =>
    canAccess(user.role, bereich, user.befugnisse)

  // Beleg + Aktion zuerst — der spezifischste Treffer gehört nach oben.
  treffer.push(...(await belegAktionen(q, user.role, user.befugnisse)))

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
