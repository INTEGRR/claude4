import 'server-only'

import type { RealtimeWerkzeug } from './sprechen-katalog'

/**
 * Anbindung des Echtzeit-Sprachmodus (/sprechen) an die OpenAI Realtime API.
 * Der Server mintet nur den kurzlebigen Client Secret — das Audio läuft
 * danach direkt Browser ↔ OpenAI über WebRTC, Vercel ist unbeteiligt.
 * Ohne OPENAI_API_KEY ist der Sprachmodus aus (Seite zeigt den Hinweis,
 * Sidebar-Eintrag erscheint nicht).
 */

const MODELL = process.env.SPRECHEN_MODELL ?? 'gpt-realtime-2.1'
const STIMME = process.env.SPRECHEN_STIMME ?? 'marin'
// Pflichtfeld der Realtime-API fürs Nutzer-Transkript — dasselbe Modell wie
// die Diktierfunktion, sofern nicht eigens übersteuert.
const TRANSKRIPTION =
  process.env.SPRECHEN_TRANSKRIPTION ?? process.env.TRANSKRIPTION_MODELL ?? 'whisper-1'

export function sprechenKonfiguriert(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

export function sprechenModell(): string {
  return MODELL
}

export async function clientSecretErstellen(opts: {
  instructions: string
  tools: RealtimeWerkzeug[]
}): Promise<{ wert: string; modell: string }> {
  const session: Record<string, unknown> = {
    type: 'realtime',
    model: MODELL,
    instructions: opts.instructions,
    tools: opts.tools,
    audio: {
      output: { voice: STIMME },
      input: { transcription: { model: TRANSKRIPTION, language: 'de' } },
    },
    // Kostenbremse: niedriger Denkaufwand ist für Voice-Agents empfohlen —
    // schnellere Antworten, deutlich weniger Tokens je Runde.
    reasoning: { effort: 'low' },
  }

  const minten = async (body: Record<string, unknown>) =>
    fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: body }),
    })

  let res = await minten(session)
  if (res.status === 400) {
    // Nicht jede Modell-/API-Kombination kennt das reasoning-Feld — dann
    // ohne die Bremse neu minten statt den Sprachmodus zu brechen.
    const detail = await res.text().catch(() => '')
    if (/reasoning/i.test(detail)) {
      const { reasoning: _weg, ...ohne } = session
      res = await minten(ohne)
    } else {
      throw new Error(`Realtime-Session abgelehnt (400)${fehlertext(detail)}`)
    }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Realtime-Session abgelehnt (${res.status})${fehlertext(detail)}`)
  }
  const daten = (await res.json()) as { value?: string; client_secret?: { value?: string } }
  // GA liefert { value }, ältere Stände { client_secret: { value } } — beides annehmen.
  const wert = daten.value ?? daten.client_secret?.value
  if (!wert) throw new Error('Realtime-Session ohne Client Secret beantwortet')
  return { wert, modell: MODELL }
}

function fehlertext(detail: string): string {
  let meldung = detail.slice(0, 300)
  try {
    const geparst = JSON.parse(detail) as { error?: { message?: string } }
    if (geparst.error?.message) meldung = geparst.error.message
  } catch {
    // kein JSON — der gekürzte Rohtext bleibt
  }
  return meldung ? `: ${meldung}` : ''
}
