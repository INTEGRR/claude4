import { NextResponse } from 'next/server'
import { absenderHashAusRequest } from '@/modules/auth/drossel'
import { reparaturanfrageAufnehmen, serviceHinweisSenden } from '@/modules/reparatur/anfrage-eingang'

/**
 * Reparaturanfrage von der öffentlichen Seite /service/reparatur — einer der
 * beiden Kanäle des zweiten Schreibwegs ohne Sitzung (Entscheidungslog
 * 2026-09-19). Die ganze Eingangslogik (Prüfung, Drossel, Dubletten,
 * Prozess-Schalter, Insert, Outbox) steht in modules/reparatur/
 * anfrage-eingang.ts — der zweite Kanal, das Formular im Shop
 * (/api/shopify/proxy), ruft dieselbe Funktion. Hier nur HTTP: JSON rein,
 * Statuscodes raus, gedrosselt je IP-Hash.
 */

export async function POST(request: Request) {
  let roh: Record<string, unknown>
  try {
    roh = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, fehler: 'ungueltig' }, { status: 400 })
  }

  const ergebnis = await reparaturanfrageAufnehmen(roh, {
    kanal: 'website',
    absenderHash: absenderHashAusRequest(request),
  })

  switch (ergebnis.art) {
    case 'honigtopf':
      return NextResponse.json({ ok: true })
    case 'fehler':
      return NextResponse.json({ ok: false, fehler: ergebnis.fehler }, { status: 422 })
    case 'gedrosselt':
      return NextResponse.json(
        { ok: false, fehler: 'zu_viele' },
        { status: 429, headers: { 'Retry-After': String(ergebnis.sekunden) } },
      )
    case 'inaktiv':
      return NextResponse.json({ ok: false, fehler: 'nicht_verfuegbar' }, { status: 503 })
    case 'ok':
      // Hinweis an den Service nur beim ersten Eingang, nicht beim Doppelklick.
      if (ergebnis.neu) await serviceHinweisSenden(ergebnis, new URL(request.url).origin)
      return NextResponse.json({ ok: true, nummer: ergebnis.nummer })
  }
}
