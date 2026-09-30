import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { sql } from '@/db/client'
import { idOderNull } from '@/modules/druck/routing'
import { druckbrueckeKonfig } from '@/modules/versand/druckbruecke'
import { druckbrueckePaket, oeffentlicheAdresse, skriptSicher, zielWert } from '@/modules/versand/druckbruecke-paket'
import { zipErstellen } from '@/modules/shared/zip'

/**
 * GET /api/druck/paket?drucker_id=… — das Druckbrücken-Paket für EINEN
 * Drucker (0087) als ZIP: Agent, Startskript mit Adresse, Token,
 * Drucker-ID und Windows-Druckername, Autostart, Anleitung. Ohne
 * drucker_id das Alt-Paket je PC (?name=…&ziel=…&drucker=…). Nur für Administratoren, weil das Paket das
 * Agent-Token enthält; ohne aktive Druckbrücke gibt es nichts zu laden.
 *
 * Die Agenten kommen unverändert aus scripts/druck-agent.ps1 (Windows,
 * ohne Node) und scripts/druck-agent.ts (Linux/macOS) — next.config.ts
 * nimmt beide per outputFileTracingIncludes in die Funktion auf.
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
  let name = skriptSicher(anfrage.searchParams.get('name') ?? '') || 'druck-pc'
  let windowsDrucker = anfrage.searchParams.get('drucker') ?? ''
  let druckerId: string | null = null
  if (anfrage.searchParams.has('drucker_id')) {
    const id = idOderNull(anfrage.searchParams.get('drucker_id'))
    const [d] = id
      ? await sql<{ id: string; name: string; druckername: string | null }[]>`
          select id, name, druckername from drucker where id = ${id}`
      : []
    if (!d) return NextResponse.json({ error: 'Drucker unbekannt' }, { status: 404 })
    druckerId = d.id
    name = skriptSicher(d.name) || 'drucker'
    windowsDrucker = d.druckername ?? ''
  }
  const agentQuelle = await readFile(path.join(process.cwd(), 'scripts', 'druck-agent.ts'), 'utf8')
  const agentPsQuelle = await readFile(path.join(process.cwd(), 'scripts', 'druck-agent.ps1'), 'utf8')
  const erstellt = new Date()
  const zip = zipErstellen(
    druckbrueckePaket({
      url: oeffentlicheAdresse(process.env, request.headers, anfrage.origin),
      token: konfig.token,
      name,
      druckerId,
      ziel: zielWert(anfrage.searchParams.get('ziel')),
      drucker: windowsDrucker,
      agentQuelle,
      agentPsQuelle,
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
