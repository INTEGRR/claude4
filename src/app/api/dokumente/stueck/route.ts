import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { STUECK_BYTES } from '@/modules/einkauf/dokument-modelle'
import { drive } from '@/modules/google/drive'

/**
 * Reiner Transport (0092): ein Stück (≤ 4 MiB) einer Datei an Google Drive
 * weiterreichen. Vercel lässt keine größeren Anfragen durch, deshalb lädt
 * der Browser in Stücken über KRNL; die Google-Sitzungsadresse verlässt den
 * Server nie (nur die Sitzungs-ID). Geschrieben wird hier NICHTS — den
 * Index legt erst die Registry-Aktion einkauf.dokument_registrieren an,
 * nachdem sie die fertige Datei bei Google geprüft hat.
 */
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canWrite(user.role, 'einkauf', user.befugnisse)) {
    return NextResponse.json({ error: 'Hochladen braucht Schreibrechte im Einkauf' }, { status: 401 })
  }
  const url = new URL(request.url)
  const sitzung = url.searchParams.get('sitzung') ?? ''
  const start = Number(url.searchParams.get('start') ?? NaN)
  if (!UUID.test(sitzung) || !Number.isInteger(start) || start < 0) {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }
  const [s] = await sql<{ session_uri: string; groesse: number; erstellt_von: string; abgeschlossen_am: string | null }[]>`
    select session_uri, groesse::float as groesse, erstellt_von, abgeschlossen_am::text as abgeschlossen_am
    from upload_sitzungen where id = ${sitzung}`
  if (!s || s.erstellt_von !== user.name) {
    return NextResponse.json({ error: 'Upload-Sitzung nicht gefunden' }, { status: 404 })
  }
  if (s.abgeschlossen_am) return NextResponse.json({ error: 'Upload ist schon abgeschlossen' }, { status: 409 })

  const bytes = new Uint8Array(await request.arrayBuffer())
  const letztes = start + bytes.byteLength >= s.groesse
  if (bytes.byteLength === 0 || bytes.byteLength > STUECK_BYTES || (!letztes && bytes.byteLength % (256 * 1024) !== 0)) {
    return NextResponse.json({ error: 'Stückgröße ungültig' }, { status: 400 })
  }
  try {
    const api = await drive()
    const r = await api.uploadStueck(s.session_uri, bytes, start, s.groesse)
    return NextResponse.json(r.fertig ? { fertig: true, drive_file_id: r.datei?.id } : { fertig: false, weiter_ab: r.weiterAb })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload fehlgeschlagen' }, { status: 502 })
  }
}
