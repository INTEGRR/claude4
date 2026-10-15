/**
 * Abnahmetest — Soll gegen Ist, Feld für Feld. Rein, ohne Datenbank.
 *
 * Beide Stände werden zu Pfaden geplättet (`bestand.KB-65.mac`); Zahlen
 * gelten als gleich, wenn sie auf sechs Stellen übereinstimmen — genauer
 * rechnet keine der beteiligten Spalten. Jede Abweichung wird mit Pfad,
 * Soll und Ist genannt, nicht nur die erste: wer den Lauf liest, soll das
 * ganze Bild sehen.
 */

export interface Abweichung {
  pfad: string
  soll: unknown
  ist: unknown
}

type Blatt = string | number | boolean | null

function plaetten(wert: unknown, pfad: string, out: Map<string, Blatt>): void {
  if (wert === null || typeof wert !== 'object') {
    out.set(pfad, wert as Blatt)
    return
  }
  const eintraege = Object.entries(wert as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  if (eintraege.length === 0) {
    out.set(pfad, '{}')
    return
  }
  for (const [k, v] of eintraege) plaetten(v, pfad ? `${pfad}.${k}` : k, out)
}

function gleich(a: Blatt | undefined, b: Blatt | undefined): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 5e-7
  return a === b
}

export function vergleichen(soll: unknown, ist: unknown): Abweichung[] {
  const s = new Map<string, Blatt>()
  const i = new Map<string, Blatt>()
  plaetten(soll, '', s)
  plaetten(ist, '', i)
  const pfade = [...new Set([...s.keys(), ...i.keys()])].sort()
  const abweichungen: Abweichung[] = []
  for (const pfad of pfade) {
    if (!gleich(s.get(pfad), i.get(pfad))) {
      abweichungen.push({ pfad, soll: s.has(pfad) ? s.get(pfad) : '(fehlt)', ist: i.has(pfad) ? i.get(pfad) : '(fehlt)' })
    }
  }
  return abweichungen
}

export function abweichungenText(titel: string, abweichungen: Abweichung[]): string {
  if (abweichungen.length === 0) return `${titel}: Soll = Ist`
  const breite = Math.max(...abweichungen.map((a) => a.pfad.length))
  return [
    `${titel}: ${abweichungen.length} Abweichung(en)`,
    ...abweichungen.map((a) => `  ${a.pfad.padEnd(breite)}  Soll ${String(a.soll)}  Ist ${String(a.ist)}`),
  ].join('\n')
}

/** Kompakte Tabelle eines Stands für Protokoll und Bericht. */
export function standText(stand: unknown): string {
  const out = new Map<string, Blatt>()
  plaetten(stand, '', out)
  const breite = Math.max(...[...out.keys()].map((k) => k.length))
  return [...out.entries()].map(([k, v]) => `${k.padEnd(breite)}  ${String(v)}`).join('\n')
}
