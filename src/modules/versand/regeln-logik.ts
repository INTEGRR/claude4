/**
 * Versandregeln — reine Logik, ohne Server-Abhängigkeiten, direkt testbar.
 *
 * Regeln liefern einen Vorschlag (DHL-Produkt, Abrechnungsnummer,
 * Versicherung), den der Packtisch überschreiben darf. Ausgewertet wird in
 * Prioritätsreihenfolge; je Aktion gewinnt die erste Regel, die sie setzt —
 * eine spätere Regel kann also noch die Versicherung beisteuern, wenn eine
 * frühere nur das Produkt bestimmt hat (Stapeln wie bei Sendcloud).
 */

/** DHL Kleinpaket (V62KP, Warenpost-Nachfolger seit 01/2025). */
export const KLEINPAKET = {
  maxWeightG: 1000,
  maxLengthMm: 355,
  maxWidthMm: 250,
  maxHeightMm: 80,
}

export type Zone = 'de' | 'eu' | 'world'

export interface RegelZeile {
  sku: string | null
  qty: number
  kleinpaket: boolean
  kleinpaketMaxQty: number
}

export interface RegelKontext {
  weightG: number
  zone: Zone
  /** Warenwert der Sendung (Auftragssumme). */
  orderValue: number
  zeilen: RegelZeile[]
}

export interface Versandregel {
  id: string
  name: string
  minWeightG: number | null
  maxWeightG: number | null
  zone: Zone | null
  skus: string[] | null
  skuScope: 'any' | 'all'
  requireKleinpaketFit: boolean
  dhlProduct: string | null
  billingNumber: string | null
  insuranceFromValue: number | null
}

export interface Regelergebnis {
  product: string | null
  productRegel: string | null
  billingNumber: string | null
  insuredValue: number | null
  insuranceRegel: string | null
  passtInsKleinpaket: boolean
}

/**
 * Passt die Ware der Lieferung in EIN Kleinpaket?
 *
 * Jedes Produkt sagt selbst, wie viele Stück ein Kleinpaket füllen
 * (kleinpaket_max_qty). Gemischte Lieferungen zählen anteilig: zwei
 * Keycap-Sets (max 2) sind voll, ein Set (1/2) plus drei Kabel (3/10)
 * belegen 0,8 — passt. Das ist eine ehrliche Näherung statt 3D-Packerei.
 */
export function passtInsKleinpaket(zeilen: RegelZeile[]): boolean {
  if (zeilen.length === 0) return false
  let belegt = 0
  for (const z of zeilen) {
    if (!z.kleinpaket) return false
    belegt += z.qty / Math.max(z.kleinpaketMaxQty, 1)
  }
  return belegt <= 1
}

/** SKU-Muster: * steht für beliebig viel, Vergleich ohne Groß/Klein. */
export function skuPasst(muster: string, sku: string): boolean {
  const regex = new RegExp(
    '^' + muster.trim().split('*').map((teil) =>
      teil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i',
  )
  return regex.test(sku)
}

export function regelTrifft(r: Versandregel, k: RegelKontext): boolean {
  if (r.minWeightG != null && k.weightG < r.minWeightG) return false
  if (r.maxWeightG != null && k.weightG > r.maxWeightG) return false
  if (r.zone != null && r.zone !== k.zone) return false
  if (r.requireKleinpaketFit && !passtInsKleinpaket(k.zeilen)) return false
  if (r.skus && r.skus.length > 0) {
    const zeilePasst = (z: RegelZeile) => r.skus!.some((m) => skuPasst(m, z.sku ?? ''))
    const treffer = r.skuScope === 'all'
      ? k.zeilen.length > 0 && k.zeilen.every(zeilePasst)
      : k.zeilen.some(zeilePasst)
    if (!treffer) return false
  }
  return true
}

export function wendeRegelnAn(regeln: Versandregel[], k: RegelKontext): Regelergebnis {
  const ergebnis: Regelergebnis = {
    product: null,
    productRegel: null,
    billingNumber: null,
    insuredValue: null,
    insuranceRegel: null,
    passtInsKleinpaket: passtInsKleinpaket(k.zeilen),
  }

  for (const r of regeln) {
    if (!regelTrifft(r, k)) continue
    if (ergebnis.product === null && r.dhlProduct) {
      ergebnis.product = r.dhlProduct
      ergebnis.productRegel = r.name
    }
    if (ergebnis.billingNumber === null && r.billingNumber) {
      ergebnis.billingNumber = r.billingNumber
    }
    // Versicherung nur, wenn der Warenwert die Schwelle der Regel erreicht —
    // eine nicht greifende Schwelle verbraucht den Platz nicht.
    if (
      ergebnis.insuredValue === null &&
      r.insuranceFromValue != null &&
      k.orderValue >= r.insuranceFromValue
    ) {
      ergebnis.insuredValue = Math.round(k.orderValue * 100) / 100
      ergebnis.insuranceRegel = r.name
    }
  }

  return ergebnis
}

/**
 * Abrechnungsnummer zum Produkt: 14-stellig = EKP (10) + Verfahren (2) +
 * Teilnahme (2). Das Verfahren hängt am Produkt — mit der Paket-Nummer lässt
 * sich kein Kleinpaket buchen. Liegt nur die Standard-Nummer vor, wird das
 * Verfahren ausgetauscht und die Teilnahme beibehalten; eine Regel kann die
 * Nummer immer explizit überschreiben.
 */
const VERFAHREN: Record<string, string> = {
  V01PAK: '01',
  V53WPAK: '53',
  V54EPAK: '54',
  V62KP: '62',
  V66WPI: '66',
  V07PAK: '07',
}

export function billingNumberForProduct(product: string, standard: string): string {
  const verfahren = VERFAHREN[product]
  if (!verfahren || standard.length !== 14) return standard
  return standard.slice(0, 10) + verfahren + standard.slice(12)
}
