import { sql } from '@/db/client'
import { suchMuster } from './auswahl-suche.ts'

/**
 * Artikelsuche (2026-11-28): eine Regel für alle Suchfelder. Jedes Wort der
 * Eingabe muss vorkommen — in Produktname, Variantenname, Artikelnummer oder
 * Barcode; Groß-/Kleinschreibung und Wortreihenfolge sind egal
 * („black case" findet „Native 1800 Case Black", „cs-1800" die Nummer).
 */
/** Bedingung für Abfragen mit den Aliasen `pv` (Variante) und `pt` (Produkt); leere Eingabe = alles. */
export function artikelPasst(eingabe: string | null | undefined) {
  const muster = suchMuster(eingabe)
  if (muster.length === 0) return sql`true`
  return sql`(select bool_and(lower(pt.name || ' ' || coalesce(pv.display_name, '') || ' ' || coalesce(pv.sku, '') || ' '
                                    || coalesce(pv.barcode, '')) like m)
              from unnest(${muster}::text[]) m)`
}

/** Dasselbe auf Produktebene (Alias `pt`): Name, Shop-Projekt und die Nummern aller Varianten. */
export function produktPasst(eingabe: string | null | undefined) {
  const muster = suchMuster(eingabe)
  if (muster.length === 0) return sql`true`
  return sql`(select bool_and(lower(pt.name || ' ' || coalesce(pt.projekt, '') || ' ' || coalesce((
                 select string_agg(coalesce(x.sku, '') || ' ' || coalesce(x.barcode, ''), ' ')
                 from product_variants x where x.template_id = pt.id), '')) like m)
              from unnest(${muster}::text[]) m)`
}
