import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { bestaetigteAktionAusfuehren } from '@/modules/ki/aktion-bestaetigt'
import { AktionsFehler, RechteFehler } from '@/modules/prozesse/torwaechter'

/**
 * Führt eine vom Agenten vorgeschlagene Aktion aus — aber erst, wenn der
 * Benutzer im Chat bestätigt hat.
 *
 * Der Vorschlag aus dem Stream ist hier ausdrücklich **kein** Freibrief:
 * der komplette Weg läuft über den Torwächter — Schema, Rechte (inkl.
 * nurAdmin), Ausführung, Audit. Ein Fertigungsmitarbeiter kann sich also
 * auch über die KI keinen Kunden anlegen.
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

  try {
    const ergebnis = await bestaetigteAktionAusfuehren(name, parameter, user)
    return NextResponse.json(ergebnis)
  } catch (err) {
    if (err instanceof RechteFehler) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    if (err instanceof AktionsFehler) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    return NextResponse.json({ error: meldung }, { status: 400 })
  }
}
