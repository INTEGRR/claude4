/**
 * Auswertung von Mengenfeldern aus Formularen.
 *
 * Wichtig: Ein leeres Feld bedeutet "nicht angegeben" und darf NICHT als 0
 * gelesen werden. `Number('')` ergibt 0 — würde man das übernehmen, würden
 * z. B. bei der Fertigmeldung alle Komponenten mit Menge 0 gebucht und damit
 * storniert, obwohl das Fertigprodukt entsteht.
 */
export function parseQtyMap(formData: FormData, prefix: string): Record<string, number> {
  const result: Record<string, number> = {}

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(prefix)) continue
    if (typeof value !== 'string') continue

    const trimmed = value.trim()
    if (trimmed === '') continue // nicht angegeben => Vorgabewert gilt

    const num = Number(trimmed)
    if (!Number.isFinite(num) || num < 0) continue

    result[key.slice(prefix.length)] = num
  }

  return result
}
