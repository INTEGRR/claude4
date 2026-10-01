import { zahlLesen } from './einkaufsprojekt.ts'

/**
 * Eingangssendungen (0108), pur: Beschriftungen, die Verteilung auf die
 * Wareneingänge (Spiegel von eingangs_sendung_verteilen in SQL — für
 * Vorschau und Unit-Test) und das Einlesen von Zollzeilen. Geteilt von
 * Registry, Ausführung, Oberfläche und Tests.
 */

export const SENDUNG_STATUS = {
  geplant: 'Geplant',
  verschifft: 'Verschifft',
  verzollt: 'Verzollt',
  angekommen: 'Angekommen',
  abgerechnet: 'Abgerechnet',
  storniert: 'Storniert',
} as const
export type SendungStatus = keyof typeof SENDUNG_STATUS

/** Solange die Sendung reist oder auf die Abrechnung wartet. */
export const SENDUNG_LAUFEND: SendungStatus[] = ['geplant', 'verschifft', 'verzollt', 'angekommen']

export const SENDUNG_MODI = { see: 'See', luft: 'Luft', express: 'Express (Kurier)' } as const
export type SendungModus = keyof typeof SENDUNG_MODI
export const SENDUNG_MODUS_NAMEN = Object.keys(SENDUNG_MODI) as [SendungModus, ...SendungModus[]]

export const KOSTEN_ARTEN = {
  fracht: 'Fracht',
  zoll: 'Zoll',
  eust: 'Einfuhrumsatzsteuer (EUSt)',
  versicherung: 'Versicherung',
  sonstiges: 'Sonstiges',
} as const
export type KostenArt = keyof typeof KOSTEN_ARTEN
export const KOSTEN_ART_NAMEN = Object.keys(KOSTEN_ARTEN) as [KostenArt, ...KostenArt[]]

/**
 * Die EUSt ist Vorsteuer, kein Einstand — sie wird nie auf die Ware
 * verteilt (Betreiber 2026-09-29: „Zoll und Fracht als Einstandskosten,
 * EUSt getrennt").
 */
export function kostenartVerteilbar(art: KostenArt): boolean {
  return art !== 'eust'
}

/**
 * Verteilschlüssel einer Kostenart: Fracht nach Gewicht, wenn jede gebuchte
 * Position ein Gewicht hat, sonst nach Warenwert; alles andere nach
 * Warenwert (Zoll ist ein Wertzoll, Versicherung folgt dem Wert).
 */
export function verteilSchluessel(art: KostenArt, alleMitGewicht: boolean): 'gewicht' | 'wert' {
  return art === 'fracht' && alleMitGewicht ? 'gewicht' : 'wert'
}

/**
 * Betrag anteilig auf die Basen verteilen — auf den Cent, der Rundungsrest
 * geht auf den letzten Eingang; die Summe ist immer exakt der Betrag.
 * Ohne Basis gleichmäßig. Im Grenzfall winziger Anteile (der Rest würde
 * negativ) kumulativ gerundet. Rechnet in ganzen Cent, damit kein
 * Fließkomma-Rest entsteht — dieselbe Regel wie eingangs_sendung_verteilen.
 */
export function verteilen(betrag: number, basen: number[]): number[] {
  const n = basen.length
  if (n === 0) return []
  const cent = Math.round(betrag * 100)
  const sicher = basen.map((b) => (Number.isFinite(b) && b > 0 ? b : 0))
  let summe = sicher.reduce((a, b) => a + b, 0)
  const basis = summe > 0 ? sicher : sicher.map(() => 1)
  if (summe <= 0) summe = n

  const anteile = basis.map(() => 0)
  let rest = cent
  for (let i = 0; i < n - 1; i++) {
    anteile[i] = Math.round((cent * basis[i]) / summe)
    rest -= anteile[i]
  }
  anteile[n - 1] = rest
  if (rest < 0) {
    let kum = 0
    let vorher = 0
    for (let i = 0; i < n; i++) {
      kum += basis[i]
      anteile[i] = Math.round((cent * kum) / summe) - vorher
      vorher += anteile[i]
    }
  }
  return anteile.map((c) => c / 100)
}

export interface ZollZeile {
  hs_code: string
  zollwert_eur: number
  zoll_eur: number
  eust_eur: number
}

/**
 * Zollzeilen aus dem Zollbescheid, eine je Zeile: „HS-Code; Zollwert; Zoll;
 * EUSt" — getrennt durch Semikolon, Tabulator (aus Excel kopiert) oder „|".
 * HS-Code mit oder ohne Leerzeichen/Punkte (8473 30 20 → 84733020),
 * Zahlen deutsch oder englisch. Leere Zeilen und #-Kommentare zählen
 * nicht; unlesbare Zeilen werden genannt, nicht verschluckt.
 */
export function zollzeilenLesen(text: string): { zeilen: ZollZeile[]; fehler: string[] } {
  const zeilen: ZollZeile[] = []
  const fehler: string[] = []
  for (const [i, roh] of text.split(/\r?\n/).entries()) {
    const zeile = roh.trim()
    if (!zeile || zeile.startsWith('#')) continue
    const teile = zeile
      .split(/[;\t|]/)
      .map((t) => t.trim())
      .filter((t) => t !== '')
    const hs = (teile[0] ?? '').replace(/[\s.]/g, '')
    if (!/^\d{4,10}$/.test(hs)) {
      fehler.push(`Zeile ${i + 1}: „${zeile}" — HS-Code (4–10 Ziffern) fehlt am Anfang`)
      continue
    }
    if (teile.length < 3) {
      fehler.push(`Zeile ${i + 1}: „${zeile}" — erwartet „HS-Code; Zollwert; Zoll; EUSt"`)
      continue
    }
    const [zollwert, zoll, eust] = [teile[1], teile[2], teile[3] ?? '0'].map((t) => zahlLesen(t, 'preis'))
    if (zollwert === null || zoll === null || eust === null || zollwert < 0 || zoll < 0 || eust < 0) {
      fehler.push(`Zeile ${i + 1}: „${zeile}" — Beträge nicht lesbar`)
      continue
    }
    zeilen.push({ hs_code: hs, zollwert_eur: zollwert, zoll_eur: zoll, eust_eur: eust })
  }
  return { zeilen, fehler }
}

/** Zollsatz in Prozent aus Zollwert und Zoll (für die Anzeige der Zollzeilen). */
export function zollsatz(zollwert: number, zoll: number): number | null {
  if (!(zollwert > 0)) return null
  return Math.round((10000 * zoll) / zollwert) / 100
}

/** Bestellnummern aus Freitext („P00042, P00043" oder je Zeile). */
export function bestellnummernLesen(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean))]
}
