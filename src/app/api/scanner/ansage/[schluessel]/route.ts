import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { ansageAudio } from '@/modules/ki/ansage'
import { istAnsage } from '@/modules/scanner-ansagen'

/**
 * Eine Sprachansage des Scanfelds als MP3 — nur Sätze aus dem festen
 * Katalog (modules/scanner-ansagen.ts), nur für Angemeldete mit Zugang zum
 * Scanner. 204 = keine Stimme konfiguriert (das Scanfeld piept dann).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ schluessel: string }> }) {
  const user = await currentUser()
  if (!user || !canAccess(user.rollen, 'scanner')) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  const { schluessel } = await ctx.params
  if (!istAnsage(schluessel)) return NextResponse.json({ error: 'Unbekannte Ansage' }, { status: 404 })
  try {
    const audio = await ansageAudio(schluessel)
    if (!audio) return new Response(null, { status: 204 })
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        // Der Satz ändert sich nur mit ANSAGE_STAND (steht in der Abruf-URL).
        'Cache-Control': 'private, max-age=2592000, immutable',
      },
    })
  } catch (err) {
    console.error('[ansage]', err)
    return new Response(null, { status: 204 })
  }
}
