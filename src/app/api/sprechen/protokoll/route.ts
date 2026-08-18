import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'

/**
 * Transkript-Einträge der Sprachsession (gepuffert vom Client) und das
 * Sitzungsende. sendBeacon-tauglich: kleine JSON-Bodies, keine Antwortdaten.
 * Der Client darf nur nutzer-/assistent-Zeilen schreiben — Werkzeug-Einträge
 * schreibt ausschließlich der Server (werkzeug-Route).
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) {
    return NextResponse.json({ error: 'Nicht berechtigt' }, { status: 401 })
  }

  let protokollId: string
  let eintraege: { rolle: string; text: string }[] = []
  let beendet = false
  try {
    const body = (await request.json()) as {
      protokoll_id?: unknown
      eintraege?: unknown
      beendet?: unknown
    }
    if (typeof body.protokoll_id !== 'string') throw new Error()
    protokollId = body.protokoll_id
    if (Array.isArray(body.eintraege)) {
      eintraege = body.eintraege
        .filter(
          (e): e is { rolle: string; text: string } =>
            !!e &&
            typeof e === 'object' &&
            typeof (e as { rolle?: unknown }).rolle === 'string' &&
            typeof (e as { text?: unknown }).text === 'string',
        )
        .filter((e) => (e.rolle === 'nutzer' || e.rolle === 'assistent') && e.text.trim() !== '')
        .slice(0, 100)
    }
    beendet = body.beendet === true
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  const [eigenes] = await sql<{ id: string }[]>`
    select id from sprachprotokolle where id = ${protokollId} and user_id = ${user.id}`
  if (!eigenes) return NextResponse.json({ error: 'Unbekanntes Protokoll' }, { status: 404 })

  for (const e of eintraege) {
    await sql`
      insert into sprachprotokoll_eintraege (protokoll_id, rolle, text)
      values (${protokollId}, ${e.rolle}, ${e.text.slice(0, 4000)})`
  }
  if (beendet) {
    await sql`update sprachprotokolle set beendet_am = coalesce(beendet_am, now())
              where id = ${protokollId}`
  }
  return NextResponse.json({ ok: true })
}
