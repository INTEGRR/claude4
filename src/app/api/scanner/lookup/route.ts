import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { canAccess, canWrite } from '@/modules/auth/permissions'
import { scanBelegLaden } from '@/modules/scanner-beleg'

export type { ScannerAntwort, ScannerDoc, ScannerLine } from '@/modules/scanner-beleg'

/**
 * Lookup des einen Scanfelds (lesend). Die Zuordnung „Nummer → Ablauf"
 * lebt in modules/scanner-beleg.ts (dort auch getestet).
 */
export async function GET(request: Request) {
  const user = await currentUser()
  if (!user || !canAccess(user.rollen, 'scanner')) {
    return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  }
  const code = new URL(request.url).searchParams.get('code')?.trim()
  if (!code) return NextResponse.json({ error: 'Kein Code' }, { status: 400 })
  const r = await scanBelegLaden(code, {
    picking: canWrite(user.rollen, 'lager'),
    mo: canWrite(user.rollen, 'fertigung'),
    versand: canWrite(user.rollen, 'versand', user.befugnisse),
  })
  return r.ok ? NextResponse.json(r.antwort) : NextResponse.json({ error: r.error }, { status: r.status })
}
