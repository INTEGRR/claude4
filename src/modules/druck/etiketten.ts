import 'server-only'
import { sql } from '@/db/client'
import {
  type ArtikeletikettDaten,
  type FertigungsetikettDaten,
  artikeletikettenPdf,
  fertigungsetikettenPdf,
} from './etikett-pdf'
import type { EtikettFormat, EtikettPosition } from './etikett-layout'

/**
 * Daten der Etiketten aus der Datenbank und das fertige PDF — EINE Quelle
 * für beide Wege: die Druckbrücke (abholen.ts rendert im Format des
 * Zieldruckers) und den Browser (/api/etikett/…, Standardformat), damit
 * ein Etikett nicht je nach Druckweg anders aussieht.
 */

/** Ein Etikett je Fertigungsauftrag, in der Reihenfolge der IDs. */
export async function fertigungsetikettDaten(moIds: readonly string[]): Promise<FertigungsetikettDaten[]> {
  if (moIds.length === 0) return []
  const zeilen = await sql<(FertigungsetikettDaten & { id: string })[]>`
    select mo.id, mo.number, variant_display_name(mo.variant_id) as produkt, pv.sku,
           mo.qty_to_produce::float8 as menge, u.name as einheit, mo.scheduled_date as termin,
           so.number as auftrag, so.shopify_order_name as "shopifyName", p.name as kunde,
           (select count(*) from stock_moves m
             where m.production_id = mo.id and m.reference = 'Komponentenverbrauch'
               and m.state <> 'cancel')::int as komponenten
    from manufacturing_orders mo
    join product_variants pv on pv.id = mo.variant_id
    join uoms u on u.id = mo.uom_id
    left join sales_orders so on so.id = mo.sales_order_id
    left join partners p on p.id = so.partner_id
    where mo.id = any(${moIds as string[]}::uuid[])`
  return moIds
    .map((id) => zeilen.find((z) => z.id === id))
    .filter((z): z is FertigungsetikettDaten & { id: string } => Boolean(z))
}

/** Name, Merkmale, SKU und Barcode je Variante. */
export async function artikeletikettDaten(
  variantIds: readonly string[],
): Promise<Map<string, ArtikeletikettDaten>> {
  if (variantIds.length === 0) return new Map()
  const zeilen = await sql<(ArtikeletikettDaten & { id: string })[]>`
    select pv.id, pt.name, pv.sku, pv.barcode,
           coalesce((
             select string_agg(a.name || ': ' || v.name, ' · ' order by al.sequence, a.name)
             from product_variant_attribute_values pvav
             join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
             join product_template_attribute_lines al on al.id = ptav.line_id
             join product_attribute_values v on v.id = ptav.value_id
             join product_attributes a on a.id = al.attribute_id
             where pvav.variant_id = pv.id), '') as merkmale
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.id = any(${variantIds as string[]}::uuid[])`
  return new Map(zeilen.map(({ id, ...daten }) => [id, daten]))
}

/** Das PDF der Fertigungsetiketten; wirft, wenn keiner der Aufträge existiert. */
export async function fertigungsetiketten(moIds: readonly string[], format: EtikettFormat): Promise<Buffer> {
  const daten = await fertigungsetikettDaten(moIds)
  if (daten.length === 0) throw new Error('Keiner der Fertigungsaufträge wurde gefunden.')
  return fertigungsetikettenPdf(daten, format)
}

/** Das PDF der Artikel-Etiketten (anzahl Seiten je Position); unbekannte Varianten fallen weg. */
export async function artikeletiketten(
  positionen: readonly EtikettPosition[],
  format: EtikettFormat,
): Promise<Buffer> {
  const daten = await artikeletikettDaten(positionen.map((p) => p.variantId))
  const seiten = positionen
    .filter((p) => daten.has(p.variantId))
    .map((p) => ({ daten: daten.get(p.variantId)!, anzahl: p.anzahl }))
  if (seiten.length === 0) throw new Error('Keine der Varianten wurde gefunden.')
  return artikeletikettenPdf(seiten, format)
}
