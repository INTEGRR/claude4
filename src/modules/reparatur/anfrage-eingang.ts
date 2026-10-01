import 'server-only'
import { sql, tx } from '@/db/client'
import { kennungHash } from '@/modules/auth/drossel'
import { htmlSicher, mailConfigured, sendMail } from '@/modules/integrationen/mail'
import { vorgangStartzustand } from '@/modules/prozesse/registry/vorgang-ausfuehren'
import {
  type Anfrage,
  type AnfrageFeld,
  normalisiereAnfrage,
  pruefeAnfrage,
} from '@/modules/shared/reparaturanfrage'

/**
 * Eingang einer Reparaturanfrage ohne Sitzung — der zweite Schreibweg ohne
 * Sitzung neben der Registrierung (Entscheidungslog 2026-09-19), hier an
 * GENAU EINER Stelle. Zwei Kanäle rufen ihn, keiner schreibt selbst:
 *
 *   - 'website': POST /api/reparaturanfrage (Formular /service/reparatur),
 *     gedrosselt je IP-Hash, Quelle 'kundenformular';
 *   - 'shop':    /api/shopify/proxy (Formular im Shop über den App Proxy,
 *     Entscheidungslog 2026-10-01), gedrosselt je Shop-Kunde bzw. E-Mail,
 *     Quelle 'shop'.
 *
 * Kein Torwächter: den angemeldeten Nutzer gibt es hier per Definition
 * nicht (und er wird auch nicht vorgetäuscht). Deshalb so eng wie möglich:
 *
 *   - genau eine Tabelle (vorgaenge), ein Insert, keine Verknüpfung zu
 *     Belegen — der Reparaturauftrag entsteht erst, wenn ein Mitarbeiter
 *     die Anfrage über die Registry annimmt (reparatur.anfrage_annehmen),
 *   - serverseitige Prüfung mit denselben Regeln wie im Formular
 *     (modules/shared/reparaturanfrage.ts) — dem Client wird nichts geglaubt,
 *   - Längenbegrenzung je Feld, Honigtopf, Drosselung je Absender-Hash
 *     (5 in 10 Minuten, gezählt in vorgaenge.absender_hash),
 *   - doppelt Abgeschicktes (gleiche E-Mail, gleiche Fehlerbeschreibung,
 *     10 Minuten) bekommt die Nummer der ersten Anfrage statt einer zweiten,
 *   - der Prozess-Schalter ist der Formular-Schalter: ist reparatur_anfrage
 *     abgeschaltet (Paketwechsel), wird nichts angenommen,
 *   - Nebenwirkungen nur über die Outbox (Eingangsbestätigung an den Kunden);
 *     die Hinweis-Mail an den Service ist best effort und eigene Funktion,
 *     damit der Shop sie nach der Antwort verschicken kann,
 *   - Protokoll im Audit-Log, Akteur 'kundenformular'.
 *
 * Wächter: tests/reparatur-anfrage.test.ts prüft, dass nur diese Datei in
 * vorgaenge schreibt und nur die beiden Routen sie aufrufen.
 */

export type AnfrageKanal = 'website' | 'shop'

/** Herkunft am Vorgang (vorgaenge.quelle) je Kanal. */
export const QUELLE_JE_KANAL: Record<AnfrageKanal, string> = {
  website: 'kundenformular',
  shop: 'shop',
}

export const PROZESS = 'reparatur_anfrage'
export const DROSSEL_MINUTEN = 10
export const DROSSEL_ANZAHL = 5
/** Fenster, in dem eine identische Anfrage als Doppelklick gilt. */
export const DOPPELT_MINUTEN = 10

export interface AnfrageOptionen {
  kanal: AnfrageKanal
  /** Drossel-Pseudonym; null = nicht drosseln (Website ohne bekannte Adresse). */
  absenderHash: string | null
  /** Numerische Shopify-Kundennummer eines im Shop angemeldeten Kunden — nur fürs Protokoll. */
  shopifyKundeId?: string | null
}

export type AnfrageErgebnis =
  | { art: 'ok'; id: string; nummer: string; daten: Anfrage; neu: boolean }
  | { art: 'fehler'; fehler: Partial<Record<AnfrageFeld, string>>; daten: Anfrage }
  | { art: 'gedrosselt'; sekunden: number }
  | { art: 'inaktiv' }
  | { art: 'honigtopf' }

/** Nimmt das Formular gerade etwas an? (Prozess-Schalter = Formular-Schalter.) */
export async function anfrageMoeglich(): Promise<boolean> {
  const [prozess] = await sql<{ aktiv: boolean }[]>`
    select aktiv from prozesse where code = ${PROZESS} and modell = 'vorgang'`
  return Boolean(prozess?.aktiv)
}

/**
 * Drossel-Pseudonym für den Shop. Die IP taugt dort nicht: Shopify ruft
 * serverseitig, Vercel überschreibt X-Forwarded-For — gezählt würden die
 * Egress-Adressen von Shopify, und nach fünf Anfragen wäre der ganze Shop
 * gesperrt. Stattdessen der angemeldete Kunde, sonst die E-Mail.
 */
export function shopAbsenderHash(shopifyKundeId: string | null | undefined, email: string): string {
  const kennung = shopifyKundeId?.trim() ? `kunde:${shopifyKundeId.trim()}` : `mail:${email}`
  return kennungHash(`shop:${kennung}`)
}

