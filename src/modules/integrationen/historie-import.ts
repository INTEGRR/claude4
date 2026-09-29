import { sql, tx } from '@/db/client'
import type { TransactionSql } from 'postgres'
import { type HistorieBestellung, type HistoriePosition, wirdUebernommen } from './shopify-csv.ts'

/**
 * Historie aus dem Shopify-Export anlegen (0089, Entscheidungslog
 * 2026-09-29). Jede Bestellung wird ein abgeschlossener Auftrag mit
 * `historisch = true` — ohne Lieferung, Reservierung oder Fertigung. Sie
 * zählt in Umsatz, Abverkauf und Deckungsbeitrag (am Bestelldatum), löst
 * aber nie Logistik aus.
 *
 * Idempotent je Bestellung (Shopify-ID bzw. Bestellname): ein Paket darf
 * wiederholt werden, ein abgebrochener Lauf einfach neu starten.
 */

/** Was ein Export mitbringt, das KRNL nicht kennt — für die Vorschau. */
export async function historiePruefen(
  skus: string[],
  namen: string[],
): Promise<{ unbekannteSkus: string[]; vorhanden: number }> {
  const bekannt = await sql<{ sku: string }[]>`
    select sku from product_variants where sku = any(${skus}::text[])`
  const menge = new Set(bekannt.map((b) => b.sku))
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from sales_orders
    where shopify_order_name = any(${namen}::text[]) or number = any(${namen}::text[])`
  return { unbekannteSkus: skus.filter((s) => !menge.has(s)).sort(), vorhanden: n }
}

export interface HistorieErgebnis {
  angelegt: number
  vorhanden: number
  /** Offene Bestellungen im API-Fenster — die holt der Live-Import. */
  offenJung: number
  neueArtikel: number
  fehler: string[]
}

const ARTIKEL_HINWEIS =
  'Historischer Artikel aus dem Shopify-Export — im heutigen Katalog nicht vorhanden.'

/** Variante zu einer Position: per SKU (auch archiviert), sonst archivierter Historie-Artikel. */
async function varianteFuer(
  t: TransactionSql,
  p: HistoriePosition,
  stueck: string,
  cache: Map<string, { id: string; uom: string }>,
  neu: { n: number },
): Promise<{ id: string; uom: string }> {
  const schluessel = p.sku ?? '__sammel__'
  const gemerkt = cache.get(schluessel)
  if (gemerkt) return gemerkt

  const [vorhanden] = p.sku
    ? await t<{ id: string; uom: string }[]>`
        select pv.id, pt.uom_id as uom from product_variants pv
        join product_templates pt on pt.id = pv.template_id
        where pv.sku = ${p.sku}`
    : await t<{ id: string; uom: string }[]>`
        select pv.id, pt.uom_id as uom from product_variants pv
        join product_templates pt on pt.id = pv.template_id
        where pt.zusatz ->> 'historie' = 'sammelartikel'
        limit 1`
  if (vorhanden) {
    cache.set(schluessel, vorhanden)
    return vorhanden
  }

  // Unbekannte SKU (altes, gelöschtes Produkt) bzw. Positionen ohne SKU
  // (Gutschein, Trinkgeld): archivierter Artikel, damit der Umsatz
  // vollständig bleibt — im Katalog, Verkauf und Shop-Abgleich unsichtbar.
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, uom_id, can_be_sold, active, description, zusatz)
    values (
      ${p.sku ? p.name : 'Sonstige Shopify-Position (Historie)'}, ${stueck}, false, false,
      ${ARTIKEL_HINWEIS},
      ${t.json({ historie: p.sku ? 'artikel' : 'sammelartikel' })})
    returning id`
  await t`select generate_variants(${tpl.id})`
  const [variante] = await t<{ id: string }[]>`
    update product_variants set sku = ${p.sku}, active = false
    where template_id = ${tpl.id}
    returning id`
  neu.n++
  const ergebnis = { id: variante.id, uom: stueck }
  cache.set(schluessel, ergebnis)
  return ergebnis
}

