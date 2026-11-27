import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { abverkaufStandGepuffert } from '@/modules/verkauf/abverkauf'
import { fensterAus } from '@/modules/verkauf/abverkauf-logik'

export const dynamic = 'force-dynamic'

/**
 * Live-Stand des Abverkaufs (0144): Ranking der Teile, Tempo, Auflagen.
 * Nur lesend, nur für Benutzer mit Zugriff auf den Verkauf; die Seite fragt
 * alle paar Sekunden nach.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'verkauf', user.befugnisse)) {
    return NextResponse.json({ error: 'Kein Zugriff auf den Verkauf' }, { status: 403 })
  }
  const url = new URL(request.url)
  const projekt = url.searchParams.get('projekt')?.trim() || null
  const stand = await abverkaufStandGepuffert(fensterAus(url.searchParams.get('fenster')), projekt)
  return NextResponse.json(stand, { headers: { 'cache-control': 'no-store' } })
}
