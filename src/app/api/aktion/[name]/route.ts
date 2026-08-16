import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { sql } from '@/db/client'
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
  let instanz: { id: string; schritt: string } | undefined
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as {
        parameter?: unknown
        record_id?: unknown
        instanz_id?: unknown
        schritt?: unknown
      }
      aufruf = {
        parameter: body.parameter,
        recordId: typeof body.record_id === 'string' ? body.record_id : undefined,
      }
      if (typeof body.instanz_id === 'string' && typeof body.schritt === 'string') {
        instanz = { id: body.instanz_id, schritt: body.schritt }
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
    // Belegloser Assistent: der Aufruf gehört zu einer laufenden Instanz.
    // Vor der Ausführung prüfen, dass der Schritt gerade ANGEBOTEN wird und
    // wirklich zu dieser Aktion gehört — danach schaltet die Instanz weiter.
    let prozessCode: string | undefined
    if (instanz) {
      const [kopf] = await sql<{ code: string }[]>`
        select p.code from prozess_instanzen i
        join prozesse p on p.id = i.prozess_id
        where i.id = ${instanz.id} and i.status = 'laufend'`
      if (!kopf) {
        return NextResponse.json(
          { error: 'Der Assistent läuft nicht mehr.' },
          { status: 400 },
        )
      }
      prozessCode = kopf.code
      const angeboten = await sql<{ code: string; aktion: string | null }[]>`
        select code, aktion from prozess_naechste_schritte(${prozessCode}, ${instanz.id})`
      const schritt = angeboten.find((s) => s.code === instanz!.schritt)
      if (!schritt) {
        return NextResponse.json(
          { error: `Schritt „${instanz.schritt}" wird gerade nicht angeboten.` },
          { status: 400 },
        )
      }
      if (schritt.aktion !== name) {
        return NextResponse.json(
          { error: 'Der Schritt gehört zu einer anderen Aktion.' },
          { status: 400 },
        )
      }

      // Beleggebundener FOLGESCHRITT im Assistenten: ohne explizite record_id
      // ist der jüngste von einem Vorschritt erzeugte Beleg der Bezug
      // (daten->>'beleg_id' — z. B. Zählung erfassen → Differenz buchen).
      if (!aufruf.recordId && registrierteAktion(name)?.bindung === 'beleg') {
        const [daten] = await sql<{ beleg_id: string | null }[]>`
          select daten->>'beleg_id' as beleg_id from prozess_instanzen where id = ${instanz.id}`
        if (daten?.beleg_id) aufruf.recordId = daten.beleg_id
      }
    }

    const ergebnis = await aktionAusfuehrenGeprueft(name, aufruf, user)

    if (instanz) {
      await sql`select prozess_instanz_weiter(
        ${instanz.id}, ${instanz.schritt},
        ${sql.json({
          [`${instanz.schritt}_record_id`]: ergebnis.recordId ?? null,
          ...(ergebnis.recordId ? { beleg_id: ergebnis.recordId } : {}),
        })},
        ${user.name})`
    }

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
