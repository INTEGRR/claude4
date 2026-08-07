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

export interface LotEntry {
  name: string
  qty: number
}

/**
 * Los-/Serieneingabe aus einem Textfeld:
 *  - Serie:  "SN-001, SN-002, SN-003"          (je Menge 1)
 *  - Los:    "CHARGE-A:10, CHARGE-B:2,5"       (NAME:MENGE, Komma dezimal ok)
 * Leere Eingabe => leere Liste (dann greift die automatische Zuteilung).
 */
export function parseLotSpec(value: string, tracking: 'lot' | 'serial'): LotEntry[] {
  const teile = value.split(',').map((t) => t.trim()).filter(Boolean)

  if (tracking === 'serial') {
    return teile.map((name) => ({ name, qty: 1 }))
  }

  // Los: NAME:MENGE — Vorsicht mit Dezimalkomma: erst an ":" trennen,
  // dann gehört ein rein numerischer Folgeteil ("5") zur Menge davor.
  const entries: LotEntry[] = []
  for (const teil of teile) {
    const doppelpunkt = teil.lastIndexOf(':')
    if (doppelpunkt === -1) {
      if (/^\d+$/.test(teil) && entries.length > 0) {
        // Nachkommateil eines Dezimalkommas: "CHARGE:2,5"
        const prev = entries[entries.length - 1]
        prev.qty = Number(`${prev.qty}.${teil}`)
        continue
      }
      throw new Error(`Losangabe "${teil}" braucht das Format NAME:MENGE`)
    }
    const name = teil.slice(0, doppelpunkt).trim()
    const qty = Number(teil.slice(doppelpunkt + 1).replace(',', '.'))
    if (!name || !Number.isFinite(qty) || qty <= 0) {
      throw new Error(`Losangabe "${teil}" braucht das Format NAME:MENGE`)
    }
    entries.push({ name, qty })
  }
  return entries
}
