import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { repository } from '@/modules/prozesse/introspektion'

/**
 * GET /api/aktion — das Repository der Knöpfe als Maschinenauskunft:
 * alle registrierten Aktionen (mit Feldern, Bereich, Übergang), Jobs und
 * Ereignisse. Grundlage für externe Testwerkzeuge und den Prozesstest.
 */
export async function GET() {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  return NextResponse.json(repository())
}
