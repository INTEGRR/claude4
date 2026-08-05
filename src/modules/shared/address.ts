/**
 * Adress-Hilfen ohne Server-Abhängigkeiten (damit direkt testbar).
 *
 * DHL verlangt Straße und Hausnummer getrennt; Shopify liefert sie in einem
 * Feld. Die Aufteilung passiert deshalb schon beim Import.
 */

export interface SplitStreet {
  street: string
  houseNumber: string
}

export function splitStreet(input: string | null | undefined): SplitStreet {
  const value = (input ?? '').trim()
  if (!value) return { street: '', houseNumber: '' }

  // Hausnummer am Ende (deutscher Normalfall):
  // "Musterstr. 12", "Musterstr. 12a", "Musterstr. 12-14", "Musterstr. 12/3"
  const trailing = value.match(/^(.*?)[\s,]+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?)$/)
  if (trailing) {
    return { street: trailing[1].trim(), houseNumber: trailing[2].replace(/\s+/g, '') }
  }

  // Hausnummer am Anfang (z. B. FR/NL/US): "12 Rue de la Paix"
  const leading = value.match(/^(\d+\s*[a-zA-Z]?)[\s,]+(.*)$/)
  if (leading) {
    return { street: leading[2].trim(), houseNumber: leading[1].replace(/\s+/g, '') }
  }

  // Keine erkennbare Hausnummer — Straße unverändert übernehmen.
  return { street: value, houseNumber: '' }
}
