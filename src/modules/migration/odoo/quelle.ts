/**
 * Der Quell-Vertrag der Odoo-Übernahme: ALLE Lese-Queries gegen die
 * Staging-Datenbank (dump.sql → `odoo_quelle`) stehen in dieser einen
 * Datei — wer wissen will, welche Odoo-Spalten der Import überhaupt
 * anfasst, liest sie hier. Bauform wie src/modules/demo/daten.ts: kein
 * 'server-only', keine `@/`-Importe, der sql-Client wird injiziert.
 *
 * Übersetzbare Namen kommen als rohes jsonb (`{"de_DE": …}`) und werden
 * erst im Mapper (`uebersetzung()`) zu Text — die Queries interpretieren
 * nichts, sie liefern.
 */

import type { Sql } from 'postgres'

// Die Staging-DB ist read-only-Gebiet: derselbe Client-Typ wie überall,
// aber diese Datei enthält ausschließlich SELECTs.
export type OdooSql = Sql

/**
 * Verifikation nach dem Laden des Dumps: stimmen die Kernzahlen, ist die
 * Staging-DB vollständig (ON_ERROR_STOP=0 lässt Owner-/Extension-Fehler
 * durch — das hier fängt echte Lücken).
 */
export async function kernzahlen(sql: OdooSql): Promise<Record<string, number>> {
  const [zeile] = await sql<Record<string, number>[]>`
    select
      (select count(*)::int from res_partner)        as res_partner,
      (select count(*)::int from product_template)   as product_template,
      (select count(*)::int from product_product)    as product_product,
      (select count(*)::int from sale_order)         as sale_order,
      (select count(*)::int from sale_order_line)    as sale_order_line,
      (select count(*)::int from purchase_order)     as purchase_order,
      (select count(*)::int from mrp_production)     as mrp_production,
      (select count(*)::int from stock_quant)        as stock_quant,
      (select count(*)::int from account_move)       as account_move,
      (select count(*)::int from repair_order)       as repair_order`
  return zeile
}

// --- Phase 1: Stammdaten ----------------------------------------------------

export interface OdooUomKategorie {
  id: number
  name: unknown
}

export async function uomKategorien(sql: OdooSql): Promise<OdooUomKategorie[]> {
  return sql<OdooUomKategorie[]>`select id, name from uom_category order by id`
}

export interface OdooUom {
  id: number
  name: unknown
  category_id: number
  factor: number
  uom_type: 'reference' | 'bigger' | 'smaller'
  active: boolean
}

/** Alle Einheiten — auch inaktive, denn Belege können sie referenzieren. */
export async function uoms(sql: OdooSql): Promise<OdooUom[]> {
  return sql<OdooUom[]>`
    select id, name, category_id, factor, uom_type, active
    from uom_uom order by category_id, id`
}

export interface OdooSteuer {
  id: number
  name: unknown
  amount: number
  amount_type: string
  type_tax_use: string
  price_include: boolean
  description: unknown
}

/**
 * Nur die Steuern, die irgendwo hängen — die deutsche l10n bringt 50 mit,
 * genutzt sind eine Handvoll (Produkt-Zuordnungen, Auftrags- und
 * Bestellzeilen, Rechnungszeilen).
 */
export async function genutzteSteuern(sql: OdooSql): Promise<OdooSteuer[]> {
  return sql<OdooSteuer[]>`
    select distinct t.id, t.name, t.amount, t.amount_type, t.type_tax_use,
           coalesce(t.price_include_override = 'tax_included', false) as price_include,
           t.description
    from account_tax t
    where t.id in (select tax_id from product_taxes_rel)
       or t.id in (select tax_id from product_supplier_taxes_rel)
       or t.id in (select account_tax_id from account_tax_sale_order_line_rel)
       or t.id in (select account_tax_id from account_tax_purchase_order_line_rel)
    order by t.id`
}

export interface OdooZahlungsbedingung {
  id: number
  name: unknown
  active: boolean
  early_discount: boolean
  discount_percentage: number | null
  discount_days: number | null
  /** Längste Zeile bestimmt die Fälligkeit (Mehrzeiler wie „30 % sofort, Rest in 60 Tagen"). */
  nb_days: number
  delay_type: string
  zeilen: number
}

