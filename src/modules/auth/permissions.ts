/**
 * Rollen- und Bereichsmatrix. Bewusst ohne 'server-only' und ohne
 * Datenbankzugriff, damit Sidebar (Server) und Tests sie gleichermaßen
 * nutzen können.
 *
 * Zuschnitt: Lager- und Fertigungsmitarbeiter sehen nur ihre eigenen
 * Bereiche plus den Scanner; Produkte nur lesend (keine Einkaufspreise,
 * keine Anlage). 'mitarbeiter' ist die Büro-Rolle: alles außer Verwaltung.
 */

export type Role = 'admin' | 'mitarbeiter' | 'lager' | 'fertigung'

export type Area =
  | 'verkauf'
  | 'einkauf'
  | 'fertigung'
  | 'lager'
  | 'versand'
  | 'reparatur'
  | 'produkte'
  | 'kontakte'
  | 'auswertungen'
  | 'ki'
  | 'scanner'
  | 'integrationen'
  | 'einstellungen'

const ALL_AREAS: Area[] = [
  'verkauf', 'einkauf', 'fertigung', 'lager', 'versand', 'reparatur',
  'produkte', 'kontakte', 'auswertungen', 'ki', 'scanner',
  'integrationen', 'einstellungen',
]

/** Bereiche, in denen die Rolle arbeiten (schreiben) darf. */
const WRITE_AREAS: Record<Role, Area[]> = {
  admin: ALL_AREAS,
  mitarbeiter: ALL_AREAS.filter((a) => a !== 'integrationen' && a !== 'einstellungen'),
  lager: ['lager', 'versand', 'reparatur', 'scanner'],
  fertigung: ['fertigung', 'reparatur', 'scanner'],
}

/** Bereiche, die die Rolle zusätzlich nur lesend sieht. */
const READ_AREAS: Record<Role, Area[]> = {
  admin: [],
  mitarbeiter: [],
  lager: ['produkte'],
  fertigung: ['produkte'],
}

export function canAccess(role: Role, area: Area): boolean {
  return WRITE_AREAS[role].includes(area) || READ_AREAS[role].includes(area)
}

export function canWrite(role: Role, area: Area): boolean {
  return WRITE_AREAS[role].includes(area)
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  mitarbeiter: 'Mitarbeiter (Büro)',
  lager: 'Lagermitarbeiter',
  fertigung: 'Fertigungsmitarbeiter',
}

export const ALL_ROLES = Object.keys(ROLE_LABELS) as Role[]
