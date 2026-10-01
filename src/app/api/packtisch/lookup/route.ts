import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canWrite } from '@/modules/auth/permissions'
import { packtischBelegLaden } from '@/modules/versand/packtisch-beleg'

export type { PacktischDoc, PacktischZeile } from '@/modules/versand/packtisch-beleg'

/**
 * Packtisch-Lookup (lesend) — die Auflösung selbst lebt in
 * versand/packtisch-beleg.ts und wird auch vom einen Scanfeld genutzt.
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user || !canWrite(user.rollen, 'versand', user.befugnisse)) {
    return NextResponse.json({ error: 'Der Packtisch braucht Schreibrechte im Versand' }, {
      status: 401,
    })
  }
  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })
  const r = await packtischBelegLaden(code)
  return r.ok ? NextResponse.json(r.doc) : NextResponse.json({ error: r.error }, { status: r.status })
}
