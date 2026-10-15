import { NextResponse } from 'next/server'
import { currentUser } from '@/modules/auth'
import { driveKonfiguriert } from '@/modules/google/auth'
import { bestaetigteAktionAusfuehren } from '@/modules/ki/aktion-bestaetigt'
import { type ChatAnhang, anhaengeLesen } from '@/modules/ki/anhaenge'
import { AktionsFehler, RechteFehler } from '@/modules/prozesse/torwaechter'

/**
 * Führt eine vom Agenten vorgeschlagene Aktion aus — aber erst, wenn der
 * Benutzer im Chat bestätigt hat.
 *
 * Der Vorschlag aus dem Stream ist hier ausdrücklich **kein** Freibrief:
 * der komplette Weg läuft über den Torwächter — Schema, Rechte (inkl.
 * nurAdmin), Ausführung, Audit. Ein Fertigungsmitarbeiter kann sich also
 * auch über die KI keinen Kunden anlegen.
 *
 * Kam der Vorschlag aus einem Beleg (Anhang im Chat), schickt der Browser
 * die Datei mit; nach dem Anlegen wird sie am neuen Datensatz abgelegt —
 * ebenfalls über den Torwächter (`einkauf.beleg_ablegen`), nie an ihm vorbei.
 */

/** Aktionen, deren Beleg nach dem Anlegen am neuen Datensatz abgelegt wird — und welches Feld die Art nennt. */
const BELEG_ABLAGE: Record<string, { artFeld: string }> = {
  'einkauf.bestellung_erfassen': { artFeld: 'beleg_art' },
}

export async function POST(request: Request) {
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'Nicht angemeldet' }, { status: 401 })

  let name: string
  let parameter: unknown
  let anhaenge: ChatAnhang[]
  try {
    const body = (await request.json()) as { aktion?: unknown; parameter?: unknown; anhaenge?: unknown }
    if (typeof body.aktion !== 'string') throw new Error()
    name = body.aktion
    parameter = body.parameter
    const gelesen = anhaengeLesen(body.anhaenge)
    if (!gelesen.ok) throw new Error(gelesen.fehler)
    anhaenge = gelesen.wert
  } catch (err) {
    const grund = err instanceof Error && err.message ? err.message : 'Ungültige Anfrage'
    return NextResponse.json({ error: grund }, { status: 400 })
  }

  try {
    const ergebnis = await bestaetigteAktionAusfuehren(name, parameter, user)
    const ablage = BELEG_ABLAGE[name]
    if (ablage && anhaenge.length > 0 && ergebnis.recordId) {
      const art = (parameter as Record<string, unknown> | null)?.[ablage.artFeld]
      const hinweis = await belegeAblegen(ergebnis.recordId, anhaenge, typeof art === 'string' ? art : undefined, user)
      ergebnis.text = `${ergebnis.text} ${hinweis}`
    }
    return NextResponse.json(ergebnis)
  } catch (err) {
    if (err instanceof RechteFehler) {
      return NextResponse.json({ error: err.message }, { status: 403 })
    }
    if (err instanceof AktionsFehler) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    return NextResponse.json({ error: meldung }, { status: 400 })
  }
}

/** Jeden Anhang ablegen; ein Fehler dabei macht das Anlegen nicht rückgängig, sondern steht im Text. */
async function belegeAblegen(
  recordId: string,
  anhaenge: ChatAnhang[],
  art: string | undefined,
  user: NonNullable<Awaited<ReturnType<typeof currentUser>>>,
): Promise<string> {
  if (!driveKonfiguriert()) return 'Beleg nicht abgelegt: keine Google-Ablage angebunden.'
  const abgelegt: string[] = []
  const fehler: string[] = []
  for (const a of anhaenge) {
    try {
      await bestaetigteAktionAusfuehren(
        'einkauf.beleg_ablegen',
        { record_id: recordId, name: a.name, mime: a.mime, daten: a.data, ...(art ? { art } : {}) },
        user,
      )
      abgelegt.push(a.name)
    } catch (err) {
      fehler.push(`${a.name}: ${(err instanceof Error ? err.message : String(err)).replace(/^error: /, '')}`)
    }
  }
  return [
    abgelegt.length ? `Beleg abgelegt: ${abgelegt.join(', ')}.` : null,
    fehler.length ? `Beleg nicht abgelegt — ${fehler.join('; ')}.` : null,
  ]
    .filter(Boolean)
    .join(' ')
}
