import { after } from 'next/server'
import { sql } from '@/db/client'
import { proxySchluessel, proxySignaturPruefen } from '@/modules/integrationen/shopify-proxy'
import {
  anfrageMoeglich,
  reparaturanfrageAufnehmen,
  serviceHinweisSenden,
  shopAbsenderHash,
} from '@/modules/reparatur/anfrage-eingang'
import {
  dankeSeite,
  formularSeite,
  nichtGefundenSeite,
  nichtVerfuegbarSeite,
  pfadPraefix,
  stoerungSeite,
} from '@/modules/reparatur/shop-seiten'
import { ANFRAGE_FELDER, type Anfrage, normalisiereAnfrage } from '@/modules/shared/reparaturanfrage'

/**
 * Reparaturformular IM SHOP — Shopify App Proxy (Entscheidungslog
 * 2026-10-01, docs/website.md „Im Shop (App Proxy)").
 *
 * Der Kunde ruft https://<shop>/apps/reparatur auf; Shopify holt die Seite
 * serverseitig hier ab (Query signiert mit dem Client Secret der App) und
 * rendert die Antwort — `Content-Type: application/liquid` — im Theme des
 * Shops. Der Kunde sieht nur die Shop-Domain. Cookies streicht Shopify in
 * beide Richtungen, Redirects folgt Shopify selbst: darum keine Sitzung und
 * kein Post-Redirect-Get — das Formular wird nach Fehlern direkt neu
 * gezeigt, die Danke-Seite räumt den POST per history.replaceState ab.
 *
 * Geschrieben wird ausschließlich über reparaturanfrageAufnehmen() — dieselbe
 * Funktion wie /api/reparaturanfrage. Die Ausnahme vom Torwächter bleibt
 * damit EIN Codepfad mit zwei Kanälen; hier kommt nur HTTP dazu:
 *
 *   - ohne gültige Signatur (oder ohne Schlüssel) → 401 als Klartext,
 *   - GET / → Formular (für angemeldete Kunden aus dem Kundenkonto
 *     vorbelegt, nur aus der eigenen Datenbank), unbekannter Unterpfad →
 *     neutrale 404-Seite, jede Störung → neutrale Fehlerseite,
 *   - POST / → Formulardaten (urlencoded), gedrosselt je Shop-Kunde bzw.
 *     E-Mail (die IP wäre hier die von Shopify), Hinweis-Mail an den
 *     Service erst NACH der Antwort.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Kontext {
  params: Promise<{ pfad?: string[] }>
}

const LIQUID_HEADER = {
  'Content-Type': 'application/liquid; charset=utf-8',
  'Cache-Control': 'no-store, private',
}

export async function GET(request: Request, ctx: Kontext): Promise<Response> {
  return behandeln(request, ctx, 'GET')
}

export async function POST(request: Request, ctx: Kontext): Promise<Response> {
  return behandeln(request, ctx, 'POST')
}

async function behandeln(request: Request, ctx: Kontext, methode: 'GET' | 'POST'): Promise<Response> {
  const url = new URL(request.url)
  const pruefung = proxySignaturPruefen(url.searchParams, proxySchluessel())
  if (!pruefung.ok) {
    console.warn(`[shop-proxy] Aufruf abgewiesen: ${pruefung.grund}`)
    return new Response('Nicht autorisiert', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  const aktion = pfadPraefix(url.searchParams.get('path_prefix'))
  try {
    const { pfad = [] } = await ctx.params
    if (pfad.some(Boolean)) return liquid(nichtGefundenSeite(aktion), 404)

    const kundeId = kundenNummer(url.searchParams.get('logged_in_customer_id'))
    return methode === 'GET'
      ? await zeigen(aktion, kundeId)
      : await absenden(request, aktion, kundeId)
  } catch (err) {
    console.error('[shop-proxy] Störung', err)
    return liquid(stoerungSeite(aktion), 500)
  }
}

function liquid(body: string, status = 200, zusatz: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...LIQUID_HEADER, ...zusatz } })
}

/** logged_in_customer_id: leer für Gäste, sonst die numerische Kunden-ID. */
function kundenNummer(roh: string | null): string | null {
  const id = roh?.trim() ?? ''
  return /^\d{1,20}$/.test(id) ? id : null
}

