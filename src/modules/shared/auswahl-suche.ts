/**
 * Serversuche der Auswahlfelder (A2) — was Client und Endpunkt teilen.
 */

/** Wonach ein Auswahlfeld im Server nachladen kann. */
export const NACHLADE_ARTEN = [
  'variante', 'variante-ware', 'variante-verkauf', 'variante-einkauf', 'kunde', 'lieferant', 'partner',
] as const
export type NachladeArt = (typeof NACHLADE_ARTEN)[number]

/** Ab so vielen Zeichen wird im Server gesucht. */
export const NACHLADEN_AB = 2

/** Suchwörter: Kleinbuchstaben, höchstens sechs, jedes mindestens ein Zeichen. */
export function suchWoerter(eingabe: string): string[] {
  const woerter = eingabe.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 6)
  return woerter.join('').length >= NACHLADEN_AB ? woerter : []
}
