import { NextResponse } from 'next/server'
import { logTransaction } from '@/modules/integrationen/transaktionen'
import { track17Konfiguriert, webhookSignaturPruefen } from '@/modules/versand/track17'
import { webhookVerarbeiten } from '@/modules/versand/zulauf-verfolgung'

/**
 * 17TRACK-Webhook (0112): Statuswechsel einer Zulauf-Sendung. Signatur im
 * Header `sign` = SHA-256 von „<Rohtext>/<Security Key>" — vorher nichts
 * parsen. Verarbeitet wird sofort (ein Update an einer Zeile), 200 nur bei
 * Erfolg: alles andere wiederholt 17TRACK dreimal (10, 30, 60 Minuten).
 * Jeder Push steht im Transaktionsprotokoll (Monitor, System „track17").
 */
export async function POST(request: Request) {
  if (!track17Konfiguriert()) {
    return NextResponse.json({ error: '17TRACK nicht angebunden' }, { status: 503 })
  }
  const raw = await request.text()
  const start = Date.now()
  if (!webhookSignaturPruefen(raw, request.headers.get('sign'))) {
    await logTransaction({ system: 'track17', kind: 'webhook', ok: false, statusCode: 401, error: 'Ungültige Signatur', durationMs: Date.now() - start })
    return NextResponse.json({ error: 'Ungültige Signatur' }, { status: 401 })
  }

  let payload: Parameters<typeof webhookVerarbeiten>[0]
  try {
    payload = JSON.parse(raw) as typeof payload
  } catch {
    return NextResponse.json({ error: 'Ungültiges JSON' }, { status: 400 })
  }

  const nummer = payload.data?.number ?? payload.data?.accepted?.[0]?.number ?? null
  try {
    const ergebnis = await webhookVerarbeiten(payload)
    await logTransaction({
      system: 'track17', kind: 'webhook', reference: nummer, request: payload, response: { ergebnis },
      ok: true, statusCode: 200, durationMs: Date.now() - start,
    })
    return NextResponse.json({ ok: true, ergebnis })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await logTransaction({
      system: 'track17', kind: 'webhook', reference: nummer, request: payload,
      ok: false, statusCode: 500, error: text, durationMs: Date.now() - start,
    })
    return NextResponse.json({ error: text }, { status: 500 })
  }
}
