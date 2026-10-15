import { NextResponse, after } from 'next/server'
import { logTransaction } from '@/modules/integrationen/transaktionen'
import { track17Konfiguriert, webhookSignaturPruefen } from '@/modules/versand/track17'
import { webhookVerarbeiten } from '@/modules/versand/zulauf-verfolgung'

/**
 * 17TRACK-Webhook (0112): Statuswechsel einer Zulauf-Sendung. Signatur im
 * Header `sign` = SHA-256 von „<Rohtext>/<Security Key>" — vorher nichts
 * parsen.
 *
 * Grundsatz wie beim Shopify-Webhook: prüfen, sofort 200 antworten, DANACH
 * verarbeiten (after()). 17TRACK wartet nur kurz auf die Antwort — ein
 * Kaltstart der Funktion plus Datenbankarbeit vor der Antwort reicht für
 * einen Zeitüberlauf (Webhook-Test: 504). Geht die Verarbeitung schief,
 * steht es im Transaktionsprotokoll (Monitor, System „track17"), und der
 * stündliche Abruf holt den Stand nach — ein Push ist nie die einzige Quelle.
 */
export async function POST(request: Request) {
  if (!track17Konfiguriert()) {
    return NextResponse.json({ error: '17TRACK nicht angebunden' }, { status: 503 })
  }
  const raw = await request.text()
  const start = Date.now()
  if (!webhookSignaturPruefen(raw, request.headers.get('sign'))) {
    after(() =>
      logTransaction({ system: 'track17', kind: 'webhook', ok: false, statusCode: 401, error: 'Ungültige Signatur', durationMs: Date.now() - start }),
    )
    return NextResponse.json({ error: 'Ungültige Signatur' }, { status: 401 })
  }

  let payload: Parameters<typeof webhookVerarbeiten>[0]
  try {
    payload = JSON.parse(raw) as typeof payload
  } catch {
    return NextResponse.json({ error: 'Ungültiges JSON' }, { status: 400 })
  }

  const nummer = payload.data?.number ?? payload.data?.accepted?.[0]?.number ?? null
  after(async () => {
    try {
      const ergebnis = await webhookVerarbeiten(payload)
      await logTransaction({
        system: 'track17', kind: 'webhook', reference: nummer, request: payload, response: { ergebnis },
        ok: true, statusCode: 200, durationMs: Date.now() - start,
      })
    } catch (err) {
      await logTransaction({
        system: 'track17', kind: 'webhook', reference: nummer, request: payload,
        ok: false, statusCode: 200, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start,
      })
    }
  })
  return NextResponse.json({ ok: true })
}
