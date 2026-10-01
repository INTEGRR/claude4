/**
 * Shop-Verfügbarkeit (0101) — Lesesicht für /verkauf/shop-verfuegbarkeit:
 * je Shop-Projekt die Farb-Artikel (eigene Shopify-Produkte), je Artikel die
 * Optionen wie im Shop, je Optionswert die Teile, die er braucht, mit
 * Bestand und Regel, und was an Shopify geht (Soll) gegen den gelesenen
 * Shop-Stand (Ist). Rechnet nichts selbst: baubar(…, true) und
 * shopify_soll_menge() sind die einzige Wahrheit.
 */
import { sql } from '@/db/client'

export type Modus = 'auto' | 'immer' | 'aus'

export interface TeilInfo {
  id: string
  sku: string | null
  name: string
  je: number
  frei: number
  nutzbar: number
  oosUnter: number | null
  zurueck: boolean
  /** Für wie viele Tastaturen das Teil (nach Regeln) reicht. */
  reicht: number
}

export interface VarianteInfo {
  id: string
  sku: string | null
  name: string
  modus: Modus | null
  ptavs: string[]
  baubar: number
  engpass: string | null
  soll: number
  shopQty: number | null
  shopVerkaufbar: boolean | null
}

export interface WertInfo {
  ptavId: string
  name: string
  gesperrt: boolean
  teile: TeilInfo[]
  varianten: number
  aktiv: number
  maxSoll: number
  shopVerkaufbar: number
  shopBekannt: number
}

export interface OptionInfo {
  name: string
  werte: WertInfo[]
}

export interface ArtikelInfo {
  id: string
  name: string
  kurz: string
  projekt: string | null
  modus: Modus
  gemeinsam: TeilInfo[]
  optionen: OptionInfo[]
  varianten: VarianteInfo[]
  aktiv: number
  maxSoll: number
}

export interface ProjektInfo {
  name: string
  artikel: ArtikelInfo[]
}

export interface WeitererArtikel {
  id: string
  templateId: string
  sku: string | null
  name: string
  modus: Modus | null
  artikelModus: Modus
  frei: number
  oosUnter: number | null
  zurueck: boolean
  soll: number
  shopQty: number | null
  shopVerkaufbar: boolean | null
}

const n = (x: unknown) => Number(x ?? 0)

/** Name ohne Projekt-Präfix — als Pill-Beschriftung („Cosmic Purple"). */
export function kurzname(name: string, projekt: string | null): string {
  const ohneSku = name.replace(/^\[[^\]]*\]\s*/, '')
  if (!projekt) return ohneSku
  const i = ohneSku.toLowerCase().indexOf(projekt.toLowerCase())
  if (i < 0) return ohneSku
  const rest = (ohneSku.slice(0, i) + ohneSku.slice(i + projekt.length)).replace(/^[\s\-–—:%()]+|[\s\-–—:]+$/g, '').trim()
  return rest || ohneSku
}

