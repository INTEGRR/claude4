/**
 * Aufgaben (0104): gesprochene und getippte Termine und Teams in feste Werte
 * übersetzen. Rein rechnend, ohne Importe — unter blankem Node testbar, von
 * Executor und Formular gleichermaßen genutzt.
 *
 * Termin: „heute", „morgen", „übermorgen", ein Wochentag (der nächste,
 * heute eingeschlossen), „JJJJ-MM-TT", „TT.MM.JJJJ" oder „TT.MM." (dieses
 * Jahr, ist der Tag schon vorbei: nächstes). Uhrzeit: „15", „15 Uhr",
 * „15:30", „15.30", „9:05 Uhr".
 */

const WOCHENTAGE = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag']

const iso = (d: Date) => d.toISOString().slice(0, 10)

function tagePlus(heute: string, tage: number): string {
  const d = new Date(`${heute}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + tage)
  return iso(d)
}

function gueltig(jahr: number, monat: number, tag: number): string | null {
  const d = new Date(Date.UTC(jahr, monat - 1, tag, 12))
  if (d.getUTCFullYear() !== jahr || d.getUTCMonth() !== monat - 1 || d.getUTCDate() !== tag) return null
  return iso(d)
}

/** Termin-Text → „JJJJ-MM-TT". `heute` ist das heutige Datum (Ortszeit) als „JJJJ-MM-TT". */
export function datumAufloesen(text: string, heute: string): string {
  const t = text.trim().toLowerCase().replace(/^(am|bis|ab)\s+/, '').replace(/\s+/g, ' ')
  if (t === '' || t === 'heute') return heute
  if (t === 'morgen') return tagePlus(heute, 1)
  if (t === 'übermorgen' || t === 'uebermorgen') return tagePlus(heute, 2)

  const wochentag = WOCHENTAGE.indexOf(t.replace(/^(nächsten|naechsten|kommenden)\s+/, ''))
  if (wochentag >= 0) {
    const jetzt = new Date(`${heute}T12:00:00Z`).getUTCDay()
    return tagePlus(heute, (wochentag - jetzt + 7) % 7)
  }

  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) {
    const d = gueltig(Number(m[1]), Number(m[2]), Number(m[3]))
    if (d) return d
  }
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/)
  if (m) {
    const jahr = m[3] ? Number(m[3]) : Number(heute.slice(0, 4))
    const d = gueltig(jahr, Number(m[2]), Number(m[1]))
    if (d && (m[3] || d >= heute)) return d
    if (d) return gueltig(jahr + 1, Number(m[2]), Number(m[1])) ?? d
  }
  throw new Error(
    `Termin „${text}" verstehe ich nicht — heute, morgen, ein Wochentag oder ein Datum (TT.MM.JJJJ).`,
  )
}

/** Uhrzeit-Text → „HH:MM" (leer → null). */
export function uhrzeitAufloesen(text: string | undefined | null): string | null {
  const t = (text ?? '').trim().toLowerCase().replace(/\s*uhr$/, '').replace(/^um\s+/, '')
  if (t === '') return null
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?$/)
  const stunde = m ? Number(m[1]) : -1
  const minute = m?.[2] ? Number(m[2]) : 0
  if (!m || stunde > 23 || minute > 59) {
    throw new Error(`Uhrzeit „${text}" verstehe ich nicht — z. B. 15 Uhr oder 15:30.`)
  }
  return `${String(stunde).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Heutiges Datum in Berlin als „JJJJ-MM-TT" (der Server läuft in UTC). */
export function heuteInBerlin(jetzt: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(jetzt)
}

/** Teams, an die eine Aufgabe gehen kann — die Rollen der Bereichsmatrix. */
export const TEAMS = {
  lager: 'Lager',
  fertigung: 'Fertigung',
  mitarbeiter: 'Büro',
} as const
export type Team = keyof typeof TEAMS

/**
 * „Lager", „das Lagerteam", „rolle:fertigung", „Büro" → Rolle; sonst null
 * (dann ist eine Person gemeint).
 */
export function teamAusText(text: string): Team | null {
  const FUELLWOERTER = new Set(['an', 'ans', 'das', 'die', 'den', 'team', 'für', 'fürs', 'alle', 'aus', 'dem', 'der'])
  const woerter = text.trim().toLowerCase().replace(/^rolle:/, '').split(/\s+/)
  while (woerter.length > 1 && FUELLWOERTER.has(woerter[0])) woerter.shift()
  const t = woerter.join(' ').replace(/[-\s]?(team|leute|mitarbeiter)$/, '')
  if (t === 'lager' || t === 'versand') return 'lager'
  if (t === 'fertigung' || t === 'produktion' || t === 'montage') return 'fertigung'
  if (t === 'büro' || t === 'buero' || t === 'office') return 'mitarbeiter'
  return null
}

/** „ich", „mich", „mir", „selbst" → die Aufgabe ist für den Anlegenden. */
export function istSelbst(text: string): boolean {
  return ['ich', 'mich', 'mir', 'selbst', 'mich selbst'].includes(text.trim().toLowerCase())
}
