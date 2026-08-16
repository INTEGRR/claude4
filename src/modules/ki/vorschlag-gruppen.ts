/**
 * Gruppierung von Aktionsvorschlägen für die Sammel-Bestätigung im Chat.
 *
 * Schlägt der Agent viele gleichartige Datensätze in einer Antwort vor
 * (16 Meldebestände, 5 Bestellbestätigungen), soll der Benutzer keine 16
 * Karten einzeln abnicken, sondern EINE Tabelle sehen: eine Zeile je
 * Vorschlag, Zellen editierbar, ein Knopf für alle. Dieses Modul entscheidet
 * nur, WAS zusammengehört — gerendert wird im Chat.
 *
 * Zur Tabelle taugt ein Vorschlag nur mit flachem Feldsatz (Skalare). Wer
 * Verschachteltes mitbringt (Produkt mit Attributmatrix, Auftrag mit
 * Positionen), bleibt eine eigene Karte mit dem vollen Editor.
 */

export interface GruppierbarerVorschlag {
  id: string
  aktion: string
  parameter: Record<string, unknown>
}

/** Nur Skalare (und null) — dann passt der Feldsatz in eine Tabellenzeile. */
export function istFlach(parameter: Record<string, unknown>): boolean {
  return Object.values(parameter).every((v) => v === null || typeof v !== 'object')
}

/**
 * Aufeinanderfolgende Vorschläge derselben Aktion mit flachen Feldern werden
 * eine Gruppe; alles andere bleibt allein. Die Reihenfolge der Antwort bleibt
 * erhalten — der Chat rendert Gruppen ≥ 2 als Sammeltabelle.
 */
export function gruppiereVorschlaege<V extends GruppierbarerVorschlag>(vorschlaege: V[]): V[][] {
  const gruppen: V[][] = []
  for (const v of vorschlaege) {
    const letzte = gruppen.at(-1)
    if (letzte && letzte[0].aktion === v.aktion && istFlach(v.parameter) && letzte.every((e) => istFlach(e.parameter))) {
      letzte.push(v)
    } else {
      gruppen.push([v])
    }
  }
  return gruppen
}

/** Spalten der Sammeltabelle: Vereinigung der Feldnamen, Reihenfolge des ersten Auftretens. */
export function gruppenSpalten(vorschlaege: GruppierbarerVorschlag[]): string[] {
  const spalten: string[] = []
  for (const v of vorschlaege) {
    for (const name of Object.keys(v.parameter)) {
      if (!spalten.includes(name)) spalten.push(name)
    }
  }
  return spalten
}
