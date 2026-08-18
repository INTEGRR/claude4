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
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: MODELL,
        instructions: opts.instructions,
        tools: opts.tools,
        audio: {
          output: { voice: STIMME },
          input: { transcription: { model: TRANSKRIPTION, language: 'de' } },
        },
      },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    let meldung = detail.slice(0, 300)
    try {
      const geparst = JSON.parse(detail) as { error?: { message?: string } }
      if (geparst.error?.message) meldung = geparst.error.message
    } catch {
      // kein JSON — der gekürzte Rohtext bleibt
    }
    throw new Error(`Realtime-Session abgelehnt (${res.status})${meldung ? `: ${meldung}` : ''}`)
  }
  const daten = (await res.json()) as { value?: string; client_secret?: { value?: string } }
  // GA liefert { value }, ältere Stände { client_secret: { value } } — beides annehmen.
  const wert = daten.value ?? daten.client_secret?.value
  if (!wert) throw new Error('Realtime-Session ohne Client Secret beantwortet')
  return { wert, modell: MODELL }
}
