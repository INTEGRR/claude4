import { sql, tx } from '@/db/client'
import type { TransactionSql } from 'postgres'
import { alleLesen } from './api.ts'
import {
  type KrnlDaten,
  type OdooDaten,
  type Plan,
  planUebersicht,
  stuecklistenPlan,
} from './stuecklisten-plan.ts'

/**
 * Odoo-Stücklisten übernehmen (0090): lesen (Odoo per API, KRNL per SQL),
 * planen (stuecklisten-plan.ts, pur) und in EINER Transaktion schreiben.
 * Vorschau und Übernahme lesen beide frisch — es gibt keinen
 * zwischengespeicherten Plan, der veralten könnte.
 */

type M2o = [number, string] | false
const id = (w: M2o | undefined): number | null => (Array.isArray(w) ? w[0] : null)

interface RohVariante {
  id: number
  product_tmpl_id: M2o
  default_code: string | false
  barcode: string | false
  display_name: string
  product_template_attribute_value_ids: number[]
  standard_price: number
  weight: number
  active: boolean
  uom_id: M2o
}

const VARIANTEN_FELDER = [
  'id', 'product_tmpl_id', 'default_code', 'barcode', 'display_name',
  'product_template_attribute_value_ids', 'standard_price', 'weight', 'active', 'uom_id',
]

