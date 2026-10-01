import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { etikettFormat, positionenAusParameter } from '@/modules/druck/etikett-layout'
import { artikeletiketten } from '@/modules/druck/etiketten'

/**
 * Artikel-Etiketten als PDF im Browser — der Weg ohne Etikettendrucker am
 * Arbeitsplatz (lager.artikeletikett_drucken liefert diesen Link). Je
 * Position `anzahl` Seiten, Standardformat 100 × 50 mm; Anzahl und Summe
 * sind begrenzt (positionenAusParameter), ein fremder Link druckt keine
 * 10.000 Seiten. Lesen genügt: die Daten sind Produktstammdaten.
 *
 *   GET /api/etikett/artikel?pos=<uuid>:<anzahl>,<uuid>:<anzahl>,…
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!canAccess(user.rollen, 'produkte', user.befugnisse)) {
    return NextResponse.json({ error: 'Kein Zugriff auf die Produkte' }, { status: 403 })
  }

  const positionen = positionenAusParameter(new URL(request.url).searchParams.get('pos'))
  if (positionen.length === 0) {
    return NextResponse.json({ error: 'Keine Varianten angegeben' }, { status: 400 })
  }

  let pdf: Buffer
  try {
    pdf = await artikeletiketten(positionen, etikettFormat(null, null))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
  }
  const summe = positionen.reduce((a, p) => a + p.anzahl, 0)
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="artikeletiketten-${summe}.pdf"`,
    },
  })
}
