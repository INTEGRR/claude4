import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { etikettFormat } from '@/modules/druck/etikett-layout'
import { fertigungsetiketten } from '@/modules/druck/etiketten'
import { idOderNull } from '@/modules/druck/routing'

/**
 * Fertigungsetiketten als PDF im Browser — der Weg, wenn am Arbeitsplatz
 * kein Etikettendrucker eingerichtet ist (fertigung.etikett_drucken liefert
 * diesen Link). Standardformat 100 × 50 mm; über die Druckbrücke kommt
 * dasselbe Etikett im Format des Zieldruckers (modules/druck/abholen.ts).
 *
 *   GET /api/etikett/fertigung?ids=<uuid>,<uuid>,…
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'fertigung', user.befugnisse)) {
    return NextResponse.json({ error: 'Kein Zugriff auf die Fertigung' }, { status: 403 })
  }

  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => idOderNull(s))
    .filter((s): s is string => s !== null)
    .slice(0, 100)
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Keine Fertigungsaufträge angegeben' }, { status: 400 })
  }

  let pdf: Buffer
  try {
    pdf = await fertigungsetiketten(ids, etikettFormat(null, null))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="fertigungsetiketten-${ids.length}.pdf"`,
    },
  })
}
