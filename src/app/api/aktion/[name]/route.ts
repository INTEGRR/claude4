import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { registrierteAktion } from '@/modules/prozesse/registry'
import { aktionsFelder } from '@/modules/prozesse/introspektion'
import {
  AktionsFehler,
  RechteFehler,
  aktionAusfuehrenGeprueft,
} from '@/modules/prozesse/torwaechter'

/**
 * Der eine schreibende HTTP-Endpunkt: Knopfdruck als API-Aufruf.
 *
 *   POST /api/aktion/lager.transfer_stornieren
 *   { "record_id": "…" }                        — oder FormData mit record_id
 *
 * Antwortformat entspricht dem ActionResult der Oberfläche: {info, link}
 * bei Erfolg, {error} bei fachlichen Fehlern (400), 403 bei fehlender
 * Berechtigung. Generierte Masken und der Prozesstest sprechen genau diesen
 * Endpunkt — die Server Actions sind nur ein zweiter Transport über
 * denselben Torwächter.
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  const { name } = await params

  let aufruf: { parameter?: unknown; formData?: FormData; recordId?: string }
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { parameter?: unknown; record_id?: unknown }
      aufruf = {
        parameter: body.parameter,
        recordId: typeof body.record_id === 'string' ? body.record_id : undefined,
      }
    } else {
      const formData = await request.formData()
      const recordId = formData.get('record_id')
      aufruf = { formData, recordId: typeof recordId === 'string' ? recordId : undefined }
    }
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  try {
    const ergebnis = await aktionAusfuehrenGeprueft(name, aufruf, user)
    return NextResponse.json({
      ...(ergebnis.text ? { info: ergebnis.text } : {}),
      ...(ergebnis.link ? { link: ergebnis.link } : {}),
      ...(ergebnis.recordId ? { record_id: ergebnis.recordId } : {}),
    })
  } catch (err) {
    if (err instanceof RechteFehler) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    if (err instanceof AktionsFehler) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }
}

/** GET /api/aktion/<name> — Selbstauskunft einer einzelnen Aktion. */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  const { name } = await params
  const aktion = registrierteAktion(name)
  if (!aktion) return NextResponse.json({ error: 'Unbekannte Aktion' }, { status: 404 })
  return NextResponse.json({
    name,
    label: aktion.label,
    bereich: aktion.bereich,
    beschreibung: aktion.beschreibung,
    bindung: aktion.bindung,
    modell: aktion.modell ?? null,
    uebergang: aktion.uebergang ?? null,
    felder: aktionsFelder(aktion),
  })
}
