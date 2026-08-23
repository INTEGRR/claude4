import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { interviewRunde } from '@/modules/ki/interview'
import { aufnahmeKonfiguriert } from '@/modules/ki/prozess-aufnahme'

/**
 * Eine Runde des geführten Aufnahme-Interviews (Ersteinrichtung, Schritt 03):
 * die bisherigen Frage/Antwort-Paare rein, die nächste Frage (mit
 * Klick-Optionen) raus. Entworfen wird hier NICHTS — der Abschluss läuft
 * weiter über POST /api/aufnahme → prozess_entwerfen im Torwächter.
 */

export const maxDuration = 60

export async function POST(request: Request) {
  const user = await currentUser()
  // prozess_entwerfen ist nurAdmin — dieselbe Schwelle gilt fürs Interview.
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Nicht berechtigt' }, { status: 401 })
  }
  if (!aufnahmeKonfiguriert()) {
    return NextResponse.json(
      { error: 'Die Prozessaufnahme ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).' },
      { status: 503 },
    )
  }

  let paare: { frage: string; antwort: string }[]
  try {
    const body = (await request.json()) as { runden?: unknown }
    if (!Array.isArray(body.runden) || body.runden.length === 0) throw new Error()
    paare = body.runden.slice(0, 20).map((r) => {
      const runde = r as { frage?: unknown; antwort?: unknown }
      if (typeof runde.frage !== 'string' || typeof runde.antwort !== 'string') throw new Error()
      return { frage: runde.frage.slice(0, 600), antwort: runde.antwort.slice(0, 8000) }
    })
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  const [firma] = await sql<{ name: string | null }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  try {
    const ergebnis = await interviewRunde(paare, firma?.name ?? 'eure Firma')
    return NextResponse.json(ergebnis)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'KI nicht erreichbar' },
      { status: 502 },
    )
  }
}
