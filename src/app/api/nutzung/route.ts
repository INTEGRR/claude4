import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'

/**
 * Lern-Gedächtnis, Seiten-Seite: das Befehlsfeld meldet geöffnete Seiten
 * (Aktionen zählt der Torwächter serverseitig selbst). Nur 'seite' ist
 * erlaubt — Aktionszähler lassen sich hier nicht künstlich hochtreiben.
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as { schluessel?: unknown } | null
  const schluessel = typeof body?.schluessel === 'string' ? body.schluessel.slice(0, 120) : ''
  if (!schluessel.startsWith('/')) {
    return NextResponse.json({ error: 'Ungültiger Schlüssel' }, { status: 400 })
  }
  await sql`select nutzung_zaehlen(${user.id}, 'seite', ${schluessel})`.catch(() => undefined)
  return NextResponse.json({ ok: true })
}
