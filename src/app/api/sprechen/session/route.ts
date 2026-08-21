import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { ROLE_LABELS, canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { clientSecretErstellen, sprechenKonfiguriert, } from '@/modules/ki/sprechen'
import {
  aufnahmeInstructions,
  aufnahmeWerkzeuge,
  sprechenInstructions,
  sprechenWerkzeuge,
} from '@/modules/ki/sprechen-katalog'
import { datenfrageKonfiguriert } from '@/modules/ki/datenfrage'
import { aufnahmeKonfiguriert } from '@/modules/ki/prozess-aufnahme'

/**
 * Startet eine Sprachsitzung: legt den Protokollkopf an und mintet den
 * kurzlebigen Realtime-Client-Secret. Das Audio läuft danach direkt
 * Browser ↔ OpenAI (WebRTC) — dieser Server sieht nur Werkzeug-Aufrufe.
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) {
    return NextResponse.json({ error: 'Nicht berechtigt' }, { status: 401 })
  }
  if (!sprechenKonfiguriert()) {
    return NextResponse.json({ error: 'Sprachmodus nicht konfiguriert (OPENAI_API_KEY)' }, { status: 503 })
  }

  // Aufnahme-Modus (Prozess-Interview beim Kunden): Entwürfe legt nur der
  // Admin an (prozess_entwerfen ist nurAdmin), und die Strukturierung
  // braucht den Anthropic-Schlüssel.
  const body = (await request.json().catch(() => ({}))) as { modus?: unknown }
  const aufnahme = body.modus === 'aufnahme'
  if (aufnahme && user.role !== 'admin') {
    return NextResponse.json(
      { error: 'Die Prozess-Aufnahme ist Administratoren vorbehalten' },
      { status: 403 },
    )
  }
  if (aufnahme && !aufnahmeKonfiguriert()) {
    return NextResponse.json(
      { error: 'Prozess-Aufnahme nicht konfiguriert (ANTHROPIC_API_KEY)' },
      { status: 503 },
    )
  }

  const [company] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`
  const firma = company?.name ?? 'KRNL'

  try {
    // Die Datenfrage läuft über ein kleines Anthropic-Modell — ohne
    // ANTHROPIC_API_KEY bekommt die Session das Werkzeug gar nicht erst.
    const mitDatenfrage = datenfrageKonfiguriert()
    const secret = await clientSecretErstellen({
      instructions: aufnahme
        ? aufnahmeInstructions({ name: user.name }, firma)
        : sprechenInstructions(
            { name: user.name, rolle: ROLE_LABELS[user.role] },
            firma,
            mitDatenfrage,
          ),
      tools: aufnahme ? aufnahmeWerkzeuge() : sprechenWerkzeuge(mitDatenfrage),
    })
    const [protokoll] = await sql<{ id: string }[]>`
      insert into sprachprotokolle (user_id, modell)
      values (${user.id}, ${secret.modell}) returning id`
    return NextResponse.json({
      client_secret: secret.wert,
      protokoll_id: protokoll.id,
      modell: secret.modell,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sitzungsstart fehlgeschlagen' },
      { status: 502 },
    )
  }
}