export async function shopVerfuegbarkeit(): Promise<{
  projekte: ProjektInfo[]
  teile: (TeilInfo & { artikel: number })[]
  weitere: WeitererArtikel[]
  zuletztGelesen: string | null
}> {
  const artikel = await sql<{ id: string; name: string; projekt: string | null; shop_modus: Modus }[]>`
    select pt.id, pt.name, pt.projekt, pt.shop_modus
    from product_templates pt
    where pt.active and exists (
      select 1 from product_variants pv
      where pv.template_id = pt.id and pv.active and pv.shopify_variant_id is not null and ist_made_to_order(pv.id))
    order by coalesce(pt.projekt, pt.name), pt.name`
  const ids = artikel.map((a) => a.id)

  const [varianten, optionen, zeilen, weitere, [stand]] = await Promise.all([
    sql<{
      id: string; template_id: string; sku: string | null; name: string; shop_modus: Modus | null; ptavs: string[]
      baubar: number; engpass: string | null; soll: number; shop_qty: number | null; shop_verkaufbar: boolean | null
    }[]>`
      select pv.id, pv.template_id, nullif(pv.sku, '') as sku, pv.display_name as name, pv.shop_modus,
             coalesce((select array_agg(a.ptav_id::text) from product_variant_attribute_values a where a.variant_id = pv.id), '{}') as ptavs,
             b.menge::float as baubar, e.display_name as engpass,
             shopify_soll_menge(pv.id) as soll,
             s.shop_qty::float as shop_qty, s.shop_verkaufbar
      from product_variants pv
      cross join lateral baubar(pv.id, 0, true) b
      left join product_variants e on e.id = b.engpass
      left join shopify_inventory_state s on s.variant_id = pv.id
      where pv.template_id = any(${ids}::uuid[]) and pv.active and pv.shopify_variant_id is not null
      order by pv.display_name`,
    sql<{ template_id: string; option: string; ptav_id: string; wert: string; gesperrt: boolean }[]>`
      select al.template_id, pa.name as option, ptav.id as ptav_id, pav.name as wert,
             exists (select 1 from shop_option_sperren s where s.template_id = al.template_id and s.ptav_id = ptav.id) as gesperrt
      from product_template_attribute_lines al
      join product_attributes pa on pa.id = al.attribute_id
      join product_template_attribute_values ptav on ptav.line_id = al.id
      join product_attribute_values pav on pav.id = ptav.value_id
      where al.template_id = any(${ids}::uuid[])
      order by al.template_id, al.sequence, pav.sequence, pav.name`,
    sql<{
      template_id: string; teil: string; sku: string | null; name: string; je: number; frei: number; nutzbar: number
      oos_unter: number | null; zurueck: boolean; filter: string[]
    }[]>`
      select b.template_id, c.id as teil, nullif(c.sku, '') as sku, c.display_name as name,
             (bl.qty / b.qty)::float as je, free_to_use(c.id)::float as frei,
             greatest(shop_frei(c.id), 0)::float as nutzbar, c.shop_oos_unter as oos_unter, c.shop_zurueckhalten as zurueck,
             coalesce((select array_agg(f.ptav_id::text) from bom_line_variant_filters f where f.bom_line_id = bl.id), '{}') as filter
      from boms b
      join bom_lines bl on bl.bom_id = b.id
      join product_variants c on c.id = bl.component_variant_id
      where b.template_id = any(${ids}::uuid[]) and b.active and b.variant_id is null and b.bom_type = 'manufacture'
      order by bl.sequence`,
    sql<{
      id: string; template_id: string; sku: string | null; name: string; shop_modus: Modus | null; t_modus: Modus
      frei: number; oos_unter: number | null; zurueck: boolean; soll: number; shop_qty: number | null; shop_verkaufbar: boolean | null
    }[]>`
      select pv.id, pv.template_id, nullif(pv.sku, '') as sku, pv.display_name as name, pv.shop_modus, pt.shop_modus as t_modus,
             free_to_use(pv.id)::float as frei, pv.shop_oos_unter as oos_unter, pv.shop_zurueckhalten as zurueck,
             shopify_soll_menge(pv.id) as soll, s.shop_qty::float as shop_qty, s.shop_verkaufbar
      from product_variants pv
      join product_templates pt on pt.id = pv.template_id
      left join shopify_inventory_state s on s.variant_id = pv.id
      where pv.active and pt.active and pv.shopify_variant_id is not null and not ist_made_to_order(pv.id)
      order by pt.name, pv.display_name`,
    sql<{ zuletzt: string | null }[]>`select max(shop_seen_at)::text as zuletzt from shopify_inventory_state`,
  ])

  const teilInfo = (z: (typeof zeilen)[number]): TeilInfo => ({
    id: z.teil,
    sku: z.sku,
    name: z.name.replace(/^\[[^\]]*\]\s*/, ''),
    je: n(z.je),
    frei: n(z.frei),
    nutzbar: n(z.nutzbar),
    oosUnter: z.oos_unter,
    zurueck: z.zurueck,
    reicht: n(z.je) > 0 ? Math.floor(n(z.nutzbar) / n(z.je)) : 0,
  })

  const projekte = new Map<string, ProjektInfo>()
  for (const a of artikel) {
    const vs: VarianteInfo[] = varianten
      .filter((v) => v.template_id === a.id)
      .map((v) => ({
        id: v.id, sku: v.sku, name: v.name, modus: v.shop_modus, ptavs: v.ptavs,
        baubar: n(v.baubar), engpass: v.engpass?.replace(/^\[[^\]]*\]\s*/, '') ?? null, soll: n(v.soll),
        shopQty: v.shop_qty === null ? null : n(v.shop_qty), shopVerkaufbar: v.shop_verkaufbar,
      }))
    const eigeneZeilen = zeilen.filter((z) => z.template_id === a.id)
    const opts = new Map<string, OptionInfo>()
    for (const o of optionen.filter((o) => o.template_id === a.id)) {
      if (!opts.has(o.option)) opts.set(o.option, { name: o.option, werte: [] })
      const mit = vs.filter((v) => v.ptavs.includes(o.ptav_id))
      const bekannt = mit.filter((v) => v.shopVerkaufbar !== null)
      opts.get(o.option)!.werte.push({
        ptavId: o.ptav_id,
        name: o.wert,
        gesperrt: o.gesperrt,
        teile: eigeneZeilen.filter((z) => z.filter.includes(o.ptav_id)).map(teilInfo),
        varianten: mit.length,
        aktiv: mit.filter((v) => v.soll > 0).length,
        maxSoll: Math.max(0, ...mit.map((v) => v.soll)),
        shopVerkaufbar: bekannt.filter((v) => v.shopVerkaufbar).length,
        shopBekannt: bekannt.length,
      })
    }
    const info: ArtikelInfo = {
      id: a.id,
      name: a.name,
      kurz: kurzname(a.name, a.projekt),
      projekt: a.projekt,
      modus: a.shop_modus,
      gemeinsam: eigeneZeilen.filter((z) => z.filter.length === 0).map(teilInfo).sort((x, y) => x.reicht - y.reicht),
      optionen: [...opts.values()],
      varianten: vs,
      aktiv: vs.filter((v) => v.soll > 0).length,
      maxSoll: Math.max(0, ...vs.map((v) => v.soll)),
    }
    const schluessel = a.projekt ?? a.name
    if (!projekte.has(schluessel)) projekte.set(schluessel, { name: schluessel, artikel: [] })
    projekte.get(schluessel)!.artikel.push(info)
  }

  // Teile-Regeln: jedes Teil einmal, mit Zahl der Artikel, die es brauchen.
  const teile = new Map<string, { info: TeilInfo; artikel: Set<string> }>()
  for (const z of zeilen) {
    if (!teile.has(z.teil)) teile.set(z.teil, { info: teilInfo(z), artikel: new Set() })
    teile.get(z.teil)!.artikel.add(z.template_id)
  }

  return {
    projekte: [...projekte.values()],
    teile: [...teile.values()]
      .map((t) => ({ ...t.info, artikel: t.artikel.size }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    weitere: weitere.map((w) => ({
      id: w.id, templateId: w.template_id, sku: w.sku, name: w.name, modus: w.shop_modus, artikelModus: w.t_modus,
      frei: n(w.frei), oosUnter: w.oos_unter, zurueck: w.zurueck, soll: n(w.soll),
      shopQty: w.shop_qty === null ? null : n(w.shop_qty), shopVerkaufbar: w.shop_verkaufbar,
    })),
    zuletztGelesen: stand?.zuletzt ?? null,
  }
}