/** Alles aus Odoo, was die Stücklisten brauchen — und nichts sonst. */
export async function odooStuecklistenDaten(): Promise<OdooDaten> {
  const boms = await alleLesen<{
    id: number; product_tmpl_id: M2o; product_id: M2o; product_qty: number
    product_uom_id: M2o; type: string; sequence: number; consumption: string
  }>('mrp.bom', [], ['id', 'product_tmpl_id', 'product_id', 'product_qty', 'product_uom_id', 'type', 'sequence', 'consumption'])
  const bomIds = boms.map((b) => b.id)
  const zeilen = bomIds.length
    ? await alleLesen<{
        id: number; bom_id: M2o; product_id: M2o; product_qty: number; product_uom_id: M2o
        sequence: number; bom_product_template_attribute_value_ids: number[]
      }>('mrp.bom.line', [['bom_id', 'in', bomIds]], [
        'id', 'bom_id', 'product_id', 'product_qty', 'product_uom_id', 'sequence',
        'bom_product_template_attribute_value_ids',
      ])
    : []

  const fertigTmpl = [...new Set(boms.map((b) => id(b.product_tmpl_id)).filter((x): x is number => x !== null))]
  const fertig = fertigTmpl.length
    ? await alleLesen<RohVariante>('product.product', [['product_tmpl_id', 'in', fertigTmpl]], VARIANTEN_FELDER)
    : []
  const kompIds = [...new Set(zeilen.map((z) => id(z.product_id)).filter((x): x is number => x !== null))]
  const komp = kompIds.length
    ? await alleLesen<RohVariante>('product.product', [['id', 'in', kompIds], ['active', 'in', [true, false]]], VARIANTEN_FELDER)
    : []
  const varianten = [...new Map([...fertig, ...komp].map((v) => [v.id, v])).values()]

  const tmplIds = [...new Set(varianten.map((v) => id(v.product_tmpl_id)).filter((x): x is number => x !== null))]
  const vorlagen = tmplIds.length
    ? await alleLesen<{ id: number; name: string; uom_id: M2o; route_ids: number[] }>(
        'product.template', [['id', 'in', tmplIds], ['active', 'in', [true, false]]], ['id', 'name', 'uom_id', 'route_ids'])
    : []
  const routenIds = [...new Set(vorlagen.flatMap((t) => t.route_ids))]
  const regeln = routenIds.length
    ? await alleLesen<{ route_id: M2o; action: string; procure_method: string }>(
        'stock.rule', [['route_id', 'in', routenIds]], ['route_id', 'action', 'procure_method'])
    : []
  const routeFertigen = new Set(regeln.filter((r) => r.action === 'manufacture').map((r) => id(r.route_id)))
  const routeAuftrag = new Set(
    regeln.filter((r) => ['make_to_order', 'mts_else_mto'].includes(r.procure_method)).map((r) => id(r.route_id)),
  )

  const ptavIds = [...new Set([
    ...varianten.flatMap((v) => v.product_template_attribute_value_ids),
    ...zeilen.flatMap((z) => z.bom_product_template_attribute_value_ids),
  ])]
  const ptavs = ptavIds.length
    ? await alleLesen<{ id: number; attribute_id: M2o }>(
        'product.template.attribute.value', [['id', 'in', ptavIds]], ['id', 'attribute_id'])
    : []
  const uoms = await alleLesen<{ id: number; name: string; factor: number; category_id: M2o }>(
    'uom.uom', [['active', 'in', [true, false]]], ['id', 'name', 'factor', 'category_id'])

  const kompTmpl = [...new Set(komp.map((v) => id(v.product_tmpl_id)).filter((x): x is number => x !== null))]
  const lieferanten = kompTmpl.length
    ? await alleLesen<{
        partner_id: M2o; product_tmpl_id: M2o; product_id: M2o; price: number; min_qty: number
        delay: number; currency_id: M2o; product_code: string | false
      }>('product.supplierinfo', [['product_tmpl_id', 'in', kompTmpl]], [
        'partner_id', 'product_tmpl_id', 'product_id', 'price', 'min_qty', 'delay', 'currency_id', 'product_code',
      ])
    : []
  const partnerIds = [...new Set(lieferanten.map((l) => id(l.partner_id)).filter((x): x is number => x !== null))]
  const partner = partnerIds.length
    ? await alleLesen<{ id: number; name: string; email: string | false }>('res.partner', [['id', 'in', partnerIds]], ['id', 'name', 'email'])
    : []
  const partnerNach = new Map(partner.map((p) => [p.id, p]))
  const quants = kompIds.length
    ? await alleLesen<{ product_id: M2o; quantity: number }>(
        'stock.quant', [['product_id', 'in', kompIds], ['location_id.usage', '=', 'internal']], ['product_id', 'quantity'])
    : []
  const bestand: Record<number, number> = {}
  for (const q of quants) {
    const v = id(q.product_id)
    if (v !== null) bestand[v] = (bestand[v] ?? 0) + Number(q.quantity)
  }

  // Bestände ALLER Artikel an internen Lagerorten (Fertigprodukte, Zubehör
  // wie Deskmats) — nicht nur der Stücklisten-Komponenten (seit 2026-09-30).
  const alleQuants = await alleLesen<{ product_id: M2o; quantity: number }>(
    'stock.quant', [['location_id.usage', '=', 'internal']], ['product_id', 'quantity'])
  const lagerMenge = new Map<number, number>()
  for (const q of alleQuants) {
    const v = id(q.product_id)
    if (v !== null) lagerMenge.set(v, (lagerMenge.get(v) ?? 0) + Number(q.quantity))
  }
  const lagerIds = [...lagerMenge].filter(([, m]) => m > 0).map(([v]) => v)
  const bekannt = new Map(varianten.map((v) => [v.id, v]))
  const fehlend = lagerIds.filter((v) => !bekannt.has(v))
  const nachgelesen = fehlend.length
    ? await alleLesen<RohVariante>('product.product', [['id', 'in', fehlend], ['active', 'in', [true, false]]], VARIANTEN_FELDER)
    : []
  for (const v of nachgelesen) bekannt.set(v.id, v)
  const lagerArtikel = lagerIds
    .map((v) => bekannt.get(v))
    .filter((v): v is RohVariante => Boolean(v))
    .map((v) => ({
      id: v.id,
      code: v.default_code || null,
      barcode: v.barcode || null,
      name: v.display_name,
      menge: lagerMenge.get(v.id) ?? 0,
      standardPreis: Number(v.standard_price) || 0,
    }))

  return {
    varianten: varianten.map((v) => ({
      id: v.id,
      tmplId: id(v.product_tmpl_id) ?? 0,
      code: v.default_code || null,
      barcode: v.barcode || null,
      name: v.display_name,
      ptavIds: v.product_template_attribute_value_ids,
      standardPreis: Number(v.standard_price) || 0,
      gewichtKg: Number(v.weight) || null,
      uomId: id(v.uom_id) ?? 0,
      aktiv: v.active,
    })),
    vorlagen: vorlagen.map((t) => ({
      id: t.id,
      name: t.name,
      uomId: id(t.uom_id) ?? 0,
      fertigen: t.route_ids.some((r) => routeFertigen.has(r)),
      aufAuftrag: t.route_ids.some((r) => routeAuftrag.has(r)),
    })),
    ptavs: ptavs.map((p) => ({ id: p.id, attributId: id(p.attribute_id) ?? 0 })),
    boms: boms.map((b) => ({
      id: b.id,
      tmplId: id(b.product_tmpl_id) ?? 0,
      variantId: id(b.product_id),
      menge: Number(b.product_qty) || 1,
      uomId: id(b.product_uom_id) ?? 0,
      typ: b.type,
      verbrauch: b.consumption,
      sequenz: b.sequence ?? 0,
    })),
    bomZeilen: zeilen.map((z) => ({
      id: z.id,
      bomId: id(z.bom_id) ?? 0,
      variantId: id(z.product_id) ?? 0,
      menge: Number(z.product_qty),
      uomId: id(z.product_uom_id) ?? 0,
      sequenz: z.sequence ?? 0,
      filterPtavIds: z.bom_product_template_attribute_value_ids,
    })),
    uoms: uoms.map((u) => ({ id: u.id, name: u.name, faktor: Number(u.factor), kategorieId: id(u.category_id) ?? 0 })),
    lieferanten: lieferanten.map((l) => {
      const p = partnerNach.get(id(l.partner_id) ?? -1)
      return {
        tmplId: id(l.product_tmpl_id) ?? 0,
        variantId: id(l.product_id),
        partnerId: id(l.partner_id) ?? 0,
        partnerName: p?.name ?? (Array.isArray(l.partner_id) ? l.partner_id[1] : 'Lieferant'),
        partnerEmail: p?.email || null,
        preis: Number(l.price),
        minMenge: Number(l.min_qty) || 0,
        lieferzeitTage: Number(l.delay) || 0,
        waehrung: Array.isArray(l.currency_id) ? l.currency_id[1] : 'EUR',
        produktCode: l.product_code || null,
      }
    }),
    bestand,
    lagerArtikel,
  }
}

