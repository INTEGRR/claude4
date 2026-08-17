import 'server-only'

/**
 * Diktat → Text über Whisper (OpenAI Audio API) statt der Browser-eigenen
 * Spracherkennung: Die Web Speech API rät je nach Browser und schickt Audio
 * an wechselnde Dienste — Whisper transkribiert deterministisch gut und
 * versteht Fachvokabular. Der Browser nimmt nur noch auf (MediaRecorder),
 * transkribiert wird serverseitig über diese Kapselung.
 *
 * Ohne OPENAI_API_KEY ist die Spracheingabe aus — die Mikrofon-Knöpfe
 * erscheinen dann gar nicht erst (GET /api/transkription meldet es).
 */

const MODELL = process.env.TRANSKRIPTION_MODELL ?? 'whisper-1'

export function transkriptionKonfiguriert(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

export async function transkribieren(audio: File): Promise<string> {
  const form = new FormData()
  form.append('file', audio, audio.name)
  form.append('model', MODELL)
  form.append('language', 'de')
  form.append('response_format', 'json')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
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
    throw new Error(`Whisper antwortet mit ${res.status}${meldung ? `: ${meldung}` : ''}`)
  }
  const daten = (await res.json()) as { text?: string }
  return (daten.text ?? '').trim()
}
