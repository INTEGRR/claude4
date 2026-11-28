import type { TransactionSql } from 'postgres'
import { sql, tx } from '@/db/client'
import { shopifyConfigured } from '@/modules/integrationen/shopify'
import { type ProduktEingabe, produktAnlegen } from '../../ki/produkt-anlegen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'
import { money, plural } from '@/modules/shared/format'

/** Ausführung der Produkt-Aktionen — dieselbe Fachlogik wie die KI-Aktion. */

export async function produktAnlegenAktion(
  p: ProduktEingabe,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ergebnis = await produktAnlegen(sql, p, ctx.actor)
  return {
    text:
      `Produkt „${p.name}" angelegt — ${plural(ergebnis.varianten, 'Variante', 'Varianten')}` +
      (ergebnis.benannt > 0 ? `, ${ergebnis.benannt} mit Artikelnummer` : '') +
      '.',
    link: `/produkte/${ergebnis.templateId}`,
    recordId: ergebnis.templateId,
  }
}

/**
 * Nach dem Speichern: ist das Produkt mit Shopify verknüpft, wandern die
 * Änderungen als Job in den Shop (Outbox; der Wrapper stößt den Runner an).
 */
async function shopifyNachziehen(templateId: string): Promise<void> {
  if (!shopifyConfigured()) return
  const [verknuepft] = await sql<{ eins: number }[]>`
    select 1 as eins from product_variants
    where template_id = ${templateId} and shopify_variant_id is not null and not shop_herausgeloest limit 1`
  if (!verknuepft) return
  await sql`select enqueue_job('shopify_product_push',
    ${sql.json({ template_id: templateId })}, ${`produkt-push:${templateId}`})`
}

export async function produktErfassen(p: {
  name: string
  uom_id: string
  list_price: number
  standard_cost: number
  weight_g: number
  can_be_sold: boolean
  can_be_purchased: boolean
  route_buy: boolean
  route_manufacture: boolean
  route_mto: boolean
  sku?: string
}): Promise<AktionsErgebnis> {
  const [tpl] = await sql<{ id: string }[]>`
    insert into product_templates (
      name, uom_id, list_price, standard_cost, weight_g,
      can_be_sold, can_be_purchased, route_buy, route_manufacture, route_mto)
    values (
      ${p.name}, ${p.uom_id}, ${p.list_price}, ${p.standard_cost}, ${p.weight_g},
      ${p.can_be_sold}, ${p.can_be_purchased},
      ${p.route_buy}, ${p.route_manufacture}, ${p.route_mto})
    returning id`

  await sql`select generate_variants(${tpl.id})`

  if (p.sku) {
    await sql`update product_variants set sku = ${p.sku}
              where template_id = ${tpl.id} and active and sku is null`
  }

  return { text: `Produkt „${p.name}" angelegt.`, link: `/produkte/${tpl.id}`, recordId: tpl.id }
}

