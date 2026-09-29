import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { druckbrueckeKonfig } from '@/modules/versand/druckbruecke'
import { druckbrueckePaket, oeffentlicheAdresse, skriptSicher, zielWert } from '@/modules/versand/druckbruecke-paket'
import { zipErstellen } from '@/modules/shared/zip'

/**
 * GET /api/druck/paket?name=…&ziel=…&drucker=… — das Druckbrücken-Paket
 * für einen Arbeitsplatz-PC als ZIP: Agent, Startskript mit Adresse und
 * Token, Autostart, Anleitung. Nur für Administratoren, weil das Paket das
 * Agent-Token enthält; ohne aktive Druckbrücke gibt es nichts zu laden.
 *
 * Der Agent kommt unverändert aus scripts/druck-agent.ts (eine Quelle) —
 * next.config.ts nimmt die Datei per outputFileTracingIncludes in die
 * Funktion auf.
 */
export async function GET(request: Request) {
  const nutzer = await currentUser()
  if (!nutzer) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  if (nutzer.role !== 'admin') {
    return NextResponse.json({ error: 'Nur für Administratoren' }, { status: 403 })
  }

  const konfig = await druckbrueckeKonfig()
  if (konfig.modus !== 'bruecke' || !konfig.token) {
    return NextResponse.json(
      { error: 'Die Druckbrücke ist nicht aktiv — erst unter Einstellungen → Versand & Druck auf „Druckbrücke" stellen.' },
      { status: 409 },
    )
  }

  const anfrage = new URL(request.url)
  const name = skriptSicher(anfrage.searchParams.get('name') ?? '') || 'druck-pc'
  const agentQuelle = await readFile(path.join(process.cwd(), 'scripts', 'druck-agent.ts'), 'utf8')
  const erstellt = new Date()
  const zip = zipErstellen(
    druckbrueckePaket({
      url: oeffentlicheAdresse(process.env, request.headers, anfrage.origin),
      token: konfig.token,
      name,
      ziel: zielWert(anfrage.searchParams.get('ziel')),
      drucker: anfrage.searchParams.get('drucker') ?? '',
      agentQuelle,
      erstellt,
    }),
    erstellt,
  )
  const dateiname = `krnl-druckbruecke-${name.replace(/[^\w-]+/g, '-').toLowerCase()}.zip`
  return new Response(new Uint8Array(zip), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${dateiname}"`,
      'cache-control': 'no-store',
    },
  })
}
