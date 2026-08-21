import { z } from 'zod'
import type { RegistrierteAktion } from './registry/typen.ts'
import { alleAktionen } from './registry/index.ts'
import { JOB_KATALOG } from './jobs-katalog.ts'
import { EREIGNISSE } from './ereignisse.ts'

/**
 * Selbstauskunft der Registry — speist die Repository-Seite (/prozesse) und
 * GET /api/aktion. Bewusst datenbankfrei; die Feldableitung ist hier nur so
 * tief, wie es die Übersicht braucht (die vollwertige, formulartaugliche
 * Ableitung kommt mit der Maskengenerierung in Phase 4).
 */

export interface FeldInfo {
  name: string
  pflicht: boolean
  beschreibung?: string
}

/** Innerste Typ-Schale eines zod-Feldes freilegen (Optional/Default/Effects). */
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

export function aktionsFelder(aktion: RegistrierteAktion): FeldInfo[] {
  const objekt = kern(aktion.schema)
  if (!(objekt instanceof z.ZodObject)) return []
  return Object.entries(objekt.shape as Record<string, z.ZodTypeAny>).map(([name, feld]) => ({
    name,
    pflicht: !(feld instanceof z.ZodOptional) && !(feld instanceof z.ZodDefault),
    beschreibung: feld.description,
  }))
}

/**
 * Registry-Aktionen, die der KI-Agent vorschlagen darf (`ki: true`) — in der
 * Form, die `aktionenTool()` in den Werkzeugkatalog mischt. Lebt hier (nicht
 * in ki/aktionen.ts), weil die Registry die KI-Produktanlage importiert —
 * andersherum entstünde ein Importkreis.
 */
export function kiKatalog(): {
  name: string
  label: string
  beschreibung: string
  beleg: boolean
  felder: string
}[] {
  return alleAktionen()
    .filter(([, a]) => a.ki)
    .map(([name, a]) => ({
      name,
      label: a.label,
      beschreibung: a.beschreibung,
      beleg: a.bindung === 'beleg',
      felder: aktionsFelder(a)
        .map((f) => (f.pflicht ? f.name : `${f.name}?`))
        .join(', '),
    }))
}

/** Der komplette Katalog als schlichte Datenstruktur (für Seite und API). */
export function repository() {
  return {
    aktionen: alleAktionen().map(([name, a]) => ({
      name,
      label: a.label,
      bereich: a.bereich,
      beschreibung: a.beschreibung,
      bindung: a.bindung,
      modell: a.modell ?? null,
      uebergang: a.uebergang ?? null,
      nurAdmin: a.nurAdmin ?? false,
      prozessfrei: a.prozessfrei ?? false,
      felder: aktionsFelder(a),
    })),
    jobs: Object.entries(JOB_KATALOG).map(([kind, j]) => ({ kind, ...j })),
    ereignisse: Object.entries(EREIGNISSE).map(([topic, e]) => ({ topic, ...e })),
  }
}
