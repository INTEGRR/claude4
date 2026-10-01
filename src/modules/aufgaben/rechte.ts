/**
 * Wer darf eine Aufgabe abhaken oder verwerfen (0104)? Rein rechnend — die
 * Ausführung prüft damit, die Oberfläche blendet damit Knöpfe ein, beide
 * sagen also dasselbe.
 *
 * Abhaken: der Zuständige, jedes Mitglied des zuständigen Teams, wer sie
 * angelegt hat, und das Büro (Admin, Büro-Rolle). Verwerfen: wer sie
 * angelegt hat, und das Büro.
 */
export interface AufgabeRechteSicht {
  zustaendig_id: string | null
  rolle: string | null
  erstellt_von_id: string | null
}

export interface NutzerSicht {
  id?: string
  rollen: readonly string[]
}

export const istBuero = (n: NutzerSicht) => n.rollen.some((r) => r === 'admin' || r === 'mitarbeiter')

export function darfAbhaken(a: AufgabeRechteSicht, n: NutzerSicht): boolean {
  return (
    istBuero(n) ||
    (n.id !== undefined && (a.zustaendig_id === n.id || a.erstellt_von_id === n.id)) ||
    (a.zustaendig_id === null && a.rolle !== null && n.rollen.includes(a.rolle))
  )
}

export function darfVerwerfen(a: AufgabeRechteSicht, n: NutzerSicht): boolean {
  return istBuero(n) || (n.id !== undefined && a.erstellt_von_id === n.id)
}