/** Kunde per E-Mail — sonst neu mit Name, E-Mail und Land. Bestehende bleiben unverändert. */
async function kundeFuer(t: TransactionSql, b: HistorieBestellung): Promise<string> {
  if (b.email) {
    const [k] = await t<{ id: string }[]>`
      select id from partners where lower(email) = lower(${b.email})
      order by is_customer desc, created_at limit 1`
    if (k) return k.id
  }
  const [neu] = await t<{ id: string }[]>`
    insert into partners (name, is_customer, email, country_code)
    values (${b.kunde}, true, ${b.email}, ${b.land ?? 'DE'})
    returning id`
  return neu.id
}

export async function historieImportieren(
  bestellungen: HistorieBestellung[],
  von: string,
  jetzt: Date = new Date(),
): Promise<HistorieErgebnis> {
  const ergebnis: HistorieErgebnis = { angelegt: 0, vorhanden: 0, offenJung: 0, neueArtikel: 0, fehler: [] }
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  if (!stueck) throw new Error('Einheit „Stück" fehlt — Stammdaten prüfen.')

  const gids = bestellungen.filter((b) => b.id).map((b) => `gid://shopify/Order/${b.id}`)
  const namen = bestellungen.map((b) => b.name)
  const da = await sql<{ shopify_order_id: string | null; shopify_order_name: string | null; number: string }[]>`
    select shopify_order_id, shopify_order_name, number from sales_orders
    where shopify_order_id = any(${gids}::text[])
       or shopify_order_name = any(${namen}::text[])
       or number = any(${namen}::text[])`
  const bekannt = new Set(da.flatMap((d) => [d.shopify_order_id, d.shopify_order_name, d.number]))

  const cache = new Map<string, { id: string; uom: string }>()
  const neu = { n: 0 }

  for (const b of bestellungen) {
    const gid = b.id ? `gid://shopify/Order/${b.id}` : null
    if ((gid && bekannt.has(gid)) || bekannt.has(b.name)) {
      ergebnis.vorhanden++
      continue
    }
    if (!wirdUebernommen(b, jetzt)) {
      ergebnis.offenJung++
      continue
    }
    const artikelVorher = neu.n
    try {
      await tx(async (t) => {
        const partner = await kundeFuer(t, b)
        const storniert = b.status === 'storniert'
        const [auftrag] = await t<{ id: string }[]>`
          insert into sales_orders (
            number, partner_id, source, shopify_order_id, shopify_order_name,
            order_date, confirmed_at, state, delivery_status, currency, versandkosten,
            historisch, ship_name, ship_country_code, ship_email)
          values (
            ${b.name}, ${partner}, 'shopify', ${gid}, ${b.name},
            ${b.datum}, ${storniert ? null : b.datum},
            ${storniert ? 'cancel' : 'sale'}, ${storniert ? 'pending' : 'full'},
            ${b.waehrung}, ${b.versandNetto}, true,
            ${b.kunde}, ${b.land}, ${b.email})
          returning id`
        let folge = 10
        for (const p of b.positionen) {
          const v = await varianteFuer(t, p, stueck.id, cache, neu)
          await t`
            insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id,
                                           price_unit, tax_rate, qty_delivered)
            values (${auftrag.id}, ${folge}, ${v.id}, ${p.name}, ${p.menge}, ${v.uom},
                    ${p.stueckNetto}, ${b.steuersatz}, ${storniert ? 0 : p.menge})`
          folge += 10
        }
        await t`select log_event('sales_order', ${auftrag.id}, 'note',
          ${`Historie aus dem Shopify-Export übernommen${b.status === 'offen' ? ' (in Shopify nicht als versandt markiert)' : ''}.`},
          ${von})`
      })
      bekannt.add(b.name)
      if (gid) bekannt.add(gid)
      ergebnis.angelegt++
    } catch (err) {
      // Neu angelegte Artikel des gescheiterten Auftrags sind mit
      // zurückgerollt — der Zwischenspeicher darf sie nicht mehr kennen.
      cache.clear()
      neu.n = artikelVorher
      ergebnis.fehler.push(`${b.name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`)
    }
  }
  ergebnis.neueArtikel = neu.n
  return ergebnis
}
