import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { reparaturPdf } from '@/modules/reparatur/auftrag-pdf'

/**
 * Reparaturauftrag bzw. -bericht als PDF (2026-10-16) — beim Abruf aus dem
 * Beleg gerendert, zum Drucken für Werkstatt und Kunde. Lesen genügt
 * (Bereich Reparatur), das Dokument ändert nichts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'reparatur', user.befugnisse)) {
    return NextResponse.json({ error: 'Kein Zugriff auf Reparaturen' }, { status: 403 })
  }
  const { id } = await params
  try {
    const { bytes, dateiname } = await reparaturPdf(id)
    return new NextResponse(new Uint8Array(bytes) as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${dateiname}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: message.includes('nicht gefunden') ? 404 : 500 })
  }
}
