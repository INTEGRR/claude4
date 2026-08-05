/**
 * Reine Code-Tabellen für DHL — ohne Server-Abhängigkeiten, damit direkt
 * testbar.
 */

/** ISO 3166-1 alpha-2 (Systemformat) -> alpha-3 (DHL-Format, seit v2.1.13 Pflicht). */
const ALPHA3: Record<string, string> = {
  DE: 'DEU', AT: 'AUT', CH: 'CHE', NL: 'NLD', BE: 'BEL', LU: 'LUX', FR: 'FRA',
  IT: 'ITA', ES: 'ESP', PT: 'PRT', DK: 'DNK', SE: 'SWE', FI: 'FIN', NO: 'NOR',
  PL: 'POL', CZ: 'CZE', SK: 'SVK', HU: 'HUN', SI: 'SVN', HR: 'HRV', GB: 'GBR',
  IE: 'IRL', EE: 'EST', LV: 'LVA', LT: 'LTU', RO: 'ROU', BG: 'BGR', GR: 'GRC',
}

/** Länder, die über das Europaket bedient werden (EU + EFTA-Nachbarn). */
const EUROPAKET = new Set(Object.keys(ALPHA3).filter((c) => c !== 'DE'))

export function toAlpha3(code: string | null | undefined): string {
  const upper = (code ?? '').toUpperCase()
  if (upper.length === 3) return upper
  return ALPHA3[upper] ?? 'DEU'
}

/** Wählt das DHL-Produkt anhand des Ziellands. */
export function productForCountry(countryAlpha2: string | null | undefined): string {
  const code = (countryAlpha2 ?? 'DE').toUpperCase()
  if (code === 'DE' || code === 'DEU') return 'V01PAK'
  const alpha2 = code.length === 3
    ? (Object.entries(ALPHA3).find(([, v]) => v === code)?.[0] ?? code)
    : code
  return EUROPAKET.has(alpha2) ? 'V54EPAK' : 'V53WPAK'
}

export function trackingUrl(shipmentNumber: string): string {
  return (
    'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html' +
    `?piececode=${encodeURIComponent(shipmentNumber)}`
  )
}
