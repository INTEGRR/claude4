/**
 * Reine Logik des Startseiten-Trailers (trailer.tsx): Zeitplan, Kapitel und
 * Bühnenmaße. Die Zeiten müssen zu den absoluten Verzögerungen in start.css
 * (Abschnitt „Trailer") und den `--t`-Werten der Szenen passen —
 * tests/trailer.test.ts gleicht das ab.
 */

/** Gesamtlänge in Sekunden — Dauer der Uhr-Animation `tr-zeit`. */
export const DAUER = 41

/** Ab hier steht die Endkarte; kein Kapitel ist mehr aktiv. */
export const ENDKARTE = 38.6

/** Kapitel = Szenenanfänge (Sekunden). Der Auftakt davor ist kein Kapitel. */
export const KAPITEL = [
  { name: 'Shop', t: 4 },
  { name: 'Fertigung', t: 9.5 },
  { name: 'Versand', t: 15 },
  { name: 'Einkauf', t: 20.5 },
  { name: 'Prozess', t: 28 },
  { name: 'KI', t: 33.5 },
] as const

/** Index des Kapitels zur Zeit `s`, -1 im Auftakt und auf der Endkarte. */
export function kapitelBei(s: number): number {
  if (s >= ENDKARTE) return -1
  let i = -1
  KAPITEL.forEach((k, j) => {
    if (s >= k.t) i = j
  })
  return i
}

export function zeitText(s: number): string {
  const ganz = Math.max(0, Math.floor(s))
  return `${Math.floor(ganz / 60)}:${String(ganz % 60).padStart(2, '0')}`
}

export const QUER = { breite: 1920, hoehe: 1080 } as const
export const HOCH = { breite: 1080, hoehe: 1400 } as const

/**
 * Format und Skalierung für eine Rahmenbreite. Quer ab 820 px (darunter
 * wird die 16:9-Schrift zu klein) oder wenn das Fenster deutlich breiter
 * als hoch ist (Telefon quer). Die Höhe ist gedeckelt, damit der Held nicht
 * größer als das Fenster wird — die Bühne steht dann mittig im Rahmen.
 */
export function masse(rahmenBreite: number, fensterHoehe: number): {
  format: 'quer' | 'hoch'
  skala: number
  hoehe: number
  links: number
} {
  const breit = rahmenBreite >= 820 || rahmenBreite > fensterHoehe * 1.2
  const b = breit ? QUER : HOCH
  const deckel = fensterHoehe * (breit ? 0.85 : 0.8)
  const skala = Math.max(0.05, Math.min(rahmenBreite / b.breite, deckel / b.hoehe))
  return {
    format: breit ? 'quer' : 'hoch',
    skala,
    hoehe: Math.round(b.hoehe * skala),
    links: Math.round((rahmenBreite - b.breite * skala) / 2),
  }
}
