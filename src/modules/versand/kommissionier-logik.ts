/**
 * Kommissionieren (0091), pur und app-frei — geteilt vom Sammel-Screen am
 * Handy (Führung, Scan-Zuordnung) und von lager.kommissionieren (harte
 * Serverprüfung). Gesammelt wird je VARIANTE; gescannt wird gegen SKU
 * oder Artikel-Barcode (case-insensitiv) wie am Packtisch.
 */

export interface SammelPosition {
  variantId: string
  name: string
  sku: string | null
  barcode: string | null
  soll: number
  uom: string
}

export type Gesammelt = Record<string, number>

/** Laufreihenfolge: vorerst nach Artikelname (ohne Lagerplätze). */
export function sammelReihenfolge<P extends SammelPosition>(positionen: P[]): P[] {
  return [...positionen].sort((a, b) => a.name.localeCompare(b.name, 'de') || a.variantId.localeCompare(b.variantId))
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

export type ScanErgebnis =
  | { art: 'treffer'; variantId: string }
  | { art: 'voll'; variantId: string }
  | { art: 'fremd' }

/** Wohin gehört ein gescannter Code? Zuerst eine noch offene Position. */
export function scanTreffer(positionen: SammelPosition[], gesammelt: Gesammelt, code: string): ScanErgebnis {
  const c = norm(code)
  if (!c) return { art: 'fremd' }
  const passend = positionen.filter((p) => norm(p.sku) === c || norm(p.barcode) === c)
  if (passend.length === 0) return { art: 'fremd' }
  const offen = passend.find((p) => (gesammelt[p.variantId] ?? 0) < p.soll)
  return offen ? { art: 'treffer', variantId: offen.variantId } : { art: 'voll', variantId: passend[0].variantId }
}

/** Die nächste noch offene Position (ohne als fehlend markierte) — oder null. */
export function naechsteOffene<P extends SammelPosition>(
  positionen: P[],
  gesammelt: Gesammelt,
  fehlt: Set<string> = new Set(),
): P | null {
  return positionen.find((p) => !fehlt.has(p.variantId) && (gesammelt[p.variantId] ?? 0) < p.soll) ?? null
}

export function fortschritt(positionen: SammelPosition[], gesammelt: Gesammelt): { ist: number; soll: number } {
  return positionen.reduce(
    (s, p) => ({ ist: s.ist + Math.min(gesammelt[p.variantId] ?? 0, p.soll), soll: s.soll + p.soll }),
    { ist: 0, soll: 0 },
  )
}

export interface SammelAbgleich {
  /** Positionen mit zu wenig, als „Name (ist/soll)". */
  fehlend: string[]
  /** Gemeldete Varianten, die nicht zur Lieferung gehören. */
  fremd: string[]
  /** Mehr gesammelt als bestellt. */
  zuViel: string[]
  vollstaendig: boolean
}

export function sammelAbgleich(positionen: SammelPosition[], gesammelt: Gesammelt): SammelAbgleich {
  const bekannt = new Set(positionen.map((p) => p.variantId))
  const fehlend: string[] = []
  const zuViel: string[] = []
  for (const p of positionen) {
    const ist = Number(gesammelt[p.variantId] ?? 0)
    if (ist < p.soll) fehlend.push(`${p.sku ?? p.name} (${ist}/${p.soll})`)
    if (ist > p.soll) zuViel.push(`${p.sku ?? p.name} (${ist}/${p.soll})`)
  }
  const fremd = Object.keys(gesammelt).filter((k) => !bekannt.has(k) && Number(gesammelt[k]) > 0)
  return { fehlend, fremd, zuViel, vollstaendig: fehlend.length === 0 && fremd.length === 0 && zuViel.length === 0 }
}

/** Eine Sperre gilt so lange; danach darf ein anderer übernehmen. */
export const SPERRE_MINUTEN = 30
