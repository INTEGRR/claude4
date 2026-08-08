import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'

/**
 * Liefert das gespeicherte DHL-Label aus (DHL hält es nur ~3 Tage vor).
 *
 * Erste Quelle ist die Datenbank; die Datei-Ablage bleibt als Rückfallebene
 * für Sendungen aus der Zeit vor Migration 0025 erhalten.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }

  const { id } = await params
  const [shipment] = await sql<
    { label_path: string | null; label_pdf: Uint8Array | null; shipment_number: string }[]
  >`select label_path, label_pdf, shipment_number from shipments where id = ${id}`

  if (!shipment) {
    return NextResponse.json({ error: 'Sendung nicht gefunden' }, { status: 404 })
  }

  const kopf = (daten: Uint8Array) =>
    new NextResponse(daten as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${shipment.shipment_number}.pdf"`,
      },
    })

  if (shipment.label_pdf) return kopf(new Uint8Array(shipment.label_pdf))

  if (!shipment.label_path) {
    return NextResponse.json({ error: 'Kein Label gespeichert' }, { status: 404 })
  }

  // Pfadprüfung: nur Dateien aus dem Ablageverzeichnis herausgeben. Die Pfade
  // stehen erst zur Laufzeit fest — der Bundler kann sie nicht auflösen und
  // soll es auch nicht versuchen.
  const root = path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_DIR ?? path.join(process.cwd(), 'storage'))
  const file = path.resolve(/* turbopackIgnore: true */ process.cwd(), shipment.label_path)
  if (!file.startsWith(root + path.sep)) {
    return NextResponse.json({ error: 'Ungültiger Pfad' }, { status: 400 })
  }

  try {
    const data = await readFile(file)
    return kopf(new Uint8Array(data))
  } catch {
    return NextResponse.json({ error: 'Label-Datei nicht gefunden' }, { status: 404 })
  }
}
