/**
 * Reine Logik der Auswahlbox (src/components/auswahl.tsx): Suche, Rangfolge,
 * Startwert. Ohne React, damit die Tests sie direkt prüfen können.
 */

export interface AuswahlOption {
  wert: string
  text: string
  /** Überschrift aus <optgroup label>. */
  gruppe?: string
  deaktiviert: boolean
  /** Normalisierter Suchtext: Beschriftung, Gruppe und data-suche. */
  suche: string
}

/** Kleinbuchstaben, Akzente weg (ü → u, é → e), ß → ss, Leerraum zusammengefasst. */
export function normalisieren(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Treffer zur Eingabe: Jedes Wort der Eingabe muss vorkommen (Reihenfolge
 * egal — „pcb native" findet „NATIVE 75 Hot Swap PCB"). Vorn stehen
 * Optionen, deren Text mit der Eingabe beginnt, dann solche mit einem
 * Wortanfang, dann der Rest — sonst in der Reihenfolge der Liste.
 */
export function filtern(
  optionen: readonly AuswahlOption[],
  eingabe: string,
  max = 200,
): { treffer: AuswahlOption[]; mehr: number } {
  const anfrage = normalisieren(eingabe)
  if (!anfrage) {
    return { treffer: optionen.slice(0, max), mehr: Math.max(0, optionen.length - max) }
  }
  const woerter = anfrage.split(' ')
  const stufen: AuswahlOption[][] = [[], [], []]
  for (const o of optionen) {
    if (!woerter.every((w) => o.suche.includes(w))) continue
    const text = normalisieren(o.text)
    const stufe = text.startsWith(anfrage) ? 0 : (` ${text}`).includes(` ${woerter[0]}`) ? 1 : 2
    stufen[stufe].push(o)
  }
  const alle = stufen.flat()
  return { treffer: alle.slice(0, max), mehr: Math.max(0, alle.length - max) }
}

/**
 * Startwert wie beim nativen <select>: der vorgegebene Wert, wenn es ihn
 * als Option gibt — sonst die erste nicht gesperrte Option (genau das hätte
 * der Browser abgeschickt). Mehrfachauswahl: nur vorhandene Werte, sonst leer.
 */
export function startwert(
  optionen: readonly AuswahlOption[],
  vorgabe: string | number | readonly string[] | undefined,
  mehrfach: boolean,
): string | string[] {
  if (mehrfach) {
    const gewuenscht = new Set((Array.isArray(vorgabe) ? vorgabe : vorgabe == null ? [] : [vorgabe]).map(String))
    return optionen.filter((o) => gewuenscht.has(o.wert)).map((o) => o.wert)
  }
  if (vorgabe != null && !Array.isArray(vorgabe)) {
    const v = String(vorgabe)
    if (optionen.some((o) => o.wert === v)) return v
  }
  return optionen.find((o) => !o.deaktiviert)?.wert ?? ''
}