/** Der KRNL-Stand, gegen den geplant wird. */
export async function krnlStuecklistenDaten(ziel: typeof sql | TransactionSql = sql): Promise<KrnlDaten> {
  const varianten = await ziel<{
    id: string; template_id: string; sku: string | null; barcode: string | null; aktiv: boolean
    standard_cost: number; uom_name: string; bestand: number
  }[]>`
    select pv.id, pv.template_id, pv.sku, pv.barcode, (pv.active and pt.active) as aktiv,
           pt.standard_cost, u.name as uom_name, coalesce(on_hand_qty(pv.id, null), 0)::float as bestand
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    join uoms u on u.id = pt.uom_id`
  const uoms = await ziel<{ name: string; kategorie: string; ratio: number }[]>`
    select u.name, c.name as kategorie, u.ratio from uoms u join uom_categories c on c.id = u.category_id`
  const manuell = await ziel<{ template_id: string; variant_id: string | null }[]>`
    select template_id, variant_id from boms where active and herkunft is null`
  const verweise = await ziel<{ odoo_id: number; krnl_id: string }[]>`
    select odoo_id, krnl_id from odoo_verweise where odoo_tabelle = 'product_product'`
  const werte = await ziel<{ variant_id: string; attribut_id: string; ptav_id: string; name: string }[]>`
    select pvav.variant_id, l.attribute_id as attribut_id, pvav.ptav_id, pa.name || ': ' || pav.name as name
    from product_variant_attribute_values pvav
    join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
    join product_template_attribute_lines l on l.id = ptav.line_id
    join product_attributes pa on pa.id = l.attribute_id
    join product_attribute_values pav on pav.id = ptav.value_id`
  return {
    varianten: varianten.map((v) => ({
      id: v.id,
      templateId: v.template_id,
      sku: v.sku,
      barcode: v.barcode,
      aktiv: v.aktiv,
      standardCost: Number(v.standard_cost),
      uomName: v.uom_name,
      bestand: Number(v.bestand),
    })),
    uoms: uoms.map((u) => ({ name: u.name, kategorie: u.kategorie, ratio: Number(u.ratio) })),
    manuelleStuecklisten: manuell.map((m) => ({ templateId: m.template_id, variantId: m.variant_id })),
    verweise: Object.fromEntries(verweise.map((v) => [Number(v.odoo_id), v.krnl_id])),
    werte: werte.map((w) => ({ variantId: w.variant_id, attributId: w.attribut_id, ptavId: w.ptav_id, name: w.name })),
  }
}

