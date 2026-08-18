import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { type ChatTurn, type KiEvent, kiConfigured, runAgent } from '@/modules/ki/agent'

/**
 * Streamt die Antwort des KI-Agenten als NDJSON (eine JSON-Zeile je
 * Ereignis: text | status | sql | error | done).
 */

export const maxDuration = 300

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  if (!kiConfigured()) {
    return NextResponse.json(
      { error: 'KI ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt)' },
      { status: 503 },
    )
  }

  let turns: ChatTurn[]
  try {
    const body = (await request.json()) as { messages?: unknown }
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error()
    turns = body.messages.slice(-30).map((m) => {
      const turn = m as { role?: unknown; text?: unknown }
      if ((turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.text !== 'string') {
        throw new Error()
      }
      return { role: turn.role, text: turn.text.slice(0, 8000) }
    })
    if (turns.at(-1)?.role !== 'user') throw new Error()
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (ev: KiEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'))
      try {
        await runAgent(turns, user.name, send, {
          finanzen: canAccess(user.role, 'finanzen', user.befugnisse),
        })
      } catch (err) {
        send({
          type: 'error',
          text: (err instanceof Error ? err.message : 'Unbekannter Fehler').slice(0, 500),
        })
        send({ type: 'done' })
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
