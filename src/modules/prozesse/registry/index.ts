import type { RegistrierteAktion } from './typen.ts'
import { AUFGABEN } from './aufgaben.ts'
import { AUSWERTUNGEN } from './auswertungen.ts'
import { EINKAUF } from './einkauf.ts'
import { EINKAUF_DOKUMENTE } from './einkauf-dokumente.ts'
import { EINKAUF_POSTFACH } from './einkauf-postfach.ts'
import { EINKAUF_MAILVERSAND } from './einkauf-mailversand.ts'
import { EINKAUF_PROJEKTE } from './einkauf-projekte.ts'
import { EINKAUF_BEMUSTERUNG } from './einkauf-bemusterung.ts'
import { EINKAUF_WERKZEUGE } from './einkauf-werkzeuge.ts'
import { EINKAUF_VERTRAEGE } from './einkauf-vertraege.ts'
import { EINKAUF_SENDUNGEN } from './einkauf-sendungen.ts'
import { EINKAUF_KI } from './einkauf-ki.ts'
import { EINSTELLUNGEN } from './einstellungen.ts'
import { FEHLER } from './fehler.ts'
import { FERTIGUNG } from './fertigung.ts'
import { FINANZEN } from './finanzen.ts'
import { INTEGRATIONEN } from './integrationen.ts'
import { KONTAKTE } from './kontakte.ts'
import { LAGER } from './lager.ts'
import { NOTIZEN } from './notizen.ts'
import { PERSONAL } from './personal.ts'
import { PRODUKTE } from './produkte.ts'
import { REPARATUR } from './reparatur.ts'
import { VERKAUF } from './verkauf.ts'
import { VERKAUF_SHOP } from './verkauf-shop.ts'
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
  ...AUFGABEN,
  ...AUSWERTUNGEN,
  ...EINKAUF,
  ...EINKAUF_DOKUMENTE,
  ...EINKAUF_POSTFACH,
  ...EINKAUF_MAILVERSAND,
  ...EINKAUF_PROJEKTE,
  ...EINKAUF_BEMUSTERUNG,
  ...EINKAUF_WERKZEUGE,
  ...EINKAUF_VERTRAEGE,
  ...EINKAUF_SENDUNGEN,
  ...EINKAUF_KI,
  ...EINSTELLUNGEN,
  ...FEHLER,
  ...FERTIGUNG,
  ...FINANZEN,
  ...INTEGRATIONEN,
  ...KONTAKTE,
  ...LAGER,
  ...NOTIZEN,
  ...PERSONAL,
  ...PRODUKTE,
  ...REPARATUR,
  ...VERKAUF,
  ...VERKAUF_SHOP,
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