export async function stuecklistenVorschau(): Promise<{ plan: Plan; uebersicht: ReturnType<typeof planUebersicht> }> {
  const plan = stuecklistenPlan(await odooStuecklistenDaten(), await krnlStuecklistenDaten())
  return { plan, uebersicht: planUebersicht(plan) }
}

export interface UebernahmeBericht {
  komponentenNeu: number
  komponentenZugeordnet: number
  preise: number
  lieferantenpreise: number
  bestand: number
  /** Bestände weiterer Artikel (keine Komponenten), nur wo KRNL 0 hat. */
  bestandWeitere: number
  /** Alte Stücklisten dieses Imports, die eine neue Form ablöst (deaktiviert). */
  stuecklistenAbgeloest: number
  stuecklistenNeu: number
  stuecklistenUnveraendert: number
  routen: number
  blockiert: number
}

async function merken(
  t: TransactionSql,
  odooId: number,
  krnlId: string,
  herkunft: 'angelegt' | 'zugeordnet',
  lauf: string,
): Promise<void> {
  // Die erste Herkunft bleibt: was KRNL einmal angelegt hat, bleibt „angelegt".
  await t`
    insert into odoo_verweise (odoo_tabelle, odoo_id, krnl_tabelle, krnl_id, lauf, herkunft)
    values ('product_product', ${odooId}, 'product_variants', ${krnlId}, ${lauf}, ${herkunft})
    on conflict (odoo_tabelle, odoo_id) do update set krnl_id = excluded.krnl_id`
}

