import './env.ts'
import { proxySchluessel, proxySignieren } from '../src/modules/integrationen/shopify-proxy.ts'

/**
 * Signierte Adresse des Reparaturformulars im Shop — zum Ausprobieren ohne
 * Shopify (App Proxy, docs/website.md „Im Shop (App Proxy)").
 *
 *   SHOPIFY_FAKE=1 node --experimental-strip-types scripts/shop-proxy-url.ts
 *   SHOPIFY_FAKE=1 node --experimental-strip-types scripts/shop-proxy-url.ts --kunde 123456
 *   … --basis http://localhost:3000 --pfad unbekannt
 *
 * Schlüssel wie in der Route: SHOPIFY_CLIENT_SECRET, sonst bei
 * SHOPIFY_FAKE=1 der feste Attrappen-Schlüssel. Die Adresse gilt nur
 * 90 Sekunden (Zeitstempel-Fenster der Prüfung) — für jeden Versuch neu
 * erzeugen. Lokal rendert niemand das Liquid: `{{ shop.name }}` bleibt
 * stehen, und das Formular schickt an /apps/reparatur, das es lokal nicht
 * gibt — zum Absenden das ausgegebene curl verwenden.
 */

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const secret = proxySchluessel()
if (!secret) {
  console.error('Kein Schlüssel: SHOPIFY_CLIENT_SECRET setzen oder SHOPIFY_FAKE=1.')
  process.exit(1)
}

const basis = (argument('basis') ?? 'http://localhost:3000').replace(/\/$/, '')
const pfad = argument('pfad')?.replace(/^\/+/, '') ?? ''
const params = new URLSearchParams({
  shop: process.env.SHOPIFY_SHOP_DOMAIN || 'beispiel-shop.myshopify.com',
  logged_in_customer_id: argument('kunde') ?? '',
  path_prefix: '/apps/reparatur',
  timestamp: String(Math.floor(Date.now() / 1000)),
})
params.set('signature', proxySignieren(params, secret))

const url = `${basis}/api/shopify/proxy${pfad ? `/${pfad}` : ''}?${params}`
console.log(`GET (90 Sekunden gültig):\n  ${url}\n`)
console.log(
  'POST:\n' +
    `  curl -s -X POST '${url}' \\\n` +
    "    --data-urlencode 'kontakt_name=Erika Musterfrau' --data-urlencode 'email=erika@example.com' \\\n" +
    "    --data-urlencode 'strasse=Prozessweg' --data-urlencode 'hausnummer=7' --data-urlencode 'plz=10115' \\\n" +
    "    --data-urlencode 'ort=Berlin' --data-urlencode 'land=DE' \\\n" +
    "    --data-urlencode 'fehlerbeschreibung=Die Leertaste prellt seit zwei Wochen.'",
)
