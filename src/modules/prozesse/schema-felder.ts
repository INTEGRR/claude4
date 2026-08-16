import { z } from 'zod'
import type { RegistrierteAktion } from './registry/typen.ts'

/**
 * Formulartaugliche Feldableitung aus den zod-Schemas der Registry — das
 * Herz der Maskengenerierung: eine Aktion beschreibt ihre Eingaben genau
 * einmal (im Schema), die Maske fällt daraus ab. Bewusst datenbankfrei;
 * Auswahllisten für Verweisfelder (partner_id, variant_id, …) löst die
 * Server-Komponente auf, die das Formular einbettet.
 */

export type FeldTyp =
  | 'text'
  | 'mehrzeilig'
  | 'nummer'
  | 'schalter'
  | 'auswahl'
  | 'verweis'
  | 'datum'
  | 'json'

export interface FormularFeld {
  name: string
  label: string
  typ: FeldTyp
  pflicht: boolean
  /** Vorgabewert aus zod (.default) — nicht zu verwechseln mit Schritt-params. */
  vorgabe?: unknown
  /** Werte einer Enum-Auswahl. */
  auswahl?: string[]
  /** Für typ 'verweis': welcher Stammdatenbestand (aus dem Feldnamen abgeleitet). */
  quelle?: string
  hinweis?: string
}

/** Innerste Typ-Schale freilegen (Optional/Default/Nullable/Effects). */
function kern(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodNullable) {
      s = s._def.innerType as z.ZodTypeAny
    } else if (s instanceof z.ZodEffects) {
      s = s._def.schema as z.ZodTypeAny
    } else {
      return s
    }
  }
}

/** `partner_id` → `partners` usw. — die Quelle einer Verweis-Auswahl. */
const VERWEIS_QUELLEN: Record<string, string> = {
  partner_id: 'partners',
  variant_id: 'product_variants',
  user_id: 'users',
}

function beschriftung(name: string): string {
  const TEXTE: Record<string, string> = {
    partner_id: 'Kunde/Partner',
    variant_id: 'Produkt',
    user_id: 'Verantwortlich',
    qty: 'Menge',
    note: 'Vermerk',
    titel: 'Titel',
    beschreibung: 'Beschreibung',
    status: 'Status',
    aufloesung: 'Vermerk zum Abschluss',
    commit_sha: 'Commit (SHA)',
    under_warranty: 'Garantie',
    part_type: 'Art',
    schwere: 'Schwere',
    seite: 'Seite',
  }
  if (TEXTE[name]) return TEXTE[name]
  const roh = name.replace(/_id$/, '').replace(/_/g, ' ')
  return roh.charAt(0).toUpperCase() + roh.slice(1)
}

function feldTyp(name: string, s: z.ZodTypeAny): Pick<FormularFeld, 'typ' | 'auswahl' | 'quelle'> {
  if (VERWEIS_QUELLEN[name]) return { typ: 'verweis', quelle: VERWEIS_QUELLEN[name] }
  if (s instanceof z.ZodEnum) return { typ: 'auswahl', auswahl: [...(s.options as string[])] }
  if (s instanceof z.ZodBoolean) return { typ: 'schalter' }
  if (s instanceof z.ZodNumber) return { typ: 'nummer' }
  if (s instanceof z.ZodString) {
    const max = (s._def.checks as { kind: string; value?: number }[]).find(
      (c) => c.kind === 'max',
    )?.value
    return { typ: max !== undefined && max >= 1000 ? 'mehrzeilig' : 'text' }
  }
  // Records/Objekte/Arrays: generisch nur als JSON erfassbar (z. B. die
  // Ist-Mengen beim Reparaturabschluss — dafür bleibt die Fachmaske da).
  return { typ: 'json' }
}

export function formularFelder(aktion: RegistrierteAktion): FormularFeld[] {
  const objekt = kern(aktion.schema)
  if (!(objekt instanceof z.ZodObject)) return []

  return Object.entries(objekt.shape as Record<string, z.ZodTypeAny>).map(([name, roh]) => {
    const innen = kern(roh)
    const vorgabe =
      roh instanceof z.ZodDefault
        ? (roh._def.defaultValue as () => unknown)()
        : undefined
    return {
      name,
      label: roh.description ?? beschriftung(name),
      pflicht: !(roh instanceof z.ZodOptional) && !(roh instanceof z.ZodDefault),
      ...(vorgabe !== undefined ? { vorgabe } : {}),
      hinweis: roh.description,
      ...feldTyp(name, innen),
    }
  })
}
