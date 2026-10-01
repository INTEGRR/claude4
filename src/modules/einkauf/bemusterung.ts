/**
 * Bemusterung (0107), pur: Beschriftungen und kleine Regeln für Muster-
 * Runden — geteilt von Registry, Ausführung, Oberfläche und Unit-Tests.
 * Frei von Datenbank-Importen.
 */

export const MUSTER_ERGEBNISSE = {
  freigeben: 'Freigeben',
  nachbessern: 'Nachbessern lassen',
  ablehnen: 'Ablehnen',
} as const
export type MusterErgebnis = keyof typeof MUSTER_ERGEBNISSE
export const MUSTER_ERGEBNIS_NAMEN = Object.keys(MUSTER_ERGEBNISSE) as [MusterErgebnis, ...MusterErgebnis[]]

/** Ergebnis der Bewertung → Status der Runde (Enum bemusterung_status). */
export const ERGEBNIS_STATUS: Record<MusterErgebnis, 'freigegeben' | 'nachbessern' | 'abgelehnt'> = {
  freigeben: 'freigegeben',
  nachbessern: 'nachbessern',
  ablehnen: 'abgelehnt',
}

export const BEWERTUNG_NOTEN = {
  5: '5 – einwandfrei',
  4: '4 – gut, kleine Mängel',
  3: '3 – brauchbar',
  2: '2 – deutliche Mängel',
  1: '1 – unbrauchbar',
} as const

/** Bezeichnung einer Runde in Listen: „Runde 2 · Rev. B · Farbmuster". */
export function rundeText(r: { runde: number; revision?: string | null; bezeichnung?: string | null }): string {
  return [`Runde ${r.runde}`, r.revision ? `Rev. ${r.revision}` : null, r.bezeichnung || null].filter(Boolean).join(' · ')
}

/**
 * Tracking als Link, wenn es einer ist (Lieferanten schicken oft den
 * Verfolgungslink); sonst bleibt die Sendungsnummer Text.
 */
export function trackingLink(tracking: string | null | undefined): string | null {
  const t = (tracking ?? '').trim()
  return /^https?:\/\/\S+$/i.test(t) ? t : null
}

/** Die Revision der nächsten Runde: A → B, 1 → 2, sonst leer (der Mensch trägt ein). */
export function naechsteRevision(revision: string | null | undefined): string | null {
  const r = (revision ?? '').trim()
  if (/^\d+$/.test(r)) return String(Number(r) + 1)
  if (/^[A-Y]$/.test(r)) return String.fromCharCode(r.charCodeAt(0) + 1)
  if (/^[a-y]$/.test(r)) return String.fromCharCode(r.charCodeAt(0) + 1)
  return null
}
