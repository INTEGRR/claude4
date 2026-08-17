import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { transkribieren, transkriptionKonfiguriert } from '@/modules/ki/transkription'

/**
 * Spracheingabe: Der Mikrofon-Knopf lädt seine Aufnahme hier hoch und
 * bekommt den transkribierten Text zurück (Whisper, de). GET verrät nur, ob
 * der Dienst konfiguriert ist — daran entscheiden die Knöpfe, ob sie
 * erscheinen.
 */

// Aufnahmen sind kurz (Auto-Stopp im Knopf); alles darüber ist kein Diktat.
const MAX_BYTES = 8 * 1024 * 1024

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  return NextResponse.json({ verfuegbar: transkriptionKonfiguriert() })
}

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (!transkriptionKonfiguriert()) {
    return NextResponse.json({ error: 'Die Spracheingabe ist nicht konfiguriert' }, { status: 400 })
  }

  let audio: File
  try {
    const form = await request.formData()
    const feld = form.get('audio')
    if (!(feld instanceof File) || feld.size === 0) throw new Error()
    audio = feld
  } catch {
    return NextResponse.json({ error: 'Keine Aufnahme übermittelt' }, { status: 400 })
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Die Aufnahme ist zu lang' }, { status: 413 })
  }

  try {
    const text = await transkribieren(audio)
    if (!text) {
      return NextResponse.json({ error: 'Nichts verstanden — bitte noch einmal' }, { status: 422 })
    }
    return NextResponse.json({ text })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Transkription fehlgeschlagen' },
      { status: 502 },
    )
  }
}
