/**
 * Reine Code-Tabellen für DHL — ohne Server-Abhängigkeiten, damit direkt
 * testbar.
 */
import type { Zone } from './regeln-logik'

/** ISO 3166-1 alpha-2 (Systemformat) -> alpha-3 (DHL-Format, seit v2.1.13 Pflicht). */
const ALPHA3: Record<string, string> = {
  // EU
  DE: 'DEU', AT: 'AUT', BE: 'BEL', BG: 'BGR', HR: 'HRV', CY: 'CYP', CZ: 'CZE',
  DK: 'DNK', EE: 'EST', FI: 'FIN', FR: 'FRA', GR: 'GRC', HU: 'HUN', IE: 'IRL',
  IT: 'ITA', LV: 'LVA', LT: 'LTU', LU: 'LUX', MT: 'MLT', NL: 'NLD', PL: 'POL',
  PT: 'PRT', RO: 'ROU', SK: 'SVK', SI: 'SVN', ES: 'ESP', SE: 'SWE',
  // Europa außerhalb der Zollunion
  CH: 'CHE', GB: 'GBR', NO: 'NOR', IS: 'ISL', LI: 'LIE', UA: 'UKR', RS: 'SRB',
  BA: 'BIH', MK: 'MKD', AL: 'ALB', ME: 'MNE', TR: 'TUR', MC: 'MCO', AD: 'AND',
  SM: 'SMR',
  // Übersee (gängige Ziele)
  US: 'USA', CA: 'CAN', MX: 'MEX', BR: 'BRA', AR: 'ARG', CL: 'CHL',
  AU: 'AUS', NZ: 'NZL', JP: 'JPN', KR: 'KOR', CN: 'CHN', TW: 'TWN', HK: 'HKG',
  SG: 'SGP', MY: 'MYS', TH: 'THA', ID: 'IDN', PH: 'PHL', VN: 'VNM', IN: 'IND',
  AE: 'ARE', IL: 'ISR', SA: 'SAU', QA: 'QAT', ZA: 'ZAF', EG: 'EGY',
}

/**
 * EU-Zollunion: dorthin geht das Europaket ohne Zollpapiere. CH, GB und NO
 * sind bewusst NICHT dabei — das sind zollpflichtige Drittländer, auch wenn
 * sie mitten in Europa liegen.
 */
const EU = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI',
  'ES', 'SE',
])

function toAlpha2(code: string | null | undefined): string {
  const upper = (code ?? 'DE').toUpperCase()
  if (upper.length !== 3) return upper
  return Object.entries(ALPHA3).find(([, v]) => v === upper)?.[0] ?? upper
}

export function toAlpha3(code: string | null | undefined): string {
  const upper = (code ?? '').toUpperCase()
  if (upper.length === 3) return upper
  return ALPHA3[upper] ?? 'DEU'
}

/** Versandzone des Ziellands: entscheidet Produktwahl und Zollpflicht. */
export function zoneForCountry(code: string | null | undefined): Zone {
  const alpha2 = toAlpha2(code)
  if (alpha2 === 'DE') return 'de'
  return EU.has(alpha2) ? 'eu' : 'world'
}

/** Rückfallebene, wenn keine Versandregel ein Produkt bestimmt. */
export function productForCountry(countryCode: string | null | undefined): string {
  const zone = zoneForCountry(countryCode)
  return zone === 'de' ? 'V01PAK' : zone === 'eu' ? 'V54EPAK' : 'V53WPAK'
}

/** Braucht eine Sendung in dieses Land Zolldaten (CN23)? */
export function brauchtZoll(countryCode: string | null | undefined): boolean {
  return zoneForCountry(countryCode) === 'world'
}

export function trackingUrl(shipmentNumber: string): string {
  return (
    'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html' +
    `?piececode=${encodeURIComponent(shipmentNumber)}`
  )
}
