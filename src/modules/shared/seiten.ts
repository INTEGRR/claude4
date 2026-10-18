/**
 * Seitenaufteilung der Listen (F3, Entscheidungslog 2026-10-17): statt
 * „limit 200" ohne Hinweis eine Seite mit Gesamtzahl. Die Abfrage nimmt
 * `limit`/`offset` und zählt mit `count(*) over () as gesamt`.
 * Seit 2026-10-18 wählbar: `?pro=10|25|100` Zeilen je Seite (Standard 25).
 * Rein — getestet in tests/seiten.test.ts.
 */

/** Wählbare Zeilen je Seite (Betreiber 2026-10-18). */
export const SEITE_GROESSEN = [10, 25, 100] as const
export const SEITE_GROESSE = 25

export interface Seite {
  seite: number
  groesse: number
  limit: number
  offset: number
}

const ersterWert = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Liest `?seite=` (1-basiert) und `?pro=` (10/25/100); Unsinn wird Seite 1 bzw. der Standard. */
export function seitenParameter(sp: { seite?: string | string[]; pro?: string | string[] }, standard = SEITE_GROESSE): Seite {
  const n = Number.parseInt(ersterWert(sp.seite) ?? '', 10)
  const seite = Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 1
  const pro = Number.parseInt(ersterWert(sp.pro) ?? '', 10)
  const groesse = (SEITE_GROESSEN as readonly number[]).includes(pro) ? pro : standard
  return { seite, groesse, limit: groesse, offset: (seite - 1) * groesse }
}

/** Gesamtzahl aus der ersten Zeile (`count(*) over ()`), 0 bei leerer Seite. */
export function gesamtAus(zeilen: ArrayLike<object>): number {
  const erste = zeilen[0] as { gesamt?: number | string | null } | undefined
  return Number(erste?.gesamt ?? 0)
}

/** Link auf eine andere Seite — alle übrigen Filter bleiben erhalten. */
export function seitenHref(pfad: string, params: Record<string, string | string[] | undefined>, seite: number): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (k === 'seite' || v === undefined || v === '') continue
    for (const w of Array.isArray(v) ? v : [v]) q.append(k, w)
  }
  if (seite > 1) q.set('seite', String(seite))
  const s = q.toString()
  return s ? `${pfad}?${s}` : pfad
}

/** Link mit anderer Seitengröße — zurück auf Seite 1, Standard ohne Parameter. */
export function groesseHref(pfad: string, params: Record<string, string | string[] | undefined>, groesse: number): string {
  const ohne = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'pro' && k !== 'seite'))
  const basis = seitenHref(pfad, ohne, 1)
  if (groesse === SEITE_GROESSE) return basis
  return `${basis}${basis.includes('?') ? '&' : '?'}pro=${groesse}`
}

/**
 * Seitenzahlen mit Auslassung: erste, letzte, und zwei um die aktuelle —
 * `[1, '…', 4, 5, 6, '…', 13]`.
 */
export function seitenZahlen(aktuell: number, letzte: number): (number | '…')[] {
  const zeigen = new Set([1, letzte, aktuell - 1, aktuell, aktuell + 1].filter((n) => n >= 1 && n <= letzte))
  const sortiert = [...zeigen].sort((a, b) => a - b)
  const ergebnis: (number | '…')[] = []
  sortiert.forEach((n, i) => {
    if (i > 0 && n - sortiert[i - 1] > 1) ergebnis.push(n - sortiert[i - 1] === 2 ? n - 1 : '…')
    ergebnis.push(n)
  })
  return ergebnis
}

/** „1–25 von 318" — oder null, wenn alles auf eine Seite passt. */
export function seitenText(s: Seite, gesamt: number): string | null {
  if (gesamt <= s.groesse && s.seite === 1) return null
  if (gesamt === 0) return `Seite ${s.seite} ist leer`
  const von = Math.min(s.offset + 1, gesamt)
  const bis = Math.min(s.offset + s.groesse, gesamt)
  return `${von}–${bis} von ${gesamt.toLocaleString('de-DE')}`
}