async function zeigen(aktion: string, kundeId: string | null): Promise<Response> {
  if (!(await anfrageMoeglich())) return liquid(nichtVerfuegbarSeite())
  const konto = kundeId ? await kundenkonto(kundeId) : null
  return liquid(
    formularSeite({
      aktion,
      werte: konto?.werte ?? { land: 'DE' },
      bestellungen: konto?.bestellungen,
      vorausgefuellt: Boolean(konto),
    }),
  )
}

async function absenden(request: Request, aktion: string, kundeId: string | null): Promise<Response> {
  const roh: Record<string, string> = {}
  try {
    const formular = await request.formData()
    for (const feld of [...ANFRAGE_FELDER, 'webseite']) {
      const wert = formular.get(feld)
      if (typeof wert === 'string') roh[feld] = wert
    }
  } catch {
    // Kein lesbares Formular — leer weiter, die Prüfung meldet die Pflichtfelder.
  }

  const email = normalisiereAnfrage(roh).email
  const ergebnis = await reparaturanfrageAufnehmen(roh, {
    kanal: 'shop',
    absenderHash: shopAbsenderHash(kundeId, email),
    shopifyKundeId: kundeId,
  })

  switch (ergebnis.art) {
    case 'honigtopf':
      return liquid(dankeSeite())
    case 'fehler': {
      const konto = kundeId ? await kundenkonto(kundeId) : null
      return liquid(
        formularSeite({
          aktion,
          werte: ergebnis.daten,
          fehler: ergebnis.fehler,
          bestellungen: konto?.bestellungen,
        }),
      )
    }
    case 'gedrosselt':
      return liquid(
        formularSeite({
          aktion,
          werte: normalisiereAnfrage(roh),
          meldung: 'Zu viele Anfragen in kurzer Zeit — bitte versuchen Sie es in ein paar Minuten erneut.',
        }),
        429,
        { 'Retry-After': String(ergebnis.sekunden) },
      )
    case 'inaktiv':
      return liquid(nichtVerfuegbarSeite(), 503)
    case 'ok':
      if (ergebnis.neu) {
        const basis = new URL(request.url).origin
        await nachDerAntwort(() => serviceHinweisSenden(ergebnis, basis))
      }
      return liquid(dankeSeite(ergebnis.nummer))
  }
}

/**
 * Die Hinweis-Mail darf die Antwort nicht aufhalten (Shopify wartet, der
 * Kunde auch): after() verschickt sie nach der Antwort. Ohne Request-Kontext
 * (Prozesstest unter blankem Node) wirft after() — dann gleich erledigen.
 */
function nachDerAntwort(aufgabe: () => Promise<void>): Promise<void> {
  try {
    after(aufgabe)
    return Promise.resolve()
  } catch {
    return aufgabe()
  }
}

/**
 * Vorbelegung für angemeldete Shop-Kunden — nur aus der eigenen Datenbank
 * (partners.shopify_customer_id, beim Import als GID gespeichert), kein
 * Admin-API-Aufruf. Dazu die letzten fünf Bestellnummern als Vorschläge.
 * Die Kunden-ID ist von Shopify signiert, also wirklich die des Besuchers.
 */
async function kundenkonto(
  kundeId: string,
): Promise<{ werte: Partial<Anfrage>; bestellungen: string[] } | null> {
  const [p] = await sql<
    {
      id: string
      name: string | null
      email: string | null
      phone: string | null
      street: string | null
      house_number: string | null
      zip: string | null
      city: string | null
      country_code: string | null
    }[]
  >`
    select id, name, email, phone, street, house_number, zip, city, country_code
    from partners where shopify_customer_id = ${`gid://shopify/Customer/${kundeId}`}
    limit 1`
  if (!p) return null

  const bestellungen = await sql<{ name: string }[]>`
    select shopify_order_name as name from sales_orders
    where partner_id = ${p.id} and shopify_order_name is not null
    order by order_date desc
    limit 5`

  const werte = normalisiereAnfrage({
    kontakt_name: p.name,
    email: p.email,
    telefon: p.phone,
    strasse: p.street,
    hausnummer: p.house_number,
    plz: p.zip,
    ort: p.city,
    land: p.country_code,
  })
  return { werte, bestellungen: bestellungen.map((b) => b.name) }
}
