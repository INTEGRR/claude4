import type { Sql, TransactionSql } from 'postgres'

/**
 * Unscharfer Varianten-Resolver für den Sprachmodus — gesprochene Produktnamen
 * („Switches Gateron Blue") treffen selten exakt. Regel: exakte SKU/Barcode
 * gewinnen sofort; sonst muss JEDES gesprochene Wort irgendwo in Anzeigename,
 * Templatename oder SKU vorkommen (UND-Suche, ilike). Bewusst ohne
 * pg_trgm-Abhängigkeit.
 *
 * Wie sql-tool.ts app-frei gehalten: der Client kommt als Parameter, damit
 * der Resolver direkt gegen die Wegwerf-DB testbar ist.
 */

export interface VariantenTreffer {
  id: string
  name: string
  sku: string | null
  /** Bestand über alle internen Orte. */
  bestand: number
  /** Bestand am Hauptlager (WH/Stock) — die Buchbasis der Zählung. */
  hauptlager: number
}

/** Suchbegriff → Wortliste: kleingeschrieben, Satzzeichen raus, Kurzwörter raus. */
export function suchworte(begriff: string): string[] {
  return begriff
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 2)
}

/**
 * Leichte Stammbildung fürs Sprechen: „Switches" muss „Switch" treffen,
 * „Schrauben" die „Schraube". Häufige Plural-Endungen werden abgeschnitten —
 * der Stamm ist ein Präfix des Worts, das Matching (%stamm%) wird dadurch
 * höchstens großzügiger, nie enger.
 */
export function wortstamm(wort: string): string {
  for (const endung of ['es', 'en', 's', 'n', 'e']) {
    if (wort.endsWith(endung) && wort.length - endung.length >= 3) {
      return wort.slice(0, wort.length - endung.length)
    }
  }
  return wort
}

export async function varianteSuchen(
  client: Sql | TransactionSql,
  suchbegriff: string,
  limit = 5,
): Promise<VariantenTreffer[]> {
  const begriff = suchbegriff.trim()
  const worte = suchworte(begriff).map(wortstamm)
  if (!begriff || worte.length === 0) return []

  const rows = await client<
    { id: string; name: string; sku: string | null; bestand: number; hauptlager: number }[]
  >`
    select pv.id,
           variant_display_name(pv.id) as name,
           pv.sku,
           coalesce(on_hand_qty(pv.id), 0) as bestand,
           coalesce(on_hand_qty(pv.id,
             (select l.id from stock_locations l where l.full_path = 'WH/Stock')), 0) as hauptlager
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and (
      lower(coalesce(pv.sku, '')) = lower(${begriff})
      or pv.barcode = ${begriff}
      or not exists (
        select 1 from unnest(${worte}::text[]) w
        where coalesce(pv.display_name, '') not ilike '%' || w || '%'
          and pt.name not ilike '%' || w || '%'
          and coalesce(pv.sku, '') not ilike '%' || w || '%'
      )
    )
    order by (lower(coalesce(pv.sku, '')) = lower(${begriff})) desc,
             length(coalesce(pv.display_name, pt.name)) asc
    limit ${limit}`

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku,
    bestand: Number(r.bestand),
    hauptlager: Number(r.hauptlager),
  }))
}