export async function produktAendern(
  p: {
    name: string
    list_price: number
    standard_cost: number
    weight_g: number
    purchase_uom_id?: string
    invoice_policy: string
    bill_policy: string
    can_be_sold: boolean
    can_be_purchased: boolean
    route_buy: boolean
    route_manufacture: boolean
    route_mto: boolean
    category_id?: string
    sale_delay: number
    hs_code?: string
    country_of_origin?: string
    sale_tax_id?: string
    purchase_tax_id?: string
    description_sale?: string
    description_purchase?: string
    description_picking?: string
    responsible_id?: string
    tracking: string
    kleinpaket: boolean
    platzbedarf: number
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  await sql`
    update product_templates set
      name = ${p.name},
      list_price = ${p.list_price},
      standard_cost = ${p.standard_cost},
      weight_g = ${p.weight_g},
      purchase_uom_id = ${p.purchase_uom_id ?? null},
      invoice_policy = ${p.invoice_policy}::invoice_policy,
      bill_policy = ${p.bill_policy}::bill_policy,
      can_be_sold = ${p.can_be_sold},
      can_be_purchased = ${p.can_be_purchased},
      route_buy = ${p.route_buy},
      route_manufacture = ${p.route_manufacture},
      route_mto = ${p.route_mto},
      category_id = coalesce(${p.category_id ?? null}::uuid, category_id),
      sale_delay = ${p.sale_delay},
      hs_code = ${p.hs_code ?? null},
      country_of_origin = ${p.country_of_origin ?? null},
      sale_tax_id = ${p.sale_tax_id ?? null},
      purchase_tax_id = ${p.purchase_tax_id ?? null},
      -- Unverändert lassen, wenn sich nur Leerraum unterscheidet: das Formular
      -- gibt die Shop-Beschreibung (HTML) ohne ihre Zeilenumbrüche zurück.
      description_sale = case
        when regexp_replace(btrim(coalesce(description_sale, '')), '[[:space:]]+', ' ', 'g')
           = regexp_replace(btrim(coalesce(${p.description_sale ?? null}, '')), '[[:space:]]+', ' ', 'g')
        then description_sale else ${p.description_sale ?? null} end,
      description_purchase = ${p.description_purchase ?? null},
      description_picking = ${p.description_picking ?? null},
      responsible_id = ${p.responsible_id ?? null},
      tracking = ${p.tracking},
      kleinpaket = ${p.kleinpaket},
      platzbedarf = ${p.platzbedarf}
    where id = ${templateId}`
  await shopifyNachziehen(templateId)
  return { recordId: templateId }
}

export async function attributZuweisen(
  p: { attribute_id: string; value_ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  const [line] = await sql<{ id: string }[]>`
    insert into product_template_attribute_lines (template_id, attribute_id)
    values (${templateId}, ${p.attribute_id})
    on conflict (template_id, attribute_id) do update set attribute_id = excluded.attribute_id
    returning id`

  for (const valueId of p.value_ids) {
    await sql`insert into product_template_attribute_values (line_id, value_id)
              values (${line.id}, ${valueId}) on conflict do nothing`
  }

  await sql`select generate_variants(${templateId})`
  return { recordId: templateId }
}

export async function varianteCodes(
  p: { sku?: string; barcode?: string; shopify_variant_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const variantId = ctx.recordId!
  try {
    await sql`
      update product_variants
      set sku = ${p.sku ?? null}, barcode = ${p.barcode ?? null},
          shopify_variant_id = ${p.shopify_variant_id ?? null}
      where id = ${variantId}`
  } catch (err) {
    // Eindeutigkeitsverletzungen verständlich melden.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('product_variants_sku_key')) {
      throw new Error('Diese Artikelnummer ist bereits vergeben')
    }
    if (message.includes('product_variants_barcode_key')) {
      throw new Error('Dieser Barcode ist bereits vergeben')
    }
    throw err
  }

  const [variant] = await sql<{ template_id: string }[]>`
    select template_id from product_variants where id = ${variantId}`
  await shopifyNachziehen(variant.template_id)
  return { recordId: variant.template_id }
}

/**
 * SKU und EAN aller Varianten in einer Tabelle (A5). Geändert wird nur, was
 * sich unterscheidet; in zwei Schritten (erst leeren, dann setzen), damit
 * auch ein Tausch zweier Nummern an der Eindeutigkeit vorbeikommt.
 */
export async function variantenCodes(
  p: { zeilen: { variant_id: string; sku?: string; barcode?: string }[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  for (const feld of ['sku', 'barcode'] as const) {
    const gesehen = new Set<string>()
    for (const z of p.zeilen) {
      const wert = z[feld]
      if (!wert) continue
      if (gesehen.has(wert)) {
        throw new Error(`${feld === 'sku' ? 'Artikelnummer' : 'Barcode'} „${wert}" steht zweimal in der Tabelle`)
      }
      gesehen.add(wert)
    }
  }

  const geaendert = await tx(async (t) => {
    const stand = await t<{ id: string; sku: string | null; barcode: string | null }[]>`
      select id, sku, barcode from product_variants where template_id = ${templateId} for update`
    const jetzt = new Map(stand.map((v) => [v.id, v]))
    const neu = p.zeilen.filter((z) => {
      const v = jetzt.get(z.variant_id)
      if (!v) throw new Error('Eine Variante gehört nicht zu diesem Produkt')
      return (v.sku ?? '') !== (z.sku ?? '') || (v.barcode ?? '') !== (z.barcode ?? '')
    })
    if (neu.length === 0) return 0

    const ids = neu.map((z) => z.variant_id)
    for (const [feld, name] of [['sku', 'Artikelnummer'], ['barcode', 'Barcode']] as const) {
      const werte = neu.map((z) => z[feld]).filter((w): w is string => !!w)
      if (werte.length === 0) continue
      const [fremd] = await t<{ wert: string; name: string }[]>`
        select ${t(feld)} as wert, variant_display_name(id) as name from product_variants
        where ${t(feld)} = any(${werte}) and id <> all(${ids}::uuid[]) limit 1`
      if (fremd) throw new Error(`${name} „${fremd.wert}" ist bereits vergeben (${fremd.name})`)
    }
    await t`update product_variants set sku = null, barcode = null where id = any(${ids}::uuid[])`
    for (const z of neu) {
      await t`update product_variants set sku = ${z.sku ?? null}, barcode = ${z.barcode ?? null}
              where id = ${z.variant_id}`
    }
    await t`select log_event('product_template', ${templateId}, 'note',
      ${`Artikelnummern/Barcodes von ${plural(neu.length, 'Variante', 'Varianten')} geändert`}, ${ctx.actor})`
    return neu.length
  })

  if (geaendert > 0) await shopifyNachziehen(templateId)
  return {
    recordId: templateId,
    text: geaendert === 0 ? 'Keine Änderung.' : `${plural(geaendert, 'Variante', 'Varianten')} gespeichert.`,
  }
}

/**
 * Variante als eigenes Produkt herauslösen (0143): die Variante zieht mit
 * unveränderter ID in ein neues Produkt um — Bestand, Bewegungen,
 * Stücklistenzeilen und Belege hängen weiter an ihr. Das alte Produkt
 * verliert den Attributwert, die Shop-Verknüpfung bleibt an der Variante.
 */
interface Herausgeloest {
  neu: string
  v: { template_id: string; produkt: string; alt_name: string; price_extra: number; im_shop: boolean; geschwister: number; stueckliste: boolean }
}

/**
 * Kern des Herauslösens (0143): die Variante behält ihre ID und zieht auf ein
 * neues Produkt um. `auchLetzte`: die Sammel-Aktion löst alle Varianten —
 * die einzelne Aktion verweigert die letzte (dann reicht Umbenennen).
 */
async function herausloesenIn(
  t: TransactionSql,
  variantId: string,
  name: string,
  actor: string,
  auchLetzte = false,
): Promise<Herausgeloest> {
  const [v] = await t<Herausgeloest['v'][]>`
    select pv.template_id, pt.name as produkt, variant_display_name(pv.id) as alt_name, pv.price_extra::float,
           pv.shopify_variant_id is not null as im_shop,
           (select count(*)::int from product_variants x where x.template_id = pv.template_id and x.active and x.id <> pv.id) as geschwister,
           exists (select 1 from boms b where b.active and (b.variant_id = pv.id or b.template_id = pv.template_id)) as stueckliste
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${variantId} and pv.active
    for update of pv`
  if (!v) throw new Error('Variante nicht gefunden oder archiviert')
  if (v.geschwister === 0 && !auchLetzte) {
    throw new Error(`${v.alt_name} ist die einzige Variante von „${v.produkt}" — das Produkt einfach umbenennen.`)
  }
  if (v.stueckliste) {
    throw new Error(`„${v.produkt}" hat eine Stückliste — Varianten eines gefertigten Produkts lassen sich nicht herauslösen.`)
  }

  const [neu] = await t<{ id: string }[]>`
    insert into product_templates (
      name, type, uom_id, purchase_uom_id, list_price, standard_cost, weight_g, invoice_policy, bill_policy,
      route_mto, route_manufacture, route_buy, can_be_sold, can_be_purchased, category_id, sale_delay,
      hs_code, country_of_origin, sale_tax_id, purchase_tax_id, description_purchase, description_picking,
      responsible_id, tracking, kleinpaket, platzbedarf, shop_modus)
    select ${name}, type, uom_id, purchase_uom_id, list_price + ${v.price_extra}, standard_cost, weight_g, invoice_policy, bill_policy,
      route_mto, route_manufacture, route_buy, can_be_sold, can_be_purchased, category_id, sale_delay,
      hs_code, country_of_origin, sale_tax_id, purchase_tax_id, description_purchase, description_picking,
      responsible_id, tracking, kleinpaket, platzbedarf, shop_modus
    from product_templates where id = ${v.template_id}
    returning id`

  const werte = await t<{ ptav_id: string }[]>`
    delete from product_variant_attribute_values where variant_id = ${variantId} returning ptav_id`
  await t`
    update product_variants
       set template_id = ${neu.id}, price_extra = 0, shop_herausgeloest = ${v.im_shop}
     where id = ${variantId}`
  await t`select refresh_variant_display_name(${variantId})`
  // Lieferantenpreise der Variante ziehen mit.
  await t`update vendor_prices set template_id = ${neu.id} where variant_id = ${variantId}`
  // Der Attributwert am alten Produkt entfällt, wenn ihn keine Variante mehr trägt —
  // sonst erzeugte „Varianten erzeugen" die herausgelöste Kombination neu.
  await t`
    delete from product_template_attribute_values ptav
    where ptav.id = any(${werte.map((w) => w.ptav_id)}::uuid[])
      and not exists (select 1 from product_variant_attribute_values a where a.ptav_id = ptav.id)`

  await t`select log_event('product_template', ${neu.id}, 'note',
    ${`Aus „${v.produkt}" herausgelöst (vorher: ${v.alt_name})${v.im_shop ? ' — im Shop weiter Variante von „' + v.produkt + '"' : ''}`}, ${actor})`
  await t`select log_event('product_template', ${v.template_id}, 'note',
    ${`Variante herausgelöst: ${v.alt_name} ist jetzt das eigene Produkt „${name}"`}, ${actor})`
  return { neu: neu.id, v }
}

export async function varianteHerausloesen(p: { name: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const name = p.name.trim()
  const ergebnis = await tx((t) => herausloesenIn(t, ctx.recordId!, name, ctx.actor))
  return {
    recordId: ergebnis.neu,
    link: `/produkte/${ergebnis.neu}`,
    text:
      `„${name}" ist jetzt ein eigenes Produkt (vorher ${ergebnis.v.alt_name}). Bestand, Stücklisten und Belege hängen unverändert daran.` +
      (ergebnis.v.im_shop ? ` Im Shop bleibt es Variante von „${ergebnis.v.produkt}"; Titel und Preise werden nicht abgeglichen.` : ''),
  }
}

/**
 * Alle Varianten eines Produkts als eigene Produkte (2026-11-28): „ein Teil,
 * ein Artikel" für alles, was in Stücklisten steckt. Lieferantenpreise und
 * Schlagworte des alten Produkts gehen auf jedes neue über; das alte Produkt
 * bleibt als archivierte Hülle (seine Chronik, und im Shop das Produkt, dessen
 * Varianten die Artikel dort weiter sind).
 */
export async function variantenHerausloesen(
  p: { namen?: Record<string, string> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  const ergebnis = await tx(async (t) => {
    const [pt] = await t<{ name: string }[]>`
      select name from product_templates where id = ${templateId} and active for update`
    if (!pt) throw new Error('Produkt nicht gefunden oder archiviert')
    const varianten = await t<{ id: string; vorschlag: string }[]>`
      select pv.id, ${pt.name} || coalesce(' ' || (
               select string_agg(av.name, ' ' order by al.sequence, a.name)
               from product_variant_attribute_values pvav
               join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
               join product_template_attribute_lines al on al.id = ptav.line_id
               join product_attributes a on a.id = al.attribute_id
               join product_attribute_values av on av.id = ptav.value_id
               where pvav.variant_id = pv.id), '') as vorschlag
      from product_variants pv where pv.template_id = ${templateId} and pv.active
      order by pv.display_name`
    if (varianten.length < 2) {
      throw new Error(`„${pt.name}" hat nur eine Variante — es ist schon ein eigener Artikel.`)
    }
    const namen = varianten.map((v) => p.namen?.[v.id]?.trim() || v.vorschlag)
    const doppelt = namen.find((n, i) => namen.indexOf(n) !== i)
    if (doppelt) throw new Error(`Der Name „${doppelt}" ist doppelt vergeben — jedes neue Produkt braucht einen eigenen Namen.`)

    const neue: string[] = []
    let imShop = 0
    for (const [i, v] of varianten.entries()) {
      const r = await herausloesenIn(t, v.id, namen[i], ctx.actor, true)
      neue.push(r.neu)
      if (r.v.im_shop) imShop += 1
    }
    // Was am alten Produkt als Ganzem hing, gilt für jedes der neuen.
    await t`
      insert into vendor_prices (vendor_id, template_id, min_qty, price, currency, lead_time_days, vendor_product_code,
                                 sequence, discount, date_start, date_end, product_name, angebot_staffel_id, vertrag_id)
      select vp.vendor_id, n.id, vp.min_qty, vp.price, vp.currency, vp.lead_time_days, vp.vendor_product_code,
             vp.sequence, vp.discount, vp.date_start, vp.date_end, vp.product_name, vp.angebot_staffel_id, vp.vertrag_id
      from vendor_prices vp cross join unnest(${neue}::uuid[]) as n(id)
      where vp.template_id = ${templateId} and vp.variant_id is null`
    await t`
      insert into product_tag_links (template_id, tag_id)
      select n.id, l.tag_id from product_tag_links l cross join unnest(${neue}::uuid[]) as n(id)
      where l.template_id = ${templateId}
      on conflict do nothing`
    await t`update product_templates set active = false where id = ${templateId}`
    await t`select log_event('product_template', ${templateId}, 'note',
      ${`Alle ${varianten.length} Varianten sind jetzt eigene Produkte — dieses Produkt ist archiviert.`}, ${ctx.actor})`
    return { anzahl: varianten.length, namen, imShop, name: pt.name }
  })
  return {
    recordId: templateId,
    link: '/produkte',
    text:
      `${ergebnis.anzahl} eigene Produkte aus „${ergebnis.name}": ${ergebnis.namen.join(', ')}. ` +
      'Bestand, Zählungen, Stücklisten und Belege hängen unverändert an den Artikeln; das alte Produkt ist archiviert.' +
      (ergebnis.imShop > 0
        ? ` Im Shop ${ergebnis.imShop === 1 ? 'bleibt 1 Artikel Variante' : `bleiben ${ergebnis.imShop} Artikel Varianten`} von „${ergebnis.name}"; Bestand und Bestellungen laufen weiter, Titel und Preise werden nicht abgeglichen.`
        : ''),
    daten: { produkte: ergebnis.anzahl },
  }
}

/** Tabellen, die ein Löschen verhindern — in Betriebsdeutsch für die Meldung. */
const BELEG_WORTE: Record<string, string> = {
  stock_moves: 'Lagerbewegungen',
  stock_quants: 'Lagerbeständen',
  stock_valuation_layers: 'der Lagerbewertung',
  inventory_counts: 'Inventuren',
  sales_order_lines: 'Verkaufsaufträgen',
  purchase_order_lines: 'Bestellungen',
  manufacturing_orders: 'Fertigungsaufträgen',
  kundenrechnung_positionen: 'Rechnungen',
  repair_orders: 'Reparaturen',
  repair_parts: 'Reparaturen',
  retoure_positionen: 'Retouren',
  bom_lines: 'Stücklisten',
  bom_byproducts: 'Stücklisten',
  unbuild_orders: 'Demontagen',
  packagings: 'Verpackungen',
  landed_cost_allocations: 'Bezugsnebenkosten',
  stock_lot_quants: 'Chargenbeständen',
}

/**
 * Produkt löschen (2026-11-27). Regel aus dem Gründungsmodell: gelöscht wird
 * nur, was in keinem Beleg vorkommt — sonst archiviert. Die Datenbank ist
 * der Richter (Fremdschlüssel mit „restrict"): erst der Löschversuch, bei
 * einem Verweis das Archiv. Vorher drei harte Sperren, bei denen auch das
 * Archivieren Schaden anrichtete: Bestand, offene Bewegungen, Komponente
 * einer aktiven Stückliste.
 */
export async function produktLoeschen(_p: Record<string, never>, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  const [tpl] = await sql<{ name: string; im_shop: boolean; bestand: number; offen: number }[]>`
    select pt.name,
           exists (select 1 from product_variants pv where pv.template_id = pt.id and pv.shopify_variant_id is not null) as im_shop,
           coalesce((select sum(q.on_hand) from stock_quants q
                      join stock_locations l on l.id = q.location_id and l.type = 'internal'
                      join product_variants pv on pv.id = q.variant_id where pv.template_id = pt.id), 0)::float as bestand,
           (select count(*)::int from stock_moves m join product_variants pv on pv.id = m.variant_id
             where pv.template_id = pt.id and m.state not in ('done', 'cancel')) as offen
    from product_templates pt where pt.id = ${templateId}`
  if (!tpl) throw new Error('Produkt nicht gefunden')
  if (tpl.bestand !== 0) {
    throw new Error(`${tpl.name} hat noch Bestand (${tpl.bestand}) — erst ausbuchen (Inventur), dann löschen.`)
  }
  if (tpl.offen > 0) {
    throw new Error(
      `${tpl.name} hat ${plural(tpl.offen, 'offene Lagerbewegung', 'offene Lagerbewegungen')} (Aufträge, Fertigung, Lieferungen) — erst abschließen oder stornieren.`,
    )
  }
  const verbaut = await sql<{ name: string }[]>`
    select distinct pt.name from bom_lines l
    join boms b on b.id = l.bom_id and b.active
    join product_templates pt on pt.id = b.template_id and pt.active
    join product_variants pv on pv.id = l.component_variant_id
    where pv.template_id = ${templateId} and b.template_id <> ${templateId}
    order by pt.name limit 4`
  if (verbaut.length > 0) {
    throw new Error(
      `${tpl.name} ist Komponente in aktiven Stücklisten (${verbaut.slice(0, 3).map((v) => v.name).join(', ')}${verbaut.length > 3 ? ', …' : ''}) — dort erst entfernen oder ersetzen.`,
    )
  }
  const shop = tpl.im_shop ? ' Im Shop bleibt das Produkt bestehen — dort getrennt entfernen.' : ''

  try {
    await tx(async (t) => {
      await t`delete from product_templates where id = ${templateId}`
      await t`select log_event('product_template', ${templateId}, 'note', ${`Produkt gelöscht: ${tpl.name}`}, ${ctx.actor})`
    })
    return { text: `„${tpl.name}" gelöscht.${shop}`, link: '/produkte', daten: { art: 'geloescht' } }
  } catch (err) {
    const e = err as { code?: string; table_name?: string }
    if (e.code !== '23503') throw err
    await tx(async (t) => {
      await t`update product_variants set active = false where template_id = ${templateId}`
      await t`update product_templates set active = false where id = ${templateId}`
      await t`select log_event('product_template', ${templateId}, 'note', ${`Produkt archiviert (kommt in Belegen vor): ${tpl.name}`}, ${ctx.actor})`
    })
    const wo = BELEG_WORTE[e.table_name ?? ''] ?? 'Belegen'
    return {
      recordId: templateId,
      text: `„${tpl.name}" kommt in ${wo} vor und wurde deshalb archiviert statt gelöscht — wiederherstellbar über Produkte → Archivierte.${shop}`,
      link: '/produkte?archiv=1',
      daten: { art: 'archiviert' },
    }
  }
}

export async function produktWiederherstellen(_p: Record<string, never>, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const templateId = ctx.recordId!
  const [tpl] = await sql<{ name: string }[]>`
    update product_templates set active = true where id = ${templateId} and not active returning name`
  if (!tpl) throw new Error('Produkt nicht gefunden oder nicht archiviert')
  await sql`update product_variants set active = true where template_id = ${templateId}`
  await sql`select log_event('product_template', ${templateId}, 'note', 'Produkt wiederhergestellt', ${ctx.actor})`
  return { recordId: templateId, text: `„${tpl.name}" ist wieder aktiv.`, link: `/produkte/${templateId}` }
}

/** Shop-Projekt für mehrere Produkte auf einmal (Produktliste, 2026-11-27) — reine Anzeige-Gruppierung. */
export async function shopProjektSetzen(
  p: { template_ids: string[]; projekt: string | null },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const geaendert = await sql<{ id: string }[]>`
    update product_templates set projekt = ${p.projekt}
    where id = any(${p.template_ids}::uuid[]) and projekt is distinct from ${p.projekt}
    returning id`
  for (const g of geaendert) {
    await sql`select log_event('product_template', ${g.id}, 'note', ${`Shop-Projekt: ${p.projekt ?? '—'}`}, ${ctx.actor})`
  }
  return {
    text: p.projekt
      ? `${plural(p.template_ids.length, 'Produkt', 'Produkte')} im Shop-Projekt „${p.projekt}" (${geaendert.length} geändert).`
      : `Shop-Projekt bei ${plural(geaendert.length, 'Produkt', 'Produkten')} entfernt.`,
  }
}

/**
 * Nummerierte Auflage (0144): Auflage nach Namen anlegen oder anpassen und
 * die Produkte daran hängen. Die Nummern selbst vergibt die Datenbank
 * (auflage_nummern_vergeben) in Bestellreihenfolge.
 */
export async function auflageSetzen(
  p: { template_ids: string[]; name: string | null; von?: number; bis?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  return tx(async (t) => {
    if (!p.name) {
      const raus = await t<{ id: string }[]>`
        update product_templates set auflage_id = null
        where id = any(${p.template_ids}::uuid[]) and auflage_id is not null returning id`
      for (const r of raus) {
        await t`select log_event('product_template', ${r.id}, 'note', 'Nummerierte Auflage entfernt', ${ctx.actor})`
      }
      await t`select auflage_nummern_vergeben()`
      return { text: `Auflage bei ${plural(raus.length, 'Produkt', 'Produkten')} entfernt.` }
    }
    const von = p.von ?? 1
    const bis = p.bis as number
    const [vorher] = await t<{ id: string; hoechste: number | null; kleinste: number | null }[]>`
      select a.id, max(n.nummer) as hoechste, min(n.nummer) as kleinste
      from auflagen a left join auflage_nummern n on n.auflage_id = a.id
      where a.name = ${p.name} group by a.id`
    if (vorher?.hoechste != null && (vorher.hoechste > bis || (vorher.kleinste ?? von) < von)) {
      throw new Error(
        `„${p.name}" hat schon die Nummern ${vorher.kleinste}–${vorher.hoechste} vergeben — der Bereich muss sie enthalten.`,
      )
    }
    const [a] = await t<{ id: string }[]>`
      insert into auflagen (name, von, bis) values (${p.name}, ${von}, ${bis})
      on conflict (name) do update set von = excluded.von, bis = excluded.bis
      returning id`
    const geaendert = await t<{ id: string }[]>`
      update product_templates set auflage_id = ${a.id}
      where id = any(${p.template_ids}::uuid[]) and auflage_id is distinct from ${a.id} returning id`
    const text = `Nummerierte Auflage „${p.name}" (Nr. ${von}–${bis})`
    for (const g of geaendert) {
      await t`select log_event('product_template', ${g.id}, 'note', ${text}, ${ctx.actor})`
    }
    const [{ n }] = await t<{ n: number }[]>`
      select count(*)::int as n from product_templates where auflage_id = ${a.id}`
    return {
      recordId: a.id,
      text: `${text}: ${plural(n, 'Produkt', 'Produkte')} — jedes verkaufte Stück bekommt die nächste Nummer in Bestellreihenfolge.`,
    }
  })
}

export async function attributAnlegen(p: {
  name: string
  werte: string[]
}): Promise<AktionsErgebnis> {
  const [attr] = await sql<{ id: string }[]>`
    insert into product_attributes (name) values (${p.name})
    on conflict (name) do update set name = excluded.name
    returning id`

  for (const [index, value] of p.werte.entries()) {
    await sql`insert into product_attribute_values (attribute_id, name, sequence)
              values (${attr.id}, ${value}, ${(index + 1) * 10})
              on conflict (attribute_id, name) do nothing`
  }

  return { text: `Attribut „${p.name}" mit ${plural(p.werte.length, 'Wert', 'Werten')} angelegt.` }
}

export async function lieferantenpreisAnlegen(
  p: {
    vendor_id: string
    preis: number
    rabatt: number
    moq: number
    lieferzeit_tage: number
    gueltig_von?: string
    gueltig_bis?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [vendor] = await sql<{ name: string }[]>`
    select name from partners where id = ${p.vendor_id} and is_vendor`
  if (!vendor) throw new Error('Der gewählte Kontakt ist kein Lieferant.')

  await sql`
    insert into vendor_prices (vendor_id, template_id, price, discount, min_qty,
                               lead_time_days, date_start, date_end)
    values (${p.vendor_id}, ${ctx.recordId!}, ${p.preis}, ${p.rabatt}, ${p.moq},
            ${p.lieferzeit_tage}, ${p.gueltig_von ?? null}, ${p.gueltig_bis ?? null})`
  await sql`select log_event('product_template', ${ctx.recordId!}, 'note',
    ${`Lieferantenpreis: ${vendor.name} ab ${p.moq} Stück zu ${money(p.preis)}` +
      (p.rabatt > 0 ? ` (−${p.rabatt} %)` : '')}, ${ctx.actor})`
  return {
    text: `Staffel für ${vendor.name} angelegt${p.moq > 0 ? ` (ab ${p.moq})` : ''}.`,
    recordId: ctx.recordId,
  }
}

export async function lieferantenpreisLoeschen(
  p: { preis_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // template_id-Scope: eine fremde Preiszeile lässt sich über diese Aktion
  // nicht löschen, auch nicht mit geratener ID.
  const [zeile] = await sql<{ id: string }[]>`
    delete from vendor_prices
    where id = ${p.preis_id} and template_id = ${ctx.recordId!}
    returning id`
  if (!zeile) throw new Error('Diese Preiszeile gehört nicht zu diesem Produkt.')
  return { text: 'Preiszeile entfernt.', recordId: ctx.recordId }
}

export async function zuShopify(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const { pushProduktZuShopify } = await import('@/modules/integrationen/produkt-push')
  const r = await pushProduktZuShopify(ctx.recordId!)
  return {
    text: `In Shopify angelegt (${plural(r.varianten, 'Variante', 'Varianten')}) — der Bestand wird gleich gemeldet.`,
    recordId: ctx.recordId,
  }
}