export async function reparaturanfrageAufnehmen(
  roh: Record<string, unknown>,
  opt: AnfrageOptionen,
): Promise<AnfrageErgebnis> {
  // Honigtopf: für Menschen unsichtbar, Bots füllen alles aus — freundliches
  // OK, gespeichert wird nichts.
  if (String(roh.webseite ?? '').trim()) return { art: 'honigtopf' }

  const daten = normalisiereAnfrage(roh)
  const fehler = pruefeAnfrage(daten)
  if (Object.keys(fehler).length > 0) return { art: 'fehler', fehler, daten }

  const quelle = QUELLE_JE_KANAL[opt.kanal]
  // Vor der Transaktion: vorgangStartzustand liest über den allgemeinen
  // Client — in der Transaktion bräuchte es eine zweite Verbindung, während
  // die erste die Sperre hält (bei vollem Pool ein Selbst-Warten).
  const startzustand = await vorgangStartzustand(PROZESS)

  return tx(async (t) => {
    // Gleichzeitige Doppelklicks (ohne JavaScript schickt der Browser zwei
    // Requests) laufen je E-Mail hintereinander — sonst sähen beide die
    // Dublettenprüfung leer und legten je einen Vorgang an.
    await t`select pg_advisory_xact_lock(hashtext(${`reparaturanfrage:${daten.email.toLowerCase()}`}))`

    const [doppelt] = await t<{ id: string; number: string }[]>`
      select id, number from vorgaenge
      where prozess_code = ${PROZESS}
        and quelle in ('kundenformular', 'shop')
        and lower(zusatz ->> 'email') = ${daten.email.toLowerCase()}
        and zusatz ->> 'fehlerbeschreibung' = ${daten.fehlerbeschreibung}
        and created_at > now() - (${DOPPELT_MINUTEN} || ' minutes')::interval
      order by created_at desc
      limit 1`
    if (doppelt) return { art: 'ok', id: doppelt.id, nummer: doppelt.number, daten, neu: false }

    if (opt.absenderHash) {
      const [{ anzahl }] = await t<{ anzahl: number }[]>`
        select count(*)::int as anzahl from vorgaenge
        where quelle = ${quelle} and absender_hash = ${opt.absenderHash}
          and created_at > now() - (${DROSSEL_MINUTEN} || ' minutes')::interval`
      if (anzahl >= DROSSEL_ANZAHL) return { art: 'gedrosselt', sekunden: DROSSEL_MINUTEN * 60 }
    }

    const [prozess] = await t<{ code: string }[]>`
      select code from prozesse where code = ${PROZESS} and aktiv and modell = 'vorgang'`
    if (!prozess) return { art: 'inaktiv' }

    const [neu] = await t<{ id: string; number: string }[]>`
      insert into vorgaenge (number, prozess_code, titel, state, partner_id, zusatz, quelle, absender_hash)
      values (next_sequence('vorgang'), ${PROZESS}, ${`Reparaturanfrage ${daten.kontakt_name}`},
              ${startzustand}, null, ${t.json(daten)}, ${quelle}, ${opt.absenderHash})
      returning id, number`

    const wo =
      opt.kanal === 'shop'
        ? `über das Formular im Shop${opt.shopifyKundeId ? `, Shopify-Kunde ${opt.shopifyKundeId}` : ''}`
        : 'über das Kundenformular'
    await t`select log_event('vorgang', ${neu.id}::uuid, 'state',
      ${`Reparaturanfrage ${wo} eingegangen (${daten.email})`}, 'kundenformular')`

    // Eingangsbestätigung über die Outbox: ein Mail-Ausfall verliert die
    // Anfrage nicht, und der Job wird bei Fehlern wiederholt. In derselben
    // Transaktion — es gibt keinen Vorgang ohne Bestätigungsauftrag.
    await t`select enqueue_job('send_repair_request_email',
      ${t.json({ vorgang_id: neu.id })}, ${`anfrage-bestaetigung:${neu.id}`})`

    return { art: 'ok', id: neu.id, nummer: neu.number, daten, neu: true }
  })
}

/**
 * Hinweis an den Service — best effort, die Anfrage ist gespeichert.
 * `basis` ist die Adresse des ERP (für den Link zum Vorgang); die Mail geht
 * nur an den Service, nie an den Kunden.
 */
export async function serviceHinweisSenden(
  anfrage: { id: string; nummer: string; daten: Anfrage },
  basis: string,
): Promise<void> {
  if (!mailConfigured()) return
  const an = process.env.REPARATUR_MAIL || (await firmenMail())
  if (!an) return
  const { id, nummer, daten } = anfrage
  try {
    await sendMail({
      to: an,
      subject: `Neue Reparaturanfrage ${nummer}: ${daten.kontakt_name}`,
      html:
        `<p><strong>${htmlSicher(nummer)}</strong> · ${htmlSicher(daten.kontakt_name)} · ` +
        `${htmlSicher(daten.email)}${daten.telefon ? ` · ${htmlSicher(daten.telefon)}` : ''}</p>` +
        `<p>${htmlSicher(daten.plz)} ${htmlSicher(daten.ort)}` +
        `${daten.bestellnummer ? ` · Bestellung ${htmlSicher(daten.bestellnummer)}` : ''}</p>` +
        `<p>${htmlSicher(daten.fehlerbeschreibung).replace(/\n/g, '<br>')}</p>` +
        `<p><a href="${basis}/vorgaenge/${id}">Anfrage im ERP öffnen</a></p>`,
    })
  } catch (err) {
    console.warn('[reparaturanfrage] Hinweis-Mail fehlgeschlagen', err)
  }
}

async function firmenMail(): Promise<string | null> {
  const [row] = await sql<{ email: string | null }[]>`
    select value ->> 'email' as email from settings where key = 'company'`
  const email = row?.email?.trim() ?? ''
  return email && !email.endsWith('@example.com') ? email : null
}
