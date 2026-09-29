/**
 * Netto-Preise aus Shopify (Migration 0089, Entscheidungslog 2026-09-29).
 *
 * KRNL speichert an der Auftragszeile den NETTO-Stückpreis nach allen
 * Rabatten und den Steuersatz; `sales_order_total` rechnet die Steuer
 * obendrauf. Shopify liefert je nach Shop-Einstellung Brutto- oder
 * Nettopreise (`taxesIncluded`) und Rabatte getrennt — bis 0089 landete der
 * Brutto-Listenpreis VOR Rabatt als Nettopreis im Beleg, die Umsätze waren
 * um Steuer und Rabatte zu hoch.
 *
 * Pur, ohne Datenbank — der Live-Import (API) und der Historie-Import
 * (CSV-Export) rechnen mit denselben Funktionen.
 */

/** Rundet kaufmännisch auf `stellen` Nachkommastellen. */
export function runden(wert: number, stellen = 2): number {
  const f = 10 ** stellen
  return Math.round((wert + Number.EPSILON) * f) / f
}

/**
 * Nettobetrag aus einem Shopify-Betrag: bei „Steuern im Preis enthalten"
 * wird der Satz herausgerechnet, sonst ist der Betrag schon netto.
 * `satz` als Dezimalzahl (0.19).
 */
export function netto(betrag: number, satz: number, steuernInklusive: boolean): number {
  if (!Number.isFinite(betrag)) return 0
  return steuernInklusive && satz > 0 ? betrag / (1 + satz) : betrag
}

/** Steuersatz in Prozent (19) aus Dezimal (0.19), auf zwei Stellen. */
export function satzProzent(satz: number): number {
  return runden(satz * 100, 2)
}

/** Erster Steuersatz einer Shopify-Steuerzeilenliste (Dezimal), sonst 0. */
export function satzAusSteuerzeilen(zeilen: { rate: number | null }[] | null | undefined): number {
  const satz = zeilen?.find((z) => typeof z.rate === 'number' && z.rate > 0)?.rate
  return satz ?? 0
}

export interface ShopifyPositionPreis {
  menge: number
  /** Stückpreis vor Rabatt (Shopify originalUnitPriceSet). */
  listenpreis: number
  /** Stückpreis nach allen Rabatten (discountedUnitPriceAfterAllDiscountsSet), falls geliefert. */
  nachRabatt?: number | null
  /** Steuersatz dezimal (0.19); null = unbekannt. */
  satz?: number | null
}

/**
 * Netto-Stückpreis und Steuersatz einer API-Position. Fehlen die neuen
 * Felder (ältere Fixtures), bleibt es beim bisherigen Verhalten: Listenpreis,
 * 19 %, als netto gelesen.
 */
export function positionNetto(
  p: ShopifyPositionPreis,
  steuernInklusive: boolean | null | undefined,
): { stueckNetto: number; steuersatz: number } {
  if (p.satz == null && p.nachRabatt == null && steuernInklusive == null) {
    return { stueckNetto: runden(p.listenpreis, 2), steuersatz: 19 }
  }
  const satz = p.satz ?? 0
  const brutto = p.nachRabatt ?? p.listenpreis
  return {
    stueckNetto: runden(netto(brutto, satz, Boolean(steuernInklusive)), 2),
    steuersatz: satzProzent(satz),
  }
}

/** Steuersatz aus einem Steuernamen wie „DE MwSt 19%" oder „VAT 7.0%" — dezimal. */
export function satzAusName(name: string | null | undefined): number | null {
  const treffer = name?.match(/(\d+(?:[.,]\d+)?)\s*%/)
  if (!treffer) return null
  const prozent = Number(treffer[1].replace(',', '.'))
  return Number.isFinite(prozent) ? prozent / 100 : null
}

export interface ExportSummen {
  /** Zwischensumme der Waren nach Rabatten. */
  zwischensumme: number
  versand: number
  steuern: number
  gesamt: number
}

/**
 * Waren Shopify-Preise inkl. Steuer? Aus den Summen des Exports:
 * inklusive heißt Zwischensumme + Versand = Gesamt, exklusive heißt
 * Zwischensumme + Versand + Steuern = Gesamt. Die kleinere Abweichung
 * gewinnt; ohne Steuern ist es gleichgültig (netto = brutto).
 */
export function steuernInklusiveAus(s: ExportSummen): boolean {
  if (!(s.steuern > 0)) return false
  const inklusive = Math.abs(s.zwischensumme + s.versand - s.gesamt)
  const exklusive = Math.abs(s.zwischensumme + s.versand + s.steuern - s.gesamt)
  return inklusive <= exklusive
}

export interface ExportZeile {
  menge: number
  /** Stückpreis laut Export (vor Rabatt). */
  preis: number
  /** Rabatt auf die Zeile (Betrag, gesamt). */
  rabatt: number
}

/**
 * Netto-Stückpreise einer Export-Bestellung. Die Zwischensumme ist der
 * Warenwert nach ALLEN Rabatten — die Zeilenwerte werden anteilig auf sie
 * skaliert (verteilt Auftragsrabatte proportional), dann ggf. die Steuer
 * herausgerechnet. Die Summe der Netto-Zeilen trifft so die Zwischensumme
 * (netto) bis auf Rundung.
 */
export function exportPositionenNetto(
  zeilen: ExportZeile[],
  zwischensumme: number,
  satz: number,
  steuernInklusive: boolean,
): number[] {
  const werte = zeilen.map((z) => Math.max(0, z.menge * z.preis - z.rabatt))
  const summe = werte.reduce((s, w) => s + w, 0)
  const faktor = summe > 0 && zwischensumme >= 0 ? zwischensumme / summe : 1
  return zeilen.map((z, i) =>
    z.menge > 0 ? runden(netto(werte[i] * faktor, satz, steuernInklusive) / z.menge, 2) : 0,
  )
}
