/**
 * Querverweis vom Transfer zu seinem Quellbeleg (origin_model/origin_id).
 * Eine Stelle für Liste und Detailseite — „Quellbeleg" ist ein Weg, keine
 * Beschriftung (Betreiber 2026-10-01). Unbekannte Modelle bleiben Text.
 */
const HERKUNFT_ROUTE: Record<string, string> = {
  sales_order: '/verkauf',
  purchase_order: '/einkauf',
  repair_order: '/reparatur',
  manufacturing_order: '/fertigung',
  vorgang: '/vorgaenge',
}

export function herkunftHref(model: string | null, id: string | null): string | null {
  if (!model || !id) return null
  const basis = HERKUNFT_ROUTE[model]
  return basis ? `${basis}/${id}` : null
}

/** UUID-Prüfung für Filter aus der Adresszeile — ''::uuid oder Unsinn wäre ein 500. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
