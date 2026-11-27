import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { montageStand } from '@/modules/fertigung/montage'

export const dynamic = 'force-dynamic'

/**
 * Live-Stand der Montage-Übersicht (0141): offene Fertigungsmengen als
 * Baum. Nur lesend, nur für Benutzer mit Zugriff auf die Fertigung; die
 * Seite fragt alle paar Sekunden nach.
 */
export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'fertigung', user.befugnisse)) {
    return NextResponse.json({ error: 'Kein Zugriff auf die Fertigung' }, { status: 403 })
  }
  return NextResponse.json(await montageStand(), { headers: { 'cache-control': 'no-store' } })
}
