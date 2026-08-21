import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { aufnahmeKonfiguriert, aufnahmeStrukturieren } from '@/modules/ki/prozess-aufnahme'

/**
 * Prozessaufnahme aus getippten Antworten — der Weg des Einrichtungs-
 * Assistenten (Schritt „Aufnehmen"). Das Sprach-Interview in der Werkstatt
 * nutzt dieselbe Strukturierung, nur mit einem gesprochenen Transkript.
 *
 * Warum eine Route und keine Server Action: die Strukturierung ruft ein
 * Sprachmodell und dauert; sie endet ohnehin in
 * `einstellungen.prozess_entwerfen` — also IM Torwächter, mit Rechteprüfung
 * und Protokoll. Hier steht nur der Zuschnitt des Transkripts.
 */

export const maxDuration = 300

export async function POST(request: Request) {
  const user = await currentUser()
  // prozess_entwerfen ist nurAdmin — dieselbe Schwelle gilt für den Weg dahin.
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
  let titel: string
  try {
    const body = (await request.json()) as { runden?: unknown; titel?: unknown }
    if (!Array.isArray(body.runden) || body.runden.length === 0) throw new Error()
    paare = body.runden.slice(0, 20).map((r) => {
      const runde = r as { frage?: unknown; antwort?: unknown }
      if (typeof runde.frage !== 'string' || typeof runde.antwort !== 'string') throw new Error()
      return { frage: runde.frage.slice(0, 500), antwort: runde.antwort.slice(0, 8000) }
    })
    titel = typeof body.titel === 'string' && body.titel.trim()
      ? body.titel.trim().slice(0, 120)
      : 'Ablauf aus der Ersteinrichtung'
  } catch {
    return NextResponse.json({ error: 'Ungültige Anfrage' }, { status: 400 })
  }

  // Gleiche Form wie ein gesprochenes Interview: Frage/Antwort im Wechsel.
  const transkript = paare
    .map((p) => `Assistent: ${p.frage}\nNutzer: ${p.antwort}`)
    .join('\n\n')

  const ergebnis = await aufnahmeStrukturieren(transkript, titel, user)
  return NextResponse.json(ergebnis)
}
