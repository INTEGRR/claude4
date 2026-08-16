import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { aktionPruefen } from '@/modules/ki/aktionen'
import { aktionAusfuehren } from '@/modules/ki/aktionen-ausfuehren'
import { sql } from '@/db/client'

/**
 * Führt eine vom Agenten vorgeschlagene Aktion aus — aber erst, wenn der
 * Benutzer im Chat bestätigt hat.
 *
 * Der Vorschlag aus dem Stream ist hier ausdrücklich **kein** Freibrief: Name
 * und Felder werden erneut geprüft, und die Rolle muss im Zielbereich
 * schreiben dürfen. Ein Fertigungsmitarbeiter kann sich also auch über die KI
 * keinen Kunden anlegen.
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  let name: string
  let parameter: unknown
  try {
    const body = (await request.json()) as { aktion?: unknown; parameter?: unknown }
    if (typeof body.aktion !== 'string') throw new Error()
    name = body.aktion
    parameter = body.parameter
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  // Registry-Aktion (namespaced, z. B. verkauf.bestaetigen): kompletter Weg
  // über den Torwächter — Schema, Rechte (inkl. nurAdmin), Ausführung, Audit.
  // Die record_id reiste im Parameter mit (siehe agent.ts).
  if (name.includes('.')) {
    const p = (parameter && typeof parameter === 'object' ? parameter : {}) as Record<
      string,
      unknown
    >
    const { record_id, ...rest } = p
    try {
      const { AktionsFehler, RechteFehler, aktionAusfuehrenGeprueft } = await import(
        '@/modules/prozesse/torwaechter'
      )
      try {
        const ergebnis = await aktionAusfuehrenGeprueft(
          name,
          { parameter: rest, recordId: typeof record_id === 'string' ? record_id : undefined },
          user,
        )
        await sql`select log_event('ki', gen_random_uuid(), 'state',
          ${`Aktion ausgeführt: ${name}`}, ${user.name})`
        return NextResponse.json({
          text: ergebnis.text ?? 'Ausgeführt.',
          ...(ergebnis.link ? { link: ergebnis.link } : {}),
        })
      } catch (err) {
        if (err instanceof RechteFehler) {
          return NextResponse.json({ error: err.message }, { status: 403 })
        }
        if (err instanceof AktionsFehler) {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    } catch (err) {
      const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
      return NextResponse.json({ error: meldung }, { status: 400 })
    }
  }

  let geprueft: ReturnType<typeof aktionPruefen>
  try {
    geprueft = aktionPruefen(name, parameter)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Aktion abgelehnt' },
      { status: 400 },
    )
  }

  const { name: aktionName, aktion, werte } = geprueft
  if (!canWrite(user.role, aktion.bereich)) {
    return NextResponse.json(
      { error: `Ihrer Rolle fehlt die Berechtigung für „${aktion.label}"` },
      { status: 403 },
    )
  }

  try {
    const ergebnis = await aktionAusfuehren(aktionName, werte, user.name)
    await sql`select log_event('ki', gen_random_uuid(), 'state',
      ${`Aktion ausgeführt: ${aktionName} — ${aktion.zusammenfassung(werte)}`}, ${user.name})`
    return NextResponse.json(ergebnis)
  } catch (err) {
    const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    return NextResponse.json({ error: meldung }, { status: 400 })
  }
}
