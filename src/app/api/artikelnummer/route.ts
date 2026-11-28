import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { currentUser } from '@/modules/auth'
import { artikelnummerVorschlag } from '@/modules/shared/artikelnummer'

export const dynamic = 'force-dynamic'

/**
 * Artikelnummer-Vorschlag zu einem Namen (2026-11-28): das Muster aus
 * shared/artikelnummer.ts plus die kleinste freie Laufnummer. Nur lesend.
 */
export async function GET(request: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })
  const name = new URL(request.url).searchParams.get('name')?.trim() ?? ''
  if (name.length < 3) return NextResponse.json({ vorschlag: null })
  const vergeben = await sql<{ sku: string }[]>`select sku from product_variants where coalesce(sku, '') <> ''`
  return NextResponse.json(
    { vorschlag: artikelnummerVorschlag({ produkt: name }, vergeben.map((v) => v.sku)) },
    { headers: { 'cache-control': 'no-store' } },
  )
}
