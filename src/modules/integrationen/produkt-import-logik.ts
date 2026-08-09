/**
 * Produkte aus Shopify übernehmen — der rechnende Teil ohne Datenbank und
 * Netz. Die Orchestrierung liegt in produkt-import.ts.
 */

export interface ShopVarianteRoh {
  id: string
  sku: string | null
  barcode: string | null
  price: string
  optionen: { name: string; value: string }[]
}

export interface ErpVarianteRoh {
  id: string
  werte: { attribut: string; wert: string }[]
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Shopifys Platzhalter für „Produkt ohne Optionen": genau eine Option namens
 * Title mit dem Wert Default Title. Sie ist keine echte Eigenschaft und darf
 * nie als ERP-Attribut landen.
 */
export function istStandardOption(optionen: { name: string; value: string }[]): boolean {
  return (
    optionen.length === 0 ||
    (optionen.length === 1 && norm(optionen[0].name) === 'title' && norm(optionen[0].value) === 'default title')
  )
}

/** Echte Optionen eines Produkts (ohne den Title-Platzhalter). */
export function echteOptionen(
  optionen: { name: string; values: string[] }[],
): { name: string; values: string[] }[] {
  return optionen.filter((o) => !(norm(o.name) === 'title' && o.values.every((v) => norm(v) === 'default title')))
}

/**
 * Ordnet ERP-Varianten (nach generate_variants) den Shopify-Varianten zu —
 * über die Menge ihrer Attributwerte, unabhängig von Reihenfolge sowie
 * Groß-/Kleinschreibung. Nicht zuordenbare Shop-Varianten werden benannt
 * statt verschluckt.
 */
export function ordneVariantenZu(
  erp: ErpVarianteRoh[],
  shop: ShopVarianteRoh[],
): { paare: { erpId: string; shop: ShopVarianteRoh }[]; ohnePartner: ShopVarianteRoh[] } {
  const schluessel = (werte: { attribut?: string; name?: string; wert?: string; value?: string }[]) =>
    werte
      .map((w) => `${norm(w.attribut ?? w.name ?? '')}=${norm(w.wert ?? w.value ?? '')}`)
      .sort()
      .join('|')

  const erpNachSchluessel = new Map(erp.map((v) => [schluessel(v.werte), v.id]))
  const paare: { erpId: string; shop: ShopVarianteRoh }[] = []
  const ohnePartner: ShopVarianteRoh[] = []

  for (const sv of shop) {
    const optionen = istStandardOption(sv.optionen) ? [] : sv.optionen
    const erpId = erpNachSchluessel.get(schluessel(optionen))
    if (erpId) paare.push({ erpId, shop: sv })
    else ohnePartner.push(sv)
  }
  return { paare, ohnePartner }
}

/** Basispreis (kleinster Variantenpreis) und Aufpreis je Variante. */
export function preisAufteilung(shop: ShopVarianteRoh[]): {
  basis: number
  extra: Map<string, number>
} {
  const preise = shop.map((v) => Number(v.price))
  const basis = preise.length ? Math.min(...preise) : 0
  return {
    basis,
    extra: new Map(shop.map((v) => [v.id, Number((Number(v.price) - basis).toFixed(2))])),
  }
}
