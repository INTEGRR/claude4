/**
 * Vorschlag, welcher Shop-Artikel dasselbe Einzelteil ist wie eine aus Odoo
 * angelegte Komponente (Entscheidungslog 2026-09-30, „Doppelte Artikel
 * zusammenführen"). Rein rechnend, ohne Datenbank.
 *
 * Shopify und Odoo benennen dasselbe Teil verschieden („GATERON Switches
 * (Typ: G PRO 2.0 YELLOW)" gegen „[SW-GT-LY-001] Gateron Switch Linear
 * Yellow") und haben verschiedene SKUs. Verglichen werden darum die
 * Namensmerkmale ohne Füllwörter (Jaccard-Ähnlichkeit). Vorausgewählt wird
 * nur ein EINDEUTIGER Treffer mit Ähnlichkeit über 0,5 — bei Zweifel (Cherry
 * gegen Gateron, Foams ohne unterscheidendes Wort) entscheidet der Mensch.
 * Vorschlag heißt nie Ausführen: jedes Paar bestätigt der Betreiber.
 */

/** Wörter, die Teile nicht unterscheiden (Gattung, Bauart, Layout, Füllwörter). */
const FUELLWOERTER = new Set([
  'switch', 'switches', 'typ', 'type', 'pro', 'linear', 'tactile', 'clicky', 'speed',
  'native', 'anvil', 'für', 'fur', 'for', 'the', 'und', 'and', 'mit', 'with',
  'foam', 'pcb', 'hot', 'swap', 'layout', 'iso', 'ansi', 'qwertz', 'qwerty',
])

/** Unterscheidende Wörter eines Artikelnamens (SKU in eckigen Klammern entfernt). */
export function namensMerkmale(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, ' ')
      .split(/[^a-zäöüß]+/)
      .filter((w) => w.length > 1 && !FUELLWOERTER.has(w)),
  )
}

export function aehnlichkeit(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let gemeinsam = 0
  for (const w of a) if (b.has(w)) gemeinsam++
  return gemeinsam / (a.size + b.size - gemeinsam)
}

/**
 * Je linkem Artikel (aus Odoo angelegt) der eindeutig ähnlichste rechte
 * (Shop-Artikel) — nur über 0,5, nur wenn kein zweiter gleich gut passt,
 * und jeder rechte höchstens einmal (bei Gleichstand keiner).
 */
export function vorschlagen(
  links: { id: string; name: string }[],
  rechts: { id: string; name: string }[],
): Map<string, string> {
  const merkmaleRechts = rechts.map((r) => ({ id: r.id, m: namensMerkmale(r.name) }))
  const kandidaten: { links: string; rechts: string; wert: number }[] = []
  for (const l of links) {
    const m = namensMerkmale(l.name)
    const werte = merkmaleRechts
      .map((r) => ({ id: r.id, wert: aehnlichkeit(m, r.m) }))
      .sort((x, y) => y.wert - x.wert)
    const [bester, zweiter] = werte
    if (bester && bester.wert > 0.5 && (!zweiter || zweiter.wert < bester.wert)) {
      kandidaten.push({ links: l.id, rechts: bester.id, wert: bester.wert })
    }
  }
  const ergebnis = new Map<string, string>()
  for (const k of kandidaten) {
    const konkurrenz = kandidaten.filter((x) => x.rechts === k.rechts && x.links !== k.links)
    if (konkurrenz.every((x) => x.wert < k.wert)) ergebnis.set(k.links, k.rechts)
  }
  return ergebnis
}
