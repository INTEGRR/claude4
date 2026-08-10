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
  /** Platzbedarf eines Stücks; 1 = ein volles Kleinpaket. */
  platzbedarf: number
}

/** Eine Verpackung als Bestandsartikel. */
export interface Kartonage {
  id: string
  name: string
  /** Fassungsvermögen in derselben Skala wie der Platzbedarf. */
  capacity: number
  maxContentG: number
  kleinpaket: boolean
  /** Leergewicht des Kartons (aus dem Produktgewicht). */
  tareG: number
}

export interface RegelKontext {
  /** Reines Warengewicht; der Karton kommt in wendeRegelnAn dazu. */
  weightG: number
  zone: Zone
  /** Warenwert der Sendung (Auftragssumme). */
  orderValue: number
  zeilen: RegelZeile[]
  /** Gepflegte Verpackungen; leer = ohne Kartonagen wie bisher. */
  kartonagen?: Kartonage[]
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
  kartonage: Kartonage | null
  /** Warengewicht plus Leergewicht der Kartonage — das wiegt DHL. */
  versandgewichtG: number
}

/** Platzbedarf der ganzen Lieferung, in Kleinpaket-Einheiten. */
export function platzbedarf(zeilen: RegelZeile[]): number {
  return zeilen.reduce((summe, z) => summe + z.qty * Math.max(z.platzbedarf, 0), 0)
}

/**
 * Passt die Ware der Lieferung in EIN Kleinpaket?
 *
 * Drei Bedingungen, jede für sich ein K.-o.:
 *
 * 1. **Jede** Position muss kleinpaketfähig sein. Eine einzige unmarkierte
 *    Position (die Tastatur zum Zubehör) kippt die ganze Sendung aufs Paket —
 *    das ist der häufigste Fall und muss stur sein, nicht klug.
 * 2. Der Platz reicht: Summe aus Menge x Platzbedarf höchstens 1. Ein
 *    Keycap-Set (0,5) plus drei Kabel (je 0,1) belegen 0,8 — passt. Zwei
 *    Sets à 1,0 belegen 2,0 — passt nicht. Ehrliche Näherung statt
 *    Schein-3D-Packerei.
 * 3. Das Gesamtgewicht bleibt unter der DHL-Grenze (1 kg) — **einschließlich
 *    Karton**, denn gewogen wird das Paket, nicht der Inhalt. Diese Prüfung
 *    gehört hierher und nicht nur in die Regel: nimmt jemand das
 *    Höchstgewicht aus der Regel heraus, würde sonst eine 3-kg-Sendung als
 *    Kleinpaket vorgeschlagen und von DHL abgelehnt.
 */
export function passtInsKleinpaket(zeilen: RegelZeile[], weightG: number): boolean {
  if (zeilen.length === 0) return false
  if (weightG > KLEINPAKET.maxWeightG) return false
  if (zeilen.some((z) => !z.kleinpaket)) return false
  return platzbedarf(zeilen) <= 1
}

/**
 * Kleinste passende Kartonage.
 *
 * Passend heißt: Fassungsvermögen deckt den Platzbedarf und das Warengewicht
 * bleibt unter dem Höchstgewicht des Kartons. Gewählt wird die kleinste —
 * ein Keycap-Set soll nicht im Tastaturkarton reisen. Bei gleichem
 * Fassungsvermögen entscheidet die gepflegte Reihenfolge.
 *
 * Ohne gepflegte Kartonagen (oder wenn nichts passt) gibt es keine Wahl; der
 * Versand läuft dann wie bisher mit dem reinen Warengewicht weiter.
 */
export function waehleKartonage(
  kartonagen: Kartonage[],
  zeilen: RegelZeile[],
  warengewichtG: number,
): Kartonage | null {
  const bedarf = platzbedarf(zeilen)
  const passend = kartonagen.filter(
    (k) => k.capacity >= bedarf && k.maxContentG >= warengewichtG,
  )
  if (passend.length === 0) return null
  return passend.reduce((klein, k) => (k.capacity < klein.capacity ? k : klein))
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

export function regelTrifft(
  r: Versandregel,
  k: RegelKontext,
  /** Versandgewicht inkl. Karton und Kleinpaket-Eignung — einmal vorberechnet. */
  vor: { versandgewichtG: number; kleinpaket: boolean },
): boolean {
  if (r.minWeightG != null && vor.versandgewichtG < r.minWeightG) return false
  if (r.maxWeightG != null && vor.versandgewichtG > r.maxWeightG) return false
  if (r.zone != null && r.zone !== k.zone) return false
  if (r.requireKleinpaketFit && !vor.kleinpaket) return false
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
  // Erst die Verpackung, dann die Regeln: der Karton bestimmt Gewicht und
  // Kleinpaket-Eignung, und beides prüfen die Regeln anschließend.
  const kartonage = waehleKartonage(k.kartonagen ?? [], k.zeilen, k.weightG)
  const versandgewichtG = k.weightG + (kartonage?.tareG ?? 0)
  // Ohne gepflegte Kartonagen entscheiden allein Flags, Platz und Gewicht;
  // mit Kartonage muss diese zusätzlich als Kleinpaket zugelassen sein.
  const kleinpaket =
    passtInsKleinpaket(k.zeilen, versandgewichtG) && (kartonage?.kleinpaket ?? true)

  const ergebnis: Regelergebnis = {
    product: null,
    productRegel: null,
    billingNumber: null,
    insuredValue: null,
    insuranceRegel: null,
    passtInsKleinpaket: kleinpaket,
    kartonage,
    versandgewichtG,
  }

  for (const r of regeln) {
    if (!regelTrifft(r, k, { versandgewichtG, kleinpaket })) continue
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
