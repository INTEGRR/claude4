import { currentUser } from '@/modules/auth'
import { googleFake } from '@/modules/google/auth'

/**
 * Nur mit GOOGLE_FAKE=1 (lokal, Staging): gibt eine Datei der Drive-
 * Attrappe aus — das Gegenstück zu „In Drive öffnen". Ohne Attrappe 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!googleFake() || !(await currentUser())) return new Response('Nicht gefunden', { status: 404 })
  const { id } = await params
  const { fakeDatei } = await import('@/modules/google/google-fake')
  const d = fakeDatei(id)
  if (!d) return new Response('Nicht gefunden', { status: 404 })
  return new Response(new Uint8Array(d.bytes), {
    headers: {
      'content-type': d.mimeType,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    },
  })
}
