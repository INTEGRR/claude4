import type { z } from 'zod'
import { type Role, canWrite } from '../auth/permissions.ts'
import { type AktionsErgebnis, type RegistrierteAktion, UUID_MUSTER } from './registry/typen.ts'
import { REGISTRY, registrierteAktion } from './registry/index.ts'

/**
 * Der Torwächter — die eine Wahrheit vor jeder Ausführung.
 *
 * Server Actions und die HTTP-Route /api/aktion sind nur Transporte; geprüft
 * und ausgeführt wird ausschließlich hier: Aktion bekannt → Eingabe gegen
 * das Schema → Rolle darf → ausführen → Audit-Eintrag. Das Muster stammt
 * aus /api/ki/aktion und wird hier fürs ganze Haus verallgemeinert.
 *
 * Fehlerarten sind bewusst getrennt: AktionsFehler = fachlich/Eingabe
 * (HTTP 400, ActionResult {error}); RechteFehler = Rolle darf nicht (403).
 */

export class AktionsFehler extends Error {}
export class RechteFehler extends AktionsFehler {}

export interface AktionsAufruf {
  parameter?: unknown
  formData?: FormData
  recordId?: string
}

/**
 * Prüfung ohne Ausführung — bewusst datenbankfrei, damit sie unter blankem
 * Node testbar ist (und der Prozesstest sie direkt verwenden kann).
 */
export function aktionPruefen(
  name: string,
  aufruf: AktionsAufruf,
): { aktion: RegistrierteAktion; werte: Record<string, unknown>; recordId?: string } {
  const aktion = registrierteAktion(name)
  if (!aktion) {
    throw new AktionsFehler(
      `Unbekannte Aktion „${name}". Registriert sind: ${Object.keys(REGISTRY).join(', ')}`,
    )
  }

  if (aktion.bindung === 'beleg') {
    if (!aufruf.recordId || !UUID_MUSTER.test(aufruf.recordId)) {
      throw new AktionsFehler(`„${aktion.label}" braucht die ID des betroffenen Datensatzes.`)
    }
  }

  let parameter: unknown
  if (aufruf.formData) {
    if (!aktion.formdata) {
      throw new AktionsFehler(
        `„${name}" nimmt keine Formulardaten an — bitte die Felder als JSON senden.`,
      )
    }
    parameter = aktion.formdata(aufruf.formData)
  } else {
    parameter = aufruf.parameter ?? {}
  }

  const ergebnis = aktion.schema.safeParse(parameter)
  if (!ergebnis.success) {
    const meldungen = ergebnis.error.issues
      .map((i: z.ZodIssue) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`)
      .join('; ')
    throw new AktionsFehler(meldungen)
  }

  return { aktion, werte: ergebnis.data as Record<string, unknown>, recordId: aufruf.recordId }
}

/** Rechteprüfung als eigene, pure Funktion — je Rolle testbar. */
export function aktionErlaubt(aktion: RegistrierteAktion, role: Role): boolean {
  if (aktion.nurAdmin) return role === 'admin'
  return canWrite(role, aktion.bereich)
}

/**
 * Prüfen, berechtigen, ausführen, protokollieren — der einzige Weg, auf dem
 * eine Registry-Aktion tatsächlich läuft.
 */
export async function aktionAusfuehrenGeprueft(
  name: string,
  aufruf: AktionsAufruf,
  nutzer: { name: string; role: Role },
): Promise<AktionsErgebnis> {
  const { aktion, werte, recordId } = aktionPruefen(name, aufruf)

  if (!aktionErlaubt(aktion, nutzer.role)) {
    throw new RechteFehler(
      aktion.nurAdmin
        ? `„${aktion.label}" ist Administratoren vorbehalten`
        : `Ihrer Rolle fehlt die Berechtigung für „${aktion.label}"`,
    )
  }

  // Erst hier kommen Datenbank-Importe ins Spiel — die Prüfung oben bleibt frei davon.
  const { AUSFUEHRUNG } = await import('./ausfuehren.ts')
  const { sql } = await import('@/db/client')

  let ergebnis: AktionsErgebnis
  try {
    const fn = AUSFUEHRUNG[name as keyof typeof AUSFUEHRUNG]
    ergebnis =
      (await fn(werte as never, { actor: nutzer.name, role: nutzer.role, recordId })) ?? {}
  } catch (err) {
    // Fachliche Fehler aus den SQL-Funktionen (raise exception) verständlich
    // weiterreichen — das Präfix des Treibers interessiert niemanden.
    const roh = err instanceof Error ? err.message : String(err)
    throw new AktionsFehler(roh.replace(/^error: /, ''))
  }

  // Audit: jeder ausgeführte Registry-Aufruf hinterlässt eine Spur — dieselbe
  // Ereignisleiste, die auch die Statusübergänge bespielen. Nie blockierend.
  const zusammenfassung = aktion.zusammenfassung?.(werte as never)
  await sql`select log_event('aktion', gen_random_uuid(), 'state',
    ${`${name}${zusammenfassung ? ` — ${zusammenfassung}` : ''}${recordId ? ` [${recordId}]` : ''}`},
    ${nutzer.name})`.catch(() => undefined)

  return ergebnis
}