/** Plant frisch und schreibt alles in einer Transaktion. */
export async function stuecklistenUebernehmen(von: string): Promise<UebernahmeBericht> {
  const odoo = await odooStuecklistenDaten()
  return tx(async (t) => {
    const plan = stuecklistenPlan(odoo, await krnlStuecklistenDaten(t))
    const lauf = `odoo-api ${new Date().toISOString().slice(0, 16)}`
    const bericht: UebernahmeBericht = {
      komponentenNeu: 0, komponentenZugeordnet: 0, preise: 0, lieferantenpreise: 0, bestand: 0, bestandWeitere: 0,
      stuecklistenAbgeloest: 0, stuecklistenNeu: 0, stuecklistenUnveraendert: 0, routen: 0, blockiert: plan.blockiert.length,
    }
    const uomId = new Map(
      (await t<{ id: string; name: string }[]>`select id, name from uoms`).map((u) => [u.name, u.id]),
    )
    const [lager] = await t<{ id: string }[]>`select id from stock_locations where full_path = 'WH/Stock'`

    // 1. Komponenten: zuordnen oder anlegen; Preis nur, wo KRNL 0 hat.
    const krnlVon = new Map<number, string>()
    for (const k of plan.komponenten) {
      if (k.krnlId) {
        krnlVon.set(k.odooId, k.krnlId)
        await merken(t, k.odooId, k.krnlId, 'zugeordnet', lauf)
        bericht.komponentenZugeordnet++
        if (k.preis !== null) {
          const r = await t`
            update product_templates set standard_cost = ${k.preis}
            where id = (select template_id from product_variants where id = ${k.krnlId})
              and standard_cost <= 0`
          bericht.preise += r.count
        }
        continue
      }
      const [tpl] = await t<{ id: string }[]>`
        insert into product_templates (name, uom_id, can_be_sold, can_be_purchased, route_buy,
                                       weight_g, standard_cost, description, zusatz)
        values (${k.name}, ${uomId.get(k.uomName!)!}, false, true, true, ${k.gewichtG ?? 0},
                ${k.preis ?? 0}, 'Komponente aus Odoo übernommen.', ${t.json({ odoo: 'komponente' })})
        returning id`
      await t`select generate_variants(${tpl.id})`
      const [v] = await t<{ id: string }[]>`
        update product_variants set sku = ${k.code} where template_id = ${tpl.id} returning id`
      krnlVon.set(k.odooId, v.id)
      await merken(t, k.odooId, v.id, 'angelegt', lauf)
      bericht.komponentenNeu++
      if (k.preis !== null) bericht.preise++
    }

    // 2. Lieferanten und ihre Preise (ohne Doppel je Lieferant/Artikel/Menge).
    for (const k of plan.komponenten) {
      const variant = krnlVon.get(k.odooId)!
      for (const l of k.lieferanten) {
        const [bekannt] = await t<{ id: string }[]>`
          select id from partners
          where lower(name) = lower(${l.partnerName})
             or (${l.partnerEmail}::text is not null and lower(email) = lower(${l.partnerEmail}))
          order by is_vendor desc limit 1`
        const vendor = bekannt?.id ?? (await t<{ id: string }[]>`
          insert into partners (name, is_vendor, email) values (${l.partnerName}, true, ${l.partnerEmail})
          returning id`)[0].id
        if (bekannt) await t`update partners set is_vendor = true where id = ${vendor}`
        const r = await t`
          insert into vendor_prices (vendor_id, template_id, variant_id, min_qty, price, currency,
                                     lead_time_days, vendor_product_code)
          select ${vendor}, pv.template_id, ${l.variantId === null ? null : variant}, ${l.minMenge},
                 ${l.preis}, ${l.waehrung}, ${l.lieferzeitTage}, ${l.produktCode}
          from product_variants pv where pv.id = ${variant}
            and not exists (
              select 1 from vendor_prices vp
              where vp.vendor_id = ${vendor} and vp.template_id = pv.template_id
                and vp.min_qty = ${l.minMenge})`
        bericht.lieferantenpreise += r.count
      }
    }

    // 3. Bestand — nach dem Preis, damit er gleich richtig bewertet wird;
    //    nur, wo KRNL am Lagerort nichts hat.
    for (const k of plan.komponenten) {
      if (k.bestand === null || !lager) continue
      const variant = krnlVon.get(k.odooId)!
      const [ist] = await t<{ menge: number }[]>`
        select coalesce(sum(on_hand), 0)::float as menge from stock_quants
        where variant_id = ${variant} and location_id = ${lager.id}`
      if (Number(ist.menge) > 0) continue
      const [zaehlung] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
        values (${lager.id}, ${variant}, ${k.bestand}, 0, ${`Odoo-Übernahme ${lauf}`}) returning id`
      await t`select inventory_apply(${zaehlung.id}, ${von})`
      bericht.bestand++
    }

    // 3b. Bestände weiterer Artikel (Fertigprodukte, Zubehör) — Preis vor
    //     Bestand, damit bewertet; nur, wo KRNL am Lagerort nichts hat.
    for (const l of plan.lagerbestaende) {
      if (l.status !== 'buchen' || !l.krnlId || !lager) continue
      if (l.preis !== null) {
        const r = await t`
          update product_templates set standard_cost = ${l.preis}
          where id = (select template_id from product_variants where id = ${l.krnlId}) and standard_cost <= 0`
        bericht.preise += r.count
      }
      const [ist] = await t<{ menge: number }[]>`
        select coalesce(sum(on_hand), 0)::float as menge from stock_quants
        where variant_id = ${l.krnlId} and location_id = ${lager.id}`
      if (Number(ist.menge) > 0) continue
      const [zaehlung] = await t<{ id: string }[]>`
        insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
        values (${lager.id}, ${l.krnlId}, ${l.menge}, 0, ${`Odoo-Übernahme ${lauf}`}) returning id`
      await t`select inventory_apply(${zaehlung.id}, ${von})`
      await merken(t, l.odooId, l.krnlId, 'zugeordnet', lauf)
      bericht.bestandWeitere++
    }

    // 4. Stücklisten: eigene aus früheren Läufen ersetzen, wenn sie sich
    //    geändert haben (deaktivieren statt löschen — Fertigungsaufträge
    //    verweisen darauf); von Hand angelegte bleiben (Plan blockiert sie).
    // Frühere eigene Stücklisten einer Vorlage, die die neue Form nicht mehr
    // hat (z. B. Varianten-Stücklisten, die jetzt EINE Stückliste mit
    // Variantenfiltern ersetzt), werden deaktiviert — sonst gewännen sie in
    // resolve_bom vor der Vorlagen-Stückliste.
    const neueFormen = new Map<string, Set<string>>()
    for (const s of plan.stuecklisten) {
      neueFormen.set(s.templateId, new Set([...(neueFormen.get(s.templateId) ?? []), s.variantId ?? '']))
    }
    for (const [templateId, formen] of neueFormen) {
      const r = await t`
        update boms set active = false
        where herkunft = 'odoo' and active and template_id = ${templateId}
          and not (coalesce(variant_id::text, '') = any(${[...formen]}::text[]))`
      bericht.stuecklistenAbgeloest += r.count
    }

    for (const s of plan.stuecklisten) {
      const zeilen = s.zeilen.map((z) => ({
        variant: krnlVon.get(z.komponente)!,
        menge: z.menge,
        uom: uomId.get(z.uomName)!,
        filter: [...(z.filter ?? [])].sort(),
      }))
      const signatur = zeilen
        .map((z) => `${z.variant}:${Number(z.menge)}:${z.uom}:${z.filter.join(',')}`)
        .sort()
        .join('|')
      const alte = await t<{ id: string; signatur: string }[]>`
        select b.id, coalesce(string_agg(z.teil, '|' order by z.teil), '') as signatur
        from boms b
        left join lateral (
          select l.component_variant_id || ':' || (l.qty::float)::text || ':' || l.uom_id || ':' ||
                 coalesce((select string_agg(f.ptav_id::text, ',' order by f.ptav_id::text)
                           from bom_line_variant_filters f where f.bom_line_id = l.id), '') as teil
          from bom_lines l where l.bom_id = b.id
        ) z on true
        where b.herkunft = 'odoo' and b.active and b.template_id = ${s.templateId}
          and b.variant_id is not distinct from ${s.variantId}
        group by b.id`
      if (alte.length === 1 && alte[0].signatur === signatur) {
        bericht.stuecklistenUnveraendert++
        continue
      }
      await t`update boms set active = false
              where herkunft = 'odoo' and active and template_id = ${s.templateId}
                and variant_id is not distinct from ${s.variantId}`
      const [bom] = await t<{ id: string }[]>`
        insert into boms (template_id, variant_id, qty, uom_id, bom_type, consumption, herkunft, code, note)
        select ${s.templateId}, ${s.variantId}, 1, pt.uom_id, ${s.typ}::bom_type,
               ${s.verbrauch}::consumption_rule, 'odoo', ${`Odoo ${s.odooBomIds.join('+')}`},
               ${`Aus Odoo übernommen (mrp.bom ${s.odooBomIds.join(', ')}) für ${s.skus.join(', ')}`}
        from product_templates pt where pt.id = ${s.templateId}
        returning id`
      let folge = 10
      for (const z of zeilen) {
        const [zeile] = await t<{ id: string }[]>`
          insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
          values (${bom.id}, ${folge}, ${z.variant}, ${z.menge}, ${z.uom}, 'backflush')
          returning id`
        // „Auf Varianten anwenden" wie in Odoo.
        for (const ptav of z.filter) {
          await t`insert into bom_line_variant_filters (bom_line_id, ptav_id) values (${zeile.id}, ${ptav})
                  on conflict do nothing`
        }
        folge += 10
      }
      bericht.stuecklistenNeu++
    }

    // 5. Routen wie in Odoo — nur einschalten, nie abschalten.
    for (const r of plan.routen) {
      const erg = await t`
        update product_templates
        set route_manufacture = route_manufacture or ${r.fertigen},
            route_mto = route_mto or ${r.aufAuftrag}
        where id = ${r.templateId}
          and (route_manufacture <> (route_manufacture or ${r.fertigen})
               or route_mto <> (route_mto or ${r.aufAuftrag}))`
      bericht.routen += erg.count
    }

    // 6. Fertigprodukte als zugeordnet merken (Herkunfts-Doku).
    for (const f of plan.fertigprodukte) {
      if (f.status === 'zugeordnet' && f.krnlId) await merken(t, f.odooId, f.krnlId, 'zugeordnet', lauf)
    }

    await t`select log_event('odoo', gen_random_uuid(), 'note',
      ${`Odoo-Stücklisten übernommen: ${bericht.stuecklistenNeu} Stücklisten, ${bericht.komponentenNeu} neue Komponenten, ${bericht.blockiert} blockiert`},
      ${von})`
    return bericht
  })
}