export async function zahlungsbedingungen(sql: OdooSql): Promise<OdooZahlungsbedingung[]> {
  return sql<OdooZahlungsbedingung[]>`
    select t.id, t.name, t.active, t.early_discount, t.discount_percentage, t.discount_days,
           coalesce(max(l.nb_days), 0)::int as nb_days,
           coalesce((array_agg(l.delay_type order by l.nb_days desc))[1], 'days_after') as delay_type,
           count(l.id)::int as zeilen
    from account_payment_term t
    left join account_payment_term_line l on l.payment_id = t.id
    group by t.id
    order by t.id`
}

export interface OdooKategorie {
  id: number
  name: unknown
  parent_id: number | null
  complete_name: string | null
}

export async function produktKategorien(sql: OdooSql): Promise<OdooKategorie[]> {
  return sql<OdooKategorie[]>`
    select id, name, parent_id, complete_name
    from product_category order by parent_id nulls first, id`
}

export interface OdooPartner {
  id: number
  name: string
  parent_id: number | null
  is_company: boolean
  active: boolean
  street: string | null
  street2: string | null
  zip: string | null
  city: string | null
  country_code: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  website: string | null
  vat: string | null
  company_registry: string | null
  ref: string | null
  function: string | null
  comment: string | null
  vorname: string | null
  shopify_customer_id: string | null
  ist_kunde: boolean
  ist_lieferant: boolean
  payment_term: unknown
  supplier_payment_term: unknown
}

/**
 * Alle Partner — auch inaktive/archivierte, denn historische Belege
 * referenzieren sie. Kunde/Lieferant leitet sich aus dem Odoo-Rank UND der
 * tatsächlichen Belegexistenz ab (der Rank ist bei Importkunden nicht
 * immer gepflegt).
 */
export async function partner(sql: OdooSql): Promise<OdooPartner[]> {
  return sql<OdooPartner[]>`
    select p.id, p.name, p.parent_id, p.is_company, p.active,
           p.street, p.street2, p.zip, p.city, c.code as country_code,
           p.email, p.phone, p.mobile, p.website, p.vat, p.company_registry,
           p.ref, p.function, p.comment,
           p.x_studio_vorname as vorname,
           p.x_studio_shopify_customer_id as shopify_customer_id,
           (coalesce(p.customer_rank, 0) > 0
             or exists (select 1 from sale_order so where so.partner_id = p.id)) as ist_kunde,
           (coalesce(p.supplier_rank, 0) > 0
             or exists (select 1 from purchase_order po where po.partner_id = p.id)
             or exists (select 1 from product_supplierinfo si where si.partner_id = p.id)) as ist_lieferant,
           p.property_payment_term_id as payment_term,
           p.property_supplier_payment_term_id as supplier_payment_term
    from res_partner p
    left join res_country c on c.id = p.country_id
    order by p.id`
}

export interface OdooFirma {
  name: string
  street: string | null
  zip: string | null
  city: string | null
  country_code: string | null
  email: string | null
  phone: string | null
  vat: string | null
}

export async function firma(sql: OdooSql): Promise<OdooFirma | null> {
  const zeilen = await sql<OdooFirma[]>`
    select co.name, p.street, p.zip, p.city, c.code as country_code,
           p.email, p.phone, p.vat
    from res_company co
    join res_partner p on p.id = co.partner_id
    left join res_country c on c.id = p.country_id
    order by co.id limit 1`
  return zeilen[0] ?? null
}

// --- Phase 2: Produkte ------------------------------------------------------

export interface OdooAttribut {
  id: number
  name: unknown
  display_type: string
  sequence: number
}

export async function attribute(sql: OdooSql): Promise<OdooAttribut[]> {
  return sql<OdooAttribut[]>`
    select id, name, display_type, coalesce(sequence, 10) as sequence
    from product_attribute order by id`
}

export interface OdooAttributWert {
  id: number
  attribute_id: number
  name: unknown
  html_color: string | null
  sequence: number
}

export async function attributWerte(sql: OdooSql): Promise<OdooAttributWert[]> {
  return sql<OdooAttributWert[]>`
    select id, attribute_id, name, html_color, coalesce(sequence, 10) as sequence
    from product_attribute_value order by attribute_id, id`
}

export interface OdooTemplate {
  id: number
  name: unknown
  active: boolean
  is_storable: boolean
  typ: string
  tracking: string | null
  categ_id: number
  uom_id: number
  uom_po_id: number
  list_price: number | null
  weight: number | null
  sale_ok: boolean
  purchase_ok: boolean
  sale_delay: number | null
  invoice_policy: string | null
  purchase_method: string | null
  hs_code: string | null
  country_of_origin_code: string | null
  /** Übersetzbare HTML-Felder — jsonb, durch htmlZuText() ziehen. */
  description: unknown
  description_sale: unknown
  description_purchase: unknown
  description_picking: unknown
  print_on_mo: unknown
  out_of_stock_limit: unknown
  sale_tax_ids: number[] | null
  purchase_tax_ids: number[] | null
  hat_bom: boolean
  hat_mto_route: boolean
}

