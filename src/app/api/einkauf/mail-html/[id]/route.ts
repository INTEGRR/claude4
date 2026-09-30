import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * HTML einer Mail (0093) für die Originaldarstellung im Thread — nur
 * lesend. Ausgeliefert als text/plain: direkt aufgerufen rendert der
 * Browser nichts, gezeigt wird es erst im abgeschotteten iframe
 * (components/mail-html.tsx: sandbox ohne Skripte, CSP ohne Fremdbilder).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user || !canAccess(user.rollen, 'einkauf', user.befugnisse)) return new Response('Nicht gefunden', { status: 404 })
  const { id } = await params
  if (!UUID.test(id)) return new Response('Nicht gefunden', { status: 404 })
  const [n] = await sql<{ html: string | null }[]>`select html from mail_nachrichten where id = ${id}`
  if (!n?.html) return new Response('Nicht gefunden', { status: 404 })
  return new Response(n.html, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
  })
}
