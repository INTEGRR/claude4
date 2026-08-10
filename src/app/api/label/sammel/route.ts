import { NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'

/**
 * Sammel-PDF für den Massendruck: die Labels der übergebenen Sendungen in
 * einem Dokument, ein Druckauftrag fürs ganze Fließband.
 *
 *   GET /api/label/sammel?ids=<uuid>,<uuid>,…
 */
export async function GET(request: Request) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100)
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Keine Sendungen angegeben' }, { status: 400 })
  }

  const shipments = await sql<
    { id: string; shipment_number: string; label_pdf: Uint8Array | null }[]
  >`select id, shipment_number, label_pdf from shipments where id = any(${ids})`

  // Reihenfolge der Anfrage beibehalten — sie entspricht der Packliste.
  const sortiert = ids
    .map((id) => shipments.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.label_pdf))
  if (sortiert.length === 0) {
    return NextResponse.json({ error: 'Keines der Labels ist gespeichert' }, { status: 404 })
  }

  const sammel = await PDFDocument.create()
  for (const s of sortiert) {
    const teil = await PDFDocument.load(new Uint8Array(s.label_pdf!))
    const seiten = await sammel.copyPages(teil, teil.getPageIndices())
    for (const seite of seiten) sammel.addPage(seite)
  }

  const bytes = await sammel.save()
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="labels-${sortiert.length}.pdf"`,
    },
  })
}
