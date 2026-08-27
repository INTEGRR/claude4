import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'

/**
 * Label über die LIEFERUNG finden: die Packtisch-Liste kennt nur die
 * Lieferung, nicht die Sendung — „Label vorhanden" soll trotzdem direkt
 * das PDF öffnen. Aufgelöst wird die jüngste nicht stornierte Sendung
 * mit Label; ausgeliefert wird über die bestehende Sendungs-Route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pickingId: string }> },
) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const { pickingId } = await params
  const [shipment] = await sql<{ id: string }[]>`
    select id from shipments
    where picking_id = ${pickingId} and state <> 'cancelled'
      and (label_pdf is not null or label_path is not null)
    order by created_at desc limit 1`

  if (!shipment) {
    return NextResponse.json({ error: 'Kein Label zu dieser Lieferung' }, { status: 404 })
  }
  return NextResponse.redirect(
    new URL(`/api/label/${shipment.id}`, _request.url),
  )
}
