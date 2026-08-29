import type { Sql } from 'postgres'
import { UUID_MUSTER } from './typen.ts'

/**
 * Kennungs-Auflösung für Anlage-Aktionen: Verweisfelder nehmen neben der
 * UUID (aus den generierten Masken) auch SKU, Barcode, Referenz oder Namen
 * an — der Weg, auf dem die KI und API-Aufrufer sprechen. Exakte Kennungen
 * (UUID, SKU, Barcode, Referenz) gewinnen vor Namens-Treffern; ein
 * mehrdeutiger Name wird abgewiesen statt zufällig aufgelöst.
 *
 * Der Client kommt als Parameter (kein DB-Import): so bleiben die Resolver
 * unter withRollback testbar, und die Datei ist von jedem Executor nutzbar.
 */

export interface AufgeloesteVariante {
  id: string
  name: string
}

/** Findet eine aktive Variante über UUID, SKU, Barcode oder Anzeigename. */
export async function varianteAufloesen(db: Sql, kennung: string): Promise<AufgeloesteVariante> {
  const alsUuid = UUID_MUSTER.test(kennung) ? kennung : null
  const [exakt] = await db<AufgeloesteVariante[]>`
    select pv.id, variant_display_name(pv.id) as name
    from product_variants pv
    where pv.active and (
      pv.id = ${alsUuid}::uuid
      or lower(pv.sku) = lower(${kennung})
      or pv.barcode = ${kennung}
    )
    limit 1`
  if (exakt) return exakt

  const treffer = await db<AufgeloesteVariante[]>`
    select pv.id, variant_display_name(pv.id) as name
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active
      and lower(coalesce(pv.display_name, pt.name)) = lower(${kennung})
    limit 2`
  if (treffer.length === 0) throw new Error(`Produkt „${kennung}" nicht gefunden`)
  if (treffer.length > 1) {
    throw new Error(`Produkt „${kennung}" ist mehrdeutig — bitte SKU, Barcode oder ID angeben`)
  }
  return treffer[0]
}

/** Findet einen aktiven Kontakt über UUID, Referenz oder Namen (mit Rollenfilter). */
export async function partnerAufloesen(
  db: Sql,
  kennung: string,
  art: 'kunde' | 'lieferant',
): Promise<{ id: string; name: string }> {
  const alsUuid = UUID_MUSTER.test(kennung) ? kennung : null
  const rolle = art === 'kunde' ? db`is_customer` : db`is_vendor`
  const [exakt] = await db<{ id: string; name: string }[]>`
    select id, name from partners
    where active and ${rolle}
      and (id = ${alsUuid}::uuid or lower(ref) = lower(${kennung}))
    limit 1`
  if (exakt) return exakt

  const treffer = await db<{ id: string; name: string }[]>`
    select id, name from partners
    where active and ${rolle} and lower(name) = lower(${kennung})
    limit 2`
  const wer = art === 'kunde' ? 'Kunde' : 'Lieferant'
  if (treffer.length === 0) throw new Error(`${wer} „${kennung}" nicht gefunden`)
  if (treffer.length > 1) {
    throw new Error(`${wer} „${kennung}" ist mehrdeutig — bitte Referenz oder ID angeben`)
  }
  return treffer[0]
}