export async function templates(sql: OdooSql): Promise<OdooTemplate[]> {
  return sql<OdooTemplate[]>`
    select t.id, t.name, t.active, t.is_storable, t.type as typ, t.tracking,
           t.categ_id, t.uom_id, t.uom_po_id,
           t.list_price, t.weight, t.sale_ok, t.purchase_ok, t.sale_delay,
           t.invoice_policy, t.purchase_method, t.hs_code,
           c.code as country_of_origin_code,
           t.description, t.description_sale, t.description_purchase, t.description_picking,
           t.x_studio_print_on_manufacturing_order as print_on_mo,
           t.x_studio_out_of_stock_limit as out_of_stock_limit,
           (select array_agg(tax_id) from product_taxes_rel r where r.prod_id = t.id)
             as sale_tax_ids,
           (select array_agg(tax_id) from product_supplier_taxes_rel r where r.prod_id = t.id)
             as purchase_tax_ids,
           exists (select 1 from mrp_bom b where b.product_tmpl_id = t.id and b.active) as hat_bom,
           exists (select 1 from stock_route_product rp
                   join stock_route r on r.id = rp.route_id
                   where rp.product_id = t.id
                     and lower(r.name::text) like '%mto%') as hat_mto_route
    from product_template t
    left join res_country c on c.id = t.country_of_origin
    order by t.id`
}

export interface OdooAttributZeile {
  id: number
  template_id: number
  attribute_id: number
}

export async function attributZeilen(sql: OdooSql): Promise<OdooAttributZeile[]> {
  return sql<OdooAttributZeile[]>`
    select id, product_tmpl_id as template_id, attribute_id
    from product_template_attribute_line
    where active
    order by product_tmpl_id, id`
}

export interface OdooPtav {
  id: number
  template_id: number
  attribute_id: number
  value_id: number
  price_extra: number | null
  attribut_name: unknown
  wert_name: unknown
}

/** product.template.attribute.value — der Anker für Varianten und „Apply on Variants". */
export async function ptavs(sql: OdooSql): Promise<OdooPtav[]> {
  return sql<OdooPtav[]>`
    select ptav.id, ptav.product_tmpl_id as template_id, ptav.attribute_id,
           ptav.product_attribute_value_id as value_id, ptav.price_extra,
           pa.name as attribut_name, pav.name as wert_name
    from product_template_attribute_value ptav
    join product_attribute pa on pa.id = ptav.attribute_id
    join product_attribute_value pav on pav.id = ptav.product_attribute_value_id
    order by ptav.product_tmpl_id, ptav.id`
}

export interface OdooVariante {
  id: number
  template_id: number
  default_code: string | null
  barcode: string | null
  active: boolean
  standard_price: unknown
  /** Attributwert-Namen der Kombination — Basis des Varianten-Matchings. */
  werte: { attribut: unknown; wert: unknown }[] | null
  hat_belegbezug: boolean
}

export async function varianten(sql: OdooSql): Promise<OdooVariante[]> {
  return sql<OdooVariante[]>`
    select p.id, p.product_tmpl_id as template_id, p.default_code, p.barcode,
           p.active, p.standard_price,
           (select json_agg(json_build_object('attribut', pa.name, 'wert', pav.name))
            from product_variant_combination pvc
            join product_template_attribute_value ptav
              on ptav.id = pvc.product_template_attribute_value_id
            join product_attribute pa on pa.id = ptav.attribute_id
            join product_attribute_value pav on pav.id = ptav.product_attribute_value_id
            where pvc.product_product_id = p.id) as werte,
           (exists (select 1 from sale_order_line l where l.product_id = p.id)
             or exists (select 1 from purchase_order_line l where l.product_id = p.id)
             or exists (select 1 from stock_move m where m.product_id = p.id)
             or exists (select 1 from mrp_production mo where mo.product_id = p.id)
             or exists (select 1 from repair_order r where r.product_id = p.id)) as hat_belegbezug
    from product_product p
    order by p.id`
}

