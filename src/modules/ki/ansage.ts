import 'server-only'

import { ANSAGEN, type AnsageSchluessel } from '../scanner-ansagen.ts'

/**
 * Sprachansagen des Scanfelds über die OpenAI-Sprachausgabe (/v1/audio/speech)
 * — dieselbe Stimme wie der Sprachmodus (SPRECHEN_STIMME, Standard „marin";
 * die gibt es nur mit gpt-4o-mini-tts). Feste Sätze aus dem Katalog, je
 * Server-Instanz einmal erzeugt und im Speicher gehalten; der Browser
 * speichert sie zusätzlich. Ohne OPENAI_API_KEY oder mit KI_FAKE=1 gibt es
 * keine Stimme — das Scanfeld piept dann wie bisher.
 */

const MODELL = process.env.ANSAGE_MODELL ?? 'gpt-4o-mini-tts'
const STIMME = process.env.SPRECHEN_STIMME ?? 'marin'
const ANWEISUNG =
  'Deutsch, kurz und klar wie eine Ansage an einem Arbeitsplatz im Lager. ' +
  'Freundlich, zügig, ohne Pausen am Anfang.'

const zwischenspeicher = new Map<AnsageSchluessel, ArrayBuffer>()

export function ansageKonfiguriert(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && process.env.KI_FAKE !== '1'
}

export async function ansageAudio(schluessel: AnsageSchluessel): Promise<ArrayBuffer | null> {
  if (!ansageKonfiguriert()) return null
  const vorhanden = zwischenspeicher.get(schluessel)
  if (vorhanden) return vorhanden

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODELL,
      voice: STIMME,
      input: ANSAGEN[schluessel],
      instructions: ANWEISUNG,
      response_format: 'mp3',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Sprachausgabe antwortet mit ${res.status}: ${detail.slice(0, 200)}`)
  }
  const audio = await res.arrayBuffer()
  zwischenspeicher.set(schluessel, audio)
  return audio
}
