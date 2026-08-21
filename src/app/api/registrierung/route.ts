import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { mailConfigured, sendMail } from '@/modules/integrationen/mail'
import { normalisiereRegistrierung, pruefeRegistrierung } from '@/modules/shared/registrierung'

/**
 * Registrierung von der öffentlichen Startseite — der EINZIGE Schreibweg
 * ohne Sitzung. Er läuft bewusst NICHT über den Torwächter: der setzt einen
 * angemeldeten Nutzer mit Rolle voraus, und den gibt es hier per Definition
 * nicht. Stattdessen ist der Weg so eng wie möglich gehalten:
 *
 *   - genau eine Tabelle (registrierungen), keine Verknüpfung zu Belegen,
 *   - serverseitige Prüfung mit denselben Regeln wie im Formular
 *     (modules/shared/registrierung.ts) — dem Client wird nichts geglaubt,
 *   - Längenbegrenzung je Feld gegen Müll-Fluten,
 *   - Honigtopf-Feld gegen einfache Bots,
 *   - Drosselung je Absender-Hash (5 in 10 Minuten),
 *   - Protokoll im Audit-Log, damit die Instanz nichts still entgegennimmt.
 *
 * Alles Weitere (Stand setzen, Notiz) läuft wieder über die Registry —
 * siehe einstellungen.registrierung_status.
 */

const DROSSEL_MINUTEN = 10
const DROSSEL_ANZAHL = 5

/** Pseudonym des Absenders — nur zur Drosselung, nicht rückrechenbar. */
function absenderHash(request: Request): string | null {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')
  if (!ip) return null
  const salz = process.env.SESSION_SECRET ?? 'krnl'
  return createHash('sha256').update(`${salz}:${ip}`).digest('hex').slice(0, 32)
}

export async function POST(request: Request) {
  let roh: Record<string, unknown>
  try {
    roh = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, fehler: 'ungueltig' }, { status: 400 })
  }

  // Honigtopf: das Feld ist im Formular versteckt und bleibt für Menschen
  // leer. Bots füllen alles aus — die bekommen ein freundliches OK und
  // landen nirgends.
  if (String(roh.webseite ?? '').trim()) return NextResponse.json({ ok: true })

  const daten = normalisiereRegistrierung(roh)
  const fehler = pruefeRegistrierung(daten)
  if (Object.keys(fehler).length > 0) {
    return NextResponse.json({ ok: false, fehler }, { status: 422 })
  }

  const hash = absenderHash(request)
  if (hash) {
    const [{ anzahl }] = await sql<{ anzahl: number }[]>`
      select count(*)::int as anzahl from registrierungen
      where ip_hash = ${hash}
        and created_at > now() - (${DROSSEL_MINUTEN} || ' minutes')::interval`
    if (anzahl >= DROSSEL_ANZAHL) {
      return NextResponse.json(
        { ok: false, fehler: 'zu_viele' },
        { status: 429, headers: { 'Retry-After': String(DROSSEL_MINUTEN * 60) } },
      )
    }
  }

  const [neu] = await sql<{ id: string }[]>`
    insert into registrierungen
      (firma, ansprechpartner, email, telefon, nutzer, heutiges_system, ablauf, ip_hash)
    values (${daten.firma}, ${daten.ansprechpartner}, ${daten.email},
            ${daten.telefon || null}, ${daten.nutzer || null},
            ${daten.heutiges_system || null}, ${daten.ablauf}, ${hash})
    returning id`

  await sql`select log_event('registrierung', ${neu.id}, 'state',
    ${`Registrierung von ${daten.firma} (${daten.email})`}, 'startseite')`

  // Hinweis-Mail, wenn eine Empfängeradresse hinterlegt ist. Fehler dabei
  // dürfen die Registrierung nicht scheitern lassen — sie ist gespeichert.
  const an = process.env.REGISTRIERUNG_MAIL
  if (an && mailConfigured()) {
    try {
      await sendMail({
        to: an,
        subject: `KRNL · neue Registrierung: ${daten.firma}`,
        html:
          `<p><strong>${daten.firma}</strong><br>` +
          `${daten.ansprechpartner} · ${daten.email}` +
          `${daten.telefon ? ` · ${daten.telefon}` : ''}</p>` +
          `<p>Nutzer: ${daten.nutzer || '—'} · Heute: ${daten.heutiges_system || '—'}</p>` +
          `<p>${daten.ablauf.replace(/\n/g, '<br>')}</p>`,
      })
    } catch (err) {
      console.warn('[registrierung] Hinweis-Mail fehlgeschlagen', err)
    }
  }

  return NextResponse.json({ ok: true })
}
