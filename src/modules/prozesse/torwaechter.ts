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
 * Schritt-Rechte: verlangt ein Prozessschritt für diese Aktion Rollen oder
 * eine Befugnis, gilt das auf JEDEM Transportweg — auch für den direkten
 * Knopf auf der Belegseite, /api/aktion und den KI-Chat, nicht nur für die
 * Angebote im Prozess-Panel. Administratoren bestehen immer; Overrides
 * können die Anforderung je Firma ändern. Rein DB-gestützt, deshalb
 * getrennt von der puren Prüfung oben.
 */
async function schrittRechtePruefen(
  aktionsName: string,
  label: string,
  nutzer: { role: Role; befugnisse?: string[] },
): Promise<void> {
  if (nutzer.role === 'admin') return
  const { sql } = await import('@/db/client')
  const { BEFUGNISSE } = await import('../auth/permissions.ts')

  const schritte = await sql<
    { rollen: string[] | null; befugnis: string | null }[]
  >`
    select coalesce(o.rollen, s.rollen) as rollen,
           coalesce(o.befugnis, s.befugnis) as befugnis
    from prozesse p
    join prozess_schritte s on s.version_id = prozess_aktive_version(p.code)
    left join prozess_overrides o
      on o.prozess_code = p.code and o.schritt_code = s.code
    where p.aktiv and s.art = 'aktion' and s.aktion = ${aktionsName}
      and coalesce(o.aktiv, true)`

  // Aktion ist an keinen aktiven Schritt gebunden oder kein Schritt stellt
  // Anforderungen → die Bereichsmatrix bleibt die einzige Hürde.
  const mitAnforderung = schritte.filter(
    (s) => (s.rollen && s.rollen.length > 0) || s.befugnis,
  )
  if (mitAnforderung.length === 0) return

  const besteht = mitAnforderung.some(
    (s) =>
      (!s.rollen || s.rollen.length === 0 || s.rollen.includes(nutzer.role)) &&
      (!s.befugnis || (nutzer.befugnisse ?? []).includes(s.befugnis)),
  )
  if (!besteht) {
    const befugnis = mitAnforderung.find((s) => s.befugnis)?.befugnis
    const befugnisLabel =
      befugnis && befugnis in BEFUGNISSE
        ? (BEFUGNISSE as Record<string, string>)[befugnis]
        : befugnis
    throw new RechteFehler(
      befugnisLabel
        ? `„${label}" verlangt die Befugnis „${befugnisLabel}" — sie wird in der Benutzerverwaltung vergeben.`
        : `„${label}" ist im Prozess auf andere Rollen beschränkt.`,
    )
  }
}

/**
 * Prüfen, berechtigen, ausführen, protokollieren — der einzige Weg, auf dem
 * eine Registry-Aktion tatsächlich läuft.
 */
export async function aktionAusfuehrenGeprueft(
  name: string,
  aufruf: AktionsAufruf,
  nutzer: { name: string; role: Role; id?: string; befugnisse?: string[] },
): Promise<AktionsErgebnis> {
  const { aktion, werte, recordId } = aktionPruefen(name, aufruf)

  if (!aktionErlaubt(aktion, nutzer.role)) {
    throw new RechteFehler(
      aktion.nurAdmin
        ? `„${aktion.label}" ist Administratoren vorbehalten`
        : `Ihrer Rolle fehlt die Berechtigung für „${aktion.label}"`,
    )
  }

  await schrittRechtePruefen(name, aktion.label, nutzer)

  // Erst hier kommen Datenbank-Importe ins Spiel — die Prüfung oben bleibt frei davon.
  const { AUSFUEHRUNG } = await import('./ausfuehren.ts')
  const { sql } = await import('@/db/client')

  let ergebnis: AktionsErgebnis
  try {
    const fn = AUSFUEHRUNG[name as keyof typeof AUSFUEHRUNG]
    ergebnis =
      (await fn(werte as never, {
        actor: nutzer.name,
        role: nutzer.role,
        recordId,
        userId: nutzer.id,
      })) ?? {}
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

  // Lern-Gedächtnis: was dieser Benutzer oft ausführt, rückt auf der
  // Übersicht und im Befehlsfeld nach vorn. Nie blockierend.
  if (nutzer.id) {
    await sql`select nutzung_zaehlen(${nutzer.id}, 'aktion', ${name})`.catch(() => undefined)
  }

  return ergebnis
}
