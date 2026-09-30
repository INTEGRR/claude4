import { currentUser } from '@/modules/auth'
import { googleFake } from '@/modules/google/auth'

/**
 * Nur mit GOOGLE_FAKE=1 (lokal, Staging) und nur für Admins: liefert eine
 * Mail in das Attrappen-Postfach ein — so lässt sich der Posteingang ohne
 * echtes Gmail durchspielen (Browsertest, Vorführung). Schreibt nichts in
 * die Datenbank; übernommen wird sie wie jede Mail vom Abgleich.
 */
export async function POST(request: Request) {
  const user = await currentUser()
  if (!googleFake() || user?.role !== 'admin') return new Response('Nicht gefunden', { status: 404 })
  const m = (await request.json()) as {
    threadId?: string
    von: string
    an?: string
    betreff: string
    text?: string
    html?: string
    labels?: string[]
    anhaenge?: { name: string; mime: string; base64: string }[]
  }
  const { fakeMailEinliefern } = await import('@/modules/google/google-fake-gmail')
  const r = fakeMailEinliefern({
    ...m,
    anhaenge: (m.anhaenge ?? []).map((a) => ({ name: a.name, mime: a.mime, bytes: Buffer.from(a.base64, 'base64') })),
  })
  return Response.json(r)
}
