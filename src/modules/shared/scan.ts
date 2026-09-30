/**
 * Gescannte Codes robust vergleichen. Handscanner tippen wie eine Tastatur —
 * steht der Scanner auf US-Belegung und Windows auf Deutsch (QWERTZ), kommt
 * ein anderes Zeichen an als gedruckt: „WH/OUT/00003" wird „WH-OUT-00003",
 * „KC-001" wird „KCß001", Y und Z tauschen. Jeder Scan wird deshalb erst
 * genau so gesucht wie getippt und dann in der Rückübersetzung. Die
 * eigentliche Abhilfe bleibt, den Scanner auf deutsche Tastatur zu stellen
 * (Konfigurations-Barcode im Handbuch des Scanners).
 */

/** Was auf deutschem Windows ankommt → was der US-Scanner gemeint hat. */
const US_AUF_DE: Record<string, string> = {
  '-': '/',
  ß: '-',
  z: 'y',
  y: 'z',
  Z: 'Y',
  Y: 'Z',
  '§': '#',
  '?': '_',
  Ö: ':',
}

/** Rückübersetzung eines Scans, der mit US-Belegung auf deutschem Windows getippt wurde. */
export function scanUsBelegung(code: string): string {
  return [...code].map((z) => US_AUF_DE[z] ?? z).join('')
}

/** Suchkandidaten eines Scans: wie getippt, dann rückübersetzt (ohne Doppelte). */
export function scanVarianten(code: string): string[] {
  const roh = code.trim()
  if (!roh) return []
  const us = scanUsBelegung(roh)
  return us === roh ? [roh] : [roh, us]
}

/** Passt ein Scan zu einer Kennung (SKU, Barcode, Belegnummer)? Ohne Groß/Klein, beide Belegungen. */
export function scanGleich(gescannt: string, kennung: string | null | undefined): boolean {
  const ziel = (kennung ?? '').trim().toLowerCase()
  if (!ziel) return false
  return scanVarianten(gescannt).some((v) => v.toLowerCase() === ziel)
}
