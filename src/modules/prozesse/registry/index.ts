import type { RegistrierteAktion } from './typen.ts'
import { AUSWERTUNGEN } from './auswertungen.ts'
import { EINKAUF } from './einkauf.ts'
import { EINSTELLUNGEN } from './einstellungen.ts'
import { FEHLER } from './fehler.ts'
import { FERTIGUNG } from './fertigung.ts'
import { INTEGRATIONEN } from './integrationen.ts'
import { KONTAKTE } from './kontakte.ts'
import { LAGER } from './lager.ts'
import { PERSONAL } from './personal.ts'
import { PRODUKTE } from './produkte.ts'
import { REPARATUR } from './reparatur.ts'
import { VERKAUF } from './verkauf.ts'
import { VERSAND } from './versand.ts'
import { VORGANG } from './vorgang.ts'

/**
 * Das Repository der Knöpfe: alle registrierten Aktionen des Hauses.
 *
 * Je Modul eine Katalogdatei; hierüber wächst der Bestand, bis alle 135
 * Server Actions registriert sind (Reihenfolge laut Plan: fehler → lager →
 * reparatur → produkte/kontakte/personal → verkauf/versand →
 * einkauf/fertigung → einstellungen/integrationen).
 */
export const REGISTRY = {
  ...AUSWERTUNGEN,
  ...EINKAUF,
  ...EINSTELLUNGEN,
  ...FEHLER,
  ...FERTIGUNG,
  ...INTEGRATIONEN,
  ...KONTAKTE,
  ...LAGER,
  ...PERSONAL,
  ...PRODUKTE,
  ...REPARATUR,
  ...VERKAUF,
  ...VERSAND,
  ...VORGANG,
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
