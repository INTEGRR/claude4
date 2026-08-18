import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { werkzeugAusfuehren } from '@/modules/ki/sprechen-werkzeuge'

// Reserve für die Datenfrage-Runde (Ausbaustufe 3) — die anderen Werkzeuge
// antworten in Millisekunden.
export const maxDuration = 60

/**
 * Function-Calls der Sprachsession: der Browser reicht sie vom Datachannel
 * durch, hier läuft die eigentliche Ausführung (Resolver, Sammeln, Suche) —
 * mit Session-Cookie, Rechteprüfung und serverseitigem Protokolleintrag.
 * Fehler kommen als output-TEXT zurück (kein 4xx), damit das Sprachmodell
 * sie vorlesen kann und der Dialog weiterläuft.
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) {
    return NextResponse.json({ error: 'Nicht berechtigt' }, { status: 401 })
  }

  let name: string
  let argumente: unknown
  let protokollId: string | null = null
  try {
    const body = (await request.json()) as {
      name?: unknown
      argumente?: unknown
      protokoll_id?: unknown
    }
    if (typeof body.name !== 'string') throw new Error()
    name = body.name
    argumente = body.argumente
    if (typeof body.protokoll_id === 'string') protokollId = body.protokoll_id
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  // Fremde Protokolle sind tabu — dann läuft der Aufruf ohne Protokollbezug
  // (und vorgang_sammeln lehnt mangels Sitzung ab).
  if (protokollId) {
    const [eigenes] = await sql<{ id: string }[]>`
      select id from sprachprotokolle where id = ${protokollId} and user_id = ${user.id}`
    if (!eigenes) protokollId = null
  }

  const ergebnis = await werkzeugAusfuehren(name, argumente, user, protokollId)
  return NextResponse.json(ergebnis)
}
