import { NextResponse } from 'next/server'
import { sql } from '@/db/client'
import { absenderHashAusRequest } from '@/modules/auth/drossel'
import { htmlSicher, mailConfigured, sendMail } from '@/modules/integrationen/mail'
import { vorgangStartzustand } from '@/modules/prozesse/registry/vorgang-ausfuehren'
import { normalisiereAnfrage, pruefeAnfrage } from '@/modules/shared/reparaturanfrage'

/**
 * Reparaturanfrage von der öffentlichen Seite /service/reparatur — der
 * zweite Schreibweg ohne Sitzung neben der Registrierung, nach demselben
 * Muster (Entscheidungslog 2026-09-19). Kein Torwächter: den angemeldeten
 * Nutzer gibt es hier per Definition nicht. Deshalb so eng wie möglich:
 *
 *   - genau eine Tabelle (vorgaenge), ein Insert, keine Verknüpfung zu
 *     Belegen — der Reparaturauftrag entsteht erst, wenn ein Mitarbeiter
 *     die Anfrage über die Registry annimmt (reparatur.anfrage_annehmen),
 *   - serverseitige Prüfung mit denselben Regeln wie im Formular
 *     (modules/shared/reparaturanfrage.ts) — dem Client wird nichts geglaubt,
 *   - Längenbegrenzung je Feld, Honigtopf, Drosselung je Absender-Hash
 *     (5 in 10 Minuten, gezählt in vorgaenge.absender_hash),
 *   - der Prozess-Schalter ist der Formular-Schalter: ist reparatur_anfrage
 *     abgeschaltet (Paketwechsel), antwortet die Route mit 503,
 *   - Nebenwirkungen nur über die Outbox (Eingangsbestätigung an den Kunden);
 *     die Hinweis-Mail an den Service ist best effort,
 *   - Protokoll im Audit-Log, Akteur 'kundenformular'.
 */

const PROZESS = 'reparatur_anfrage'
const DROSSEL_MINUTEN = 10
const DROSSEL_ANZAHL = 5

export async function POST(request: Request) {
  let roh: Record<string, unknown>
  try {
    roh = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, fehler: 'ungueltig' }, { status: 400 })
  }

  // Honigtopf: für Menschen unsichtbar, Bots füllen alles aus — freundliches
  // OK, gespeichert wird nichts.
  if (String(roh.webseite ?? '').trim()) return NextResponse.json({ ok: true })

  const daten = normalisiereAnfrage(roh)
  const fehler = pruefeAnfrage(daten)
  if (Object.keys(fehler).length > 0) {
    return NextResponse.json({ ok: false, fehler }, { status: 422 })
  }

  const hash = absenderHashAusRequest(request)
  if (hash) {
    const [{ anzahl }] = await sql<{ anzahl: number }[]>`
      select count(*)::int as anzahl from vorgaenge
      where quelle = 'kundenformular' and absender_hash = ${hash}
        and created_at > now() - (${DROSSEL_MINUTEN} || ' minutes')::interval`
    if (anzahl >= DROSSEL_ANZAHL) {
      return NextResponse.json(
        { ok: false, fehler: 'zu_viele' },
        { status: 429, headers: { 'Retry-After': String(DROSSEL_MINUTEN * 60) } },
      )
    }
  }

  const [prozess] = await sql<{ code: string }[]>`
    select code from prozesse where code = ${PROZESS} and aktiv and modell = 'vorgang'`
  if (!prozess) {
    return NextResponse.json({ ok: false, fehler: 'nicht_verfuegbar' }, { status: 503 })
  }

  const startzustand = await vorgangStartzustand(PROZESS)
  const [neu] = await sql<{ id: string; number: string }[]>`
    insert into vorgaenge (number, prozess_code, titel, state, partner_id, zusatz, quelle, absender_hash)
    values (next_sequence('vorgang'), ${PROZESS}, ${`Reparaturanfrage ${daten.kontakt_name}`},
            ${startzustand}, null, ${sql.json(daten)}, 'kundenformular', ${hash})
    returning id, number`

  await sql`select log_event('vorgang', ${neu.id}::uuid, 'state',
    ${`Reparaturanfrage über das Kundenformular eingegangen (${daten.email})`}, 'kundenformular')`

  // Eingangsbestätigung über die Outbox: ein Mail-Ausfall verliert die
  // Anfrage nicht, und der Job wird bei Fehlern wiederholt.
  await sql`select enqueue_job('send_repair_request_email',
    ${sql.json({ vorgang_id: neu.id })}, ${`anfrage-bestaetigung:${neu.id}`})`

  // Hinweis an den Service — best effort, die Anfrage ist gespeichert.
  const an = process.env.REPARATUR_MAIL || (await firmenMail())
  if (an && mailConfigured()) {
    try {
      const basis = new URL(request.url).origin
      await sendMail({
        to: an,
        subject: `Neue Reparaturanfrage ${neu.number}: ${daten.kontakt_name}`,
        html:
          `<p><strong>${htmlSicher(neu.number)}</strong> · ${htmlSicher(daten.kontakt_name)} · ` +
          `${htmlSicher(daten.email)}${daten.telefon ? ` · ${htmlSicher(daten.telefon)}` : ''}</p>` +
          `<p>${htmlSicher(daten.plz)} ${htmlSicher(daten.ort)}` +
          `${daten.bestellnummer ? ` · Bestellung ${htmlSicher(daten.bestellnummer)}` : ''}</p>` +
          `<p>${htmlSicher(daten.fehlerbeschreibung).replace(/\n/g, '<br>')}</p>` +
          `<p><a href="${basis}/vorgaenge/${neu.id}">Anfrage im ERP öffnen</a></p>`,
      })
    } catch (err) {
      console.warn('[reparaturanfrage] Hinweis-Mail fehlgeschlagen', err)
    }
  }

  return NextResponse.json({ ok: true, nummer: neu.number })
}

async function firmenMail(): Promise<string | null> {
  const [row] = await sql<{ email: string | null }[]>`
    select value ->> 'email' as email from settings where key = 'company'`
  const email = row?.email?.trim() ?? ''
  return email && !email.endsWith('@example.com') ? email : null
}
