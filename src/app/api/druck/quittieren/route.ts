import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { agentBerechtigt } from '@/modules/versand/druckbruecke'

/**
 * Quittung der Druckbrücke: der Agent meldet je Auftrag, ob das
 * Druckkommando durchlief (ok) oder woran es scheiterte (fehler) —
 * die Integrationen-Seite zählt die Fehlschläge.
 */

export async function POST(request: Request) {
  if (!(await agentBerechtigt(request))) {
    return NextResponse.json({ error: 'Kein gültiges Agent-Token' }, { status: 401 })
  }

  let body: { id?: string; ok?: boolean; fehler?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Kein JSON' }, { status: 400 })
  }
  if (!body.id || typeof body.ok !== 'boolean') {
    return NextResponse.json({ error: 'id und ok sind Pflicht' }, { status: 400 })
  }

  const result = body.ok
    ? await sql`update druckauftraege
        set status = 'gedruckt', gedruckt_am = now(), fehler = null
        where id = ${body.id} and status = 'offen'`
    : await sql`update druckauftraege
        set status = 'fehler', fehler = ${String(body.fehler ?? 'unbekannter Fehler').slice(0, 500)}
        where id = ${body.id} and status = 'offen'`

  if (result.count === 0) {
    return NextResponse.json({ error: 'Auftrag unbekannt oder bereits quittiert' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
