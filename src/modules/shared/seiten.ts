/**
 * Seitenaufteilung der Listen (F3, Entscheidungslog 2026-10-17): statt
 * „limit 200" ohne Hinweis eine Seite zu 50 Zeilen mit Gesamtzahl. Die
 * Abfrage nimmt `limit`/`offset` und zählt mit `count(*) over () as gesamt`.
 * Rein — getestet in tests/seiten.test.ts.
 */

export const SEITE_GROESSE = 50

export interface Seite {
  seite: number
  groesse: number
  limit: number
  offset: number
}

/** Liest `?seite=` (1-basiert); Unsinn wird Seite 1. */
export function seitenParameter(sp: { seite?: string | string[] }, groesse = SEITE_GROESSE): Seite {
  const roh = Array.isArray(sp.seite) ? sp.seite[0] : sp.seite
  const n = Number.parseInt(roh ?? '', 10)
  const seite = Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 1
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

/** „1–50 von 318" — oder null, wenn alles auf eine Seite passt. */
export function seitenText(s: Seite, gesamt: number): string | null {
  if (gesamt <= s.groesse && s.seite === 1) return null
  if (gesamt === 0) return `Seite ${s.seite} ist leer`
  const von = Math.min(s.offset + 1, gesamt)
  const bis = Math.min(s.offset + s.groesse, gesamt)
  return `${von}–${bis} von ${gesamt.toLocaleString('de-DE')}`
}
