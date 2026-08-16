import type { RegistrierteAktion } from './typen.ts'
import { EINSTELLUNGEN } from './einstellungen.ts'
import { FEHLER } from './fehler.ts'
import { LAGER } from './lager.ts'
import { PRODUKTE } from './produkte.ts'
import { REPARATUR } from './reparatur.ts'
import { VERKAUF } from './verkauf.ts'
import { VERSAND } from './versand.ts'

/**
 * Das Repository der Knöpfe: alle registrierten Aktionen des Hauses.
 *
 * Je Modul eine Katalogdatei; hierüber wächst der Bestand, bis alle 135
 * Server Actions registriert sind (Reihenfolge laut Plan: fehler → lager →
 * reparatur → produkte/kontakte/personal → verkauf/versand →
 * einkauf/fertigung → einstellungen/integrationen).
 */
export const REGISTRY = {
  ...EINSTELLUNGEN,
  ...FEHLER,
  ...LAGER,
  ...PRODUKTE,
  ...REPARATUR,
  ...VERKAUF,
  ...VERSAND,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>

export type AktionsName = keyof typeof REGISTRY

export function registrierteAktion(name: string): RegistrierteAktion | undefined {
  return (REGISTRY as Record<string, RegistrierteAktion>)[name]
}

/**
 * Alle Einträge mit dem weiten Interface-Typ — `satisfies` erhält die engen
 * Literaltypen je Eintrag, was beim Iterieren über optionale Felder stört.
 */
export function alleAktionen(): [string, RegistrierteAktion][] {
  return Object.entries(REGISTRY as Record<string, RegistrierteAktion>)
}
