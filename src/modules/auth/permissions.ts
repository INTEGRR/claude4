/**
 * Rollen- und Bereichsmatrix. Bewusst ohne 'server-only' und ohne
 * Datenbankzugriff, damit Sidebar (Server) und Tests sie gleichermaßen
 * nutzen können.
 *
 * Zuschnitt: Lager- und Fertigungsmitarbeiter sehen nur ihre eigenen
 * Bereiche plus Scanner und Zeiterfassung; Produkte nur lesend (keine
 * Einkaufspreise, keine Anlage). 'mitarbeiter' ist die Büro-Rolle: alles
 * außer Verwaltung.
 *
 * 'personal' und 'zeiterfassung' sind bewusst getrennt: an der Stempeluhr
 * darf jeder stehen, an den Personalstammdaten (Kostensätze, Urlaubstage,
 * Genehmigungen) nur das Büro.
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
  | 'personal'
  | 'zeiterfassung'
  | 'integrationen'
  | 'einstellungen'

const ALL_AREAS: Area[] = [
  'verkauf', 'einkauf', 'fertigung', 'lager', 'versand', 'reparatur',
  'produkte', 'kontakte', 'auswertungen', 'ki', 'scanner',
  'personal', 'zeiterfassung', 'integrationen', 'einstellungen',
]

/** Bereiche, in denen die Rolle arbeiten (schreiben) darf. */
const WRITE_AREAS: Record<Role, Area[]> = {
  admin: ALL_AREAS,
  mitarbeiter: ALL_AREAS.filter((a) => a !== 'integrationen' && a !== 'einstellungen'),
  lager: ['lager', 'versand', 'reparatur', 'scanner', 'zeiterfassung'],
  fertigung: ['fertigung', 'reparatur', 'scanner', 'zeiterfassung'],
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
