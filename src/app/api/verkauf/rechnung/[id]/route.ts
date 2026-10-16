import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { rechnungPdf } from '@/modules/verkauf/rechnung-pdf'

/**
 * Kundenrechnung, Gutschrift oder Mahnung als PDF (0115) — gerendert beim
 * Abruf aus dem Beleg (die Beträge sind Schnappschüsse, das PDF ist deshalb
 * jederzeit reproduzierbar). `?art=mahnung` rendert das Mahnschreiben der
 * aktuellen Mahnstufe.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  const { id } = await params
  const art = new URL(request.url).searchParams.get('art') === 'mahnung' ? 'mahnung' : 'beleg'
  try {
    const { bytes, dateiname } = await rechnungPdf(id, art)
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
