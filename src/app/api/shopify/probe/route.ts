import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { shopifyModus } from '@/modules/integrationen/shopify-modus'
import { probeZeile } from '@/modules/integrationen/probe-anzeige'

/**
 * Debug-Box des Shopify-Probelaufs (0102): was KRNL an Shopify geschickt
 * HÄTTE (api_transactions, kind 'probe:%'), neueste zuerst. Nur Admins.
 *   GET  ?seit=<ISO>  → Einträge danach (die Box fragt alle paar Sekunden)
 *   POST              → Bestandsabgleich sofort rechnen (nur im Probelauf)
 */
async function admin() {
  const user = await currentUser()
  return user && user.rollen.includes('admin') ? user : null
}

export async function GET(request: Request) {
  if (!(await admin())) return NextResponse.json({ error: 'Nur für Administratoren' }, { status: 403 })
  const seit = new URL(request.url).searchParams.get('seit')
  const ab = seit && !Number.isNaN(Date.parse(seit)) ? seit : new Date(Date.now() - 2 * 3600_000).toISOString()
  const [modus, zeilen, [offen]] = await Promise.all([
    shopifyModus(sql),
    sql<{ id: string; created_at: string; kind: string; request: unknown }[]>`
      select id, created_at::text as created_at, kind, request
      from api_transactions
      where system = 'shopify' and kind like 'probe:%' and created_at > ${ab}::timestamptz
      order by created_at desc
      limit 50`,
    sql<{ ansteht: boolean }[]>`
      select exists (select 1 from integration_jobs
                     where kind = 'shopify_inventory_push' and status in ('pending', 'running')) as ansteht`,
  ])
  return NextResponse.json({
    modus,
    ansteht: offen.ansteht,
    eintraege: zeilen.map((z) => ({ id: z.id, at: z.created_at, kind: z.kind, ...probeZeile(z.kind, z.request) })),
  })
}

export async function POST() {
  if (!(await admin())) return NextResponse.json({ error: 'Nur für Administratoren' }, { status: 403 })
  if ((await shopifyModus(sql)) !== 'probe') {
    return NextResponse.json({ error: 'Nur im Probelauf' }, { status: 409 })
  }
  const { inventarAbgleichen } = await import('@/modules/integrationen/inventar')
  const r = await inventarAbgleichen()
  return NextResponse.json(r)
}
