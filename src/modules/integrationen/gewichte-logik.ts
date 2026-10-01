/**
 * Shopify-Gewicht → Gramm (rein rechnend). Shopify liefert je Variante
 * `inventoryItem.measurement.weight { unit value }` mit GRAMS, KILOGRAMS,
 * OUNCES oder POUNDS; KRNL führt Gramm am Artikel (product_templates.weight_g).
 * Kein oder ein nicht positives Gewicht → null (dann bleibt der Artikel ohne).
 */
export interface ShopifyGewicht {
  unit: string
  value: number | string | null
}

const FAKTOR: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
}

export function inGramm(gewicht: ShopifyGewicht | null | undefined): number | null {
  if (!gewicht) return null
  const wert = Number(gewicht.value)
  const faktor = FAKTOR[gewicht.unit?.toUpperCase?.() ?? '']
  if (!Number.isFinite(wert) || wert <= 0 || !faktor) return null
  return Math.max(1, Math.round(wert * faktor))
}
