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

/**
 * Rolle eines Shopify-Produkts in Shopifys Bundles-App:
 *   - `bundle`: das Bundle selbst (Varianten verlangen Bestandteile). Kein
 *     physischer Artikel — Bestellungen bringen die Bestandteile als eigene
 *     Positionen (LineItem.lineItemGroup), deshalb legt KRNL es nicht an.
 *   - `bestandteil`: steckt in mindestens einem Bundle (productParents).
 *     Solche Listen tragen oft die SKUs der eigentlichen Artikel und werden
 *     deshalb erst NACH den eigenständigen Produkten übernommen — der
 *     Artikel gehört dem normalen Produkt, nicht der Bundle-Liste.
 *   - `eigenstaendig`: alles andere.
 */
export type BundleRolle = 'bundle' | 'bestandteil' | 'eigenstaendig'

export function bundleRolle(p: {
  hasVariantsThatRequiresComponents?: boolean | null
  productParents?: { nodes: unknown[] } | null
}): BundleRolle {
  if (p.hasVariantsThatRequiresComponents) return 'bundle'
  if ((p.productParents?.nodes.length ?? 0) > 0) return 'bestandteil'
  return 'eigenstaendig'
}

/** Durchgang 1 übernimmt eigenständige Produkte, Durchgang 2 Bundle-Bestandteile; Bundles nie. */
export function imDurchgang(rolle: BundleRolle, durchgang: 1 | 2): boolean {
  if (rolle === 'eigenstaendig') return durchgang === 1
  if (rolle === 'bestandteil') return durchgang === 2
  return false
}

/**
 * Eine SKU ist genau ein Artikel. Teilt die Shop-Varianten eines neu
 * anzulegenden Produkts in neue Artikel und Zweitangebote: gehört die SKU
 * (oder der Barcode) schon einem Artikel im ERP — oder kam sie im selben
 * Produkt schon vor —, wird sie nicht doppelt angelegt. Bestellungen über
 * ein Zweitangebot finden den Artikel über die SKU.
 */
export function teileZweitangebote(
  shop: ShopVarianteRoh[],
  vergeben: { skus: ReadonlySet<string>; barcodes: ReadonlySet<string> },
): { neu: ShopVarianteRoh[]; zweit: ShopVarianteRoh[] } {
  const skus = new Set(vergeben.skus)
  const barcodes = new Set(vergeben.barcodes)
  const neu: ShopVarianteRoh[] = []
  const zweit: ShopVarianteRoh[] = []
  // Leere Kennungen sind keine: zwei Varianten ohne SKU sind kein Duplikat.
  const kennung = (s: string | null) => (s?.trim() ? s.trim() : null)
  for (const sv of shop) {
    const sku = kennung(sv.sku)
    const barcode = kennung(sv.barcode)
    if ((sku && skus.has(sku)) || (barcode && barcodes.has(barcode))) {
      zweit.push(sv)
      continue
    }
    neu.push(sv)
    if (sku) skus.add(sku)
    if (barcode) barcodes.add(barcode)
  }
  return { neu, zweit }
}
