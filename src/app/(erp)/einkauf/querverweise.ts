/**
 * Querverweise im Einkauf (Betreiber 2026-10-01): Statusschilder führen zu
 * den Belegen dahinter. Ein Beleg → direkt dorthin; mehrere → die
 * Sammelansicht (meist die Karte an der Bestellung); keiner → kein Link.
 */
export function belegLink(
  ids: readonly string[],
  einzeln: (id: string) => string,
  sammel: string,
): string | undefined {
  if (ids.length === 1) return einzeln(ids[0])
  return ids.length > 1 ? sammel : undefined
}
