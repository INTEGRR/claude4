import { createHash } from 'node:crypto'
import { sql, tx } from '@/db/client'
import { RETOURE_GRUENDE } from './retoure-gruende.ts'

/**
 * Eingang des Retourenportals im Shop (0119, Entscheidungslog 2026-10-17).
 *
 * Der Kunde weist sich mit Bestellnummer + E-Mail der Bestellung aus — oder
 * ist im Shop angemeldet (die Kunden-ID signiert Shopify, siehe App Proxy).
 * Angeboten wird, was geliefert und noch in keiner Retoure ist; die Regeln
 * selbst prüft retoure_anlegen in der Datenbank ein zweites Mal.
 *
 * Schutz: Honigtopf, Drossel je Absender (E-Mail bzw. Kunden-ID), keine
 * Auskunft darüber, OB eine Bestellnummer existiert — „nicht gefunden oder
 * E-Mail passt nicht" ist eine Meldung. Eine Nummer allein reicht nie.
 */

export const DROSSEL_MINUTEN = 10
export const DROSSEL_ANZAHL = 5

export interface PortalZeile {
  id: string
  name: string
  frei: number
}

export interface PortalBestellung {
  id: string
  bestellung: string
  zeilen: PortalZeile[]
}

export type Suche =
  | { art: 'ok'; bestellung: PortalBestellung }
  | { art: 'nicht_gefunden' }
  | { art: 'nichts_offen'; bestellung: string }

export type Aufnahme =
  | { art: 'ok'; nummer: string }
  | { art: 'honigtopf' }
  | { art: 'gedrosselt' }
  | { art: 'fehler'; meldung: string }
  | { art: 'inaktiv' }

export function absenderHash(kundeId: string | null, email: string): string {
  return createHash('sha256').update(kundeId ? `kunde:${kundeId}` : `mail:${email.trim().toLowerCase()}`).digest('hex')
}

export function bestellnummerNormal(roh: string): string {
  return roh.trim().replace(/^#?/, '#')
}

export async function retourePortalAktiv(): Promise<boolean> {
  const [p] = await sql<{ aktiv: boolean }[]>`select aktiv from prozesse where code = 'retoure'`
  return Boolean(p?.aktiv)
}

/** Gelieferte Shop-Bestellung zu Nummer + E-Mail bzw. zum angemeldeten Kunden. */
export async function bestellungFinden(
  bestellnummer: string,
  email: string,
  kundeId: string | null,
): Promise<Suche> {
  const nummer = bestellnummerNormal(bestellnummer)
  if (nummer.length < 2) return { art: 'nicht_gefunden' }
  const mail = email.trim().toLowerCase()
  const [so] = await sql<{ id: string; bestellung: string }[]>`
    select so.id, so.shopify_order_name as bestellung
    from sales_orders so
    join partners p on p.id = so.partner_id
    where so.source = 'shopify' and so.shopify_order_name = ${nummer}
      and (
        (${mail} <> '' and (lower(coalesce(so.ship_email, '')) = ${mail} or lower(coalesce(p.email, '')) = ${mail}))
        or (${kundeId}::text is not null and p.shopify_customer_id = ${kundeId ? `gid://shopify/Customer/${kundeId}` : ''})
      )
    order by so.order_date desc
    limit 1`
  if (!so) return { art: 'nicht_gefunden' }
  const zeilen = await sql<PortalZeile[]>`
    select sol.id, sol.name,
           (sol.qty_delivered - coalesce((select sum(rp.menge) from retoure_positionen rp join retouren r on r.id = rp.retoure_id
                                          where rp.sales_order_line_id = sol.id and r.status not in ('abgelehnt', 'storniert')), 0))::float as frei
    from sales_order_lines sol
    where sol.order_id = ${so.id} and sol.variant_id is not null and sol.qty_delivered > 0
    order by sol.sequence`
  const offen = zeilen.filter((z) => z.frei > 0)
  if (offen.length === 0) return { art: 'nichts_offen', bestellung: so.bestellung }
  return { art: 'ok', bestellung: { id: so.id, bestellung: so.bestellung, zeilen: offen } }
}

/** Anfrage aus dem Portal anlegen — samt Eingangsbestätigung über die Outbox. */
export async function retoureAufnehmen(
  roh: Record<string, string>,
  opt: { kundeId: string | null },
): Promise<Aufnahme> {
  if ((roh.webseite ?? '').trim() !== '') return { art: 'honigtopf' }
  if (!(await retourePortalAktiv())) return { art: 'inaktiv' }

  const email = (roh.email ?? '').trim()
  const suche = await bestellungFinden(roh.bestellnummer ?? '', email, opt.kundeId)
  if (suche.art !== 'ok') {
    return { art: 'fehler', meldung: 'Die Bestellung haben wir nicht gefunden oder es ist nichts mehr zurücksendbar.' }
  }

  const hash = absenderHash(opt.kundeId, email)
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from retouren
    where absender_hash = ${hash} and created_at > now() - make_interval(mins => ${DROSSEL_MINUTEN})`
  if (n >= DROSSEL_ANZAHL) return { art: 'gedrosselt' }

  const positionen: { zeile: string; menge: number; grund?: string }[] = []
  for (const z of suche.bestellung.zeilen) {
    const menge = Number((roh[`menge_${z.id}`] ?? '').replace(',', '.'))
    if (!Number.isFinite(menge) || menge <= 0) continue
    if (menge > z.frei) return { art: 'fehler', meldung: `${z.name}: höchstens ${z.frei} zurücksendbar.` }
    const grund = (roh[`grund_${z.id}`] ?? '').trim()
    positionen.push({
      zeile: z.id,
      menge,
      ...(grund && (RETOURE_GRUENDE as readonly string[]).includes(grund) ? { grund } : {}),
    })
  }
  if (positionen.length === 0) return { art: 'fehler', meldung: 'Bitte wähl mindestens einen Artikel und die Menge aus.' }
  const anliegen = (roh.anliegen ?? '').trim().slice(0, 1000)

  try {
    const nummer = await tx(async (t) => {
      const [r] = await t<{ id: string }[]>`
        select retoure_anlegen(${suche.bestellung.id}, ${t.json(positionen as never)}, 'shop', ${anliegen || null},
                               ${email || null}, ${hash}, 'portal') as id`
      await t`select enqueue_job('send_return_request_email', ${t.json({ retoure_id: r.id })}, ${`retoure-anfrage:${r.id}`})`
      const [{ nummer }] = await t<{ nummer: string }[]>`select nummer from retouren where id = ${r.id}`
      return nummer
    })
    return { art: 'ok', nummer }
  } catch (err) {
    const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    return { art: 'fehler', meldung }
  }
}