export interface OdooLieferantenpreis {
  id: number
  partner_id: number
  template_id: number
  variant_id: number | null
  min_qty: number
  price: number
  discount: number | null
  delay: number
  product_code: string | null
  product_name: string | null
  date_start: string | null
  date_end: string | null
  sequence: number
  waehrung: string | null
}

export async function lieferantenpreise(sql: OdooSql): Promise<OdooLieferantenpreis[]> {
  return sql<OdooLieferantenpreis[]>`
    select s.id, s.partner_id, s.product_tmpl_id as template_id, s.product_id as variant_id,
           s.min_qty, s.price, s.discount, s.delay, s.product_code, s.product_name,
           s.date_start::text as date_start, s.date_end::text as date_end,
           coalesce(s.sequence, 1) as sequence, c.name as waehrung
    from product_supplierinfo s
    left join res_currency c on c.id = s.currency_id
    order by s.product_tmpl_id, s.sequence, s.id`
}

export interface OdooArbeitsplatz {
  id: number
  name: unknown
  code: string | null
  costs_hour: number | null
  default_capacity: number | null
  time_efficiency: number | null
  active: boolean
}

export async function arbeitsplaetze(sql: OdooSql): Promise<OdooArbeitsplatz[]> {
  return sql<OdooArbeitsplatz[]>`
    select id, name, code, costs_hour, default_capacity, time_efficiency, active
    from mrp_workcenter order by id`
}

export interface OdooBom {
  id: number
  template_id: number
  variant_id: number | null
  code: string | null
  qty: number
  uom_id: number
  typ: string
  consumption: string
  active: boolean
}

export async function boms(sql: OdooSql): Promise<OdooBom[]> {
  return sql<OdooBom[]>`
    select id, product_tmpl_id as template_id, product_id as variant_id,
           code, product_qty as qty, product_uom_id as uom_id,
           type as typ, consumption, active
    from mrp_bom order by id`
}

export interface OdooBomZeile {
  id: number
  bom_id: number
  variant_id: number
  qty: number
  uom_id: number
  manual_consumption: boolean
  sequence: number
  /** ptav-IDs aus „Apply on Variants" — leer = gilt für alle Varianten. */
  ptav_ids: number[] | null
}

export async function bomZeilen(sql: OdooSql): Promise<OdooBomZeile[]> {
  return sql<OdooBomZeile[]>`
    select l.id, l.bom_id, l.product_id as variant_id, l.product_qty as qty,
           l.product_uom_id as uom_id, coalesce(l.manual_consumption, false) as manual_consumption,
           coalesce(l.sequence, 1) as sequence,
           (select array_agg(rel.product_template_attribute_value_id)
            from mrp_bom_line_product_template_attribute_value_rel rel
            where rel.mrp_bom_line_id = l.id) as ptav_ids
    from mrp_bom_line l
    order by l.bom_id, l.sequence, l.id`
}

export interface OdooMeldebestand {
  id: number
  variant_id: number
  min_qty: number
  max_qty: number
  qty_multiple: number
  ausloeser: string
  snoozed_until: string | null
  /** 'manufacture' | 'buy' — aus dem Routennamen abgeleitet. */
  route_typ: string
  active: boolean
}

export async function meldebestaende(sql: OdooSql): Promise<OdooMeldebestand[]> {
  return sql<OdooMeldebestand[]>`
    select o.id, o.product_id as variant_id, o.product_min_qty as min_qty,
           o.product_max_qty as max_qty,
           -- Odoo erlaubt 0 („kein Vielfaches"), der KRNL-Check verlangt > 0.
           case when coalesce(o.qty_multiple, 0) <= 0 then 1 else o.qty_multiple end as qty_multiple,
           o.trigger as ausloeser, o.snoozed_until::text as snoozed_until,
           case when lower(coalesce(r.name::text, '')) like '%anufact%'
                then 'manufacture' else 'buy' end as route_typ,
           o.active
    from stock_warehouse_orderpoint o
    left join stock_route r on r.id = o.route_id
    order by o.id`
}

/** Die Studio-BoM-Zuordnungstabellen müssen leer sein — sonst Abbruch mit Meldung. */
export async function studioBomRelZeilen(sql: OdooSql): Promise<number> {
  const [zeile] = await sql<{ summe: number }[]>`
    select (select count(*)::int from x_mrp_bom_product_template_rel)
         + (select count(*)::int from x_mrp_bom_line_product_template_rel)
         + (select count(*)::int from x_mrp_bom_line_product_template_rel_1) as summe`
  return zeile.summe
}
