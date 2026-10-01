import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signaturprüfung des Shopify App Proxy — bewusst ohne Server- und
 * Datenbank-Abhängigkeiten (Muster shopify-hmac.ts), damit dieser
 * sicherheitskritische Teil unter blankem Node getestet werden kann.
 *
 * Shopify leitet `https://<shop>/apps/reparatur/…` serverseitig an
 * `/api/shopify/proxy/…` weiter und hängt `shop`, `logged_in_customer_id`,
 * `path_prefix`, `timestamp` und `signature` an die Query. Signiert ist NUR
 * die Query (nicht der Body, nicht der Pfad):
 *
 *   alle Parameter außer `signature`, Werte URL-dekodiert, Werte mehrfach
 *   vorkommender Schlüssel mit „," verbunden, je Schlüssel `key=value`,
 *   sortiert, OHNE Trenner aneinandergehängt → HMAC-SHA256 (hex) mit dem
 *   Client Secret der App.
 *
 * Sortiert werden die fertigen `key=value`-Zeichenketten nach Code-Einheiten
 * — genau wie Shopifys Ruby-Referenz (`collect { … }.sort.join`), nicht nach
 * Schlüssel mit localeCompare.
 *
 * Zusätzlich zur Signatur: der Zeitstempel darf höchstens 90 Sekunden von
 * der Serverzeit abweichen (gleiche Toleranz wie Shopifys eigene
 * Bibliothek), und `shop` muss — wenn SHOPIFY_SHOP_DOMAIN gesetzt ist —
 * der eigene Shop sein. Eine abgefangene URL ist damit nach 90 Sekunden
 * wertlos.
 */

/** Höchstabweichung des Zeitstempels von der Serverzeit. */
export const PROXY_ZEITFENSTER_SEKUNDEN = 90

/**
 * Fester Schlüssel für SHOPIFY_FAKE=1 ohne Client Secret (lokal, Tests).
 * Die Prüfung wird damit NIE übersprungen — nur der Schlüssel ist bekannt.
 * In Produktion greift er nicht: dort ist SHOPIFY_FAKE nicht gesetzt.
 */
export const PROXY_FAKE_SECRET = 'reparatur-proxy-attrappe'

export type ProxyPruefung =
  | { ok: true }
  | {
      ok: false
      grund: 'kein_schluessel' | 'signatur_fehlt' | 'signatur_falsch' | 'zeitstempel' | 'shop'
    }

type Env = Record<string, string | undefined>

/**
 * Der HMAC-Schlüssel des App Proxy: das Client Secret DER App, an der der
 * Proxy hängt. Empfohlen ist eine eigene kleine App nur mit
 * `write_app_proxy` (Entscheidungslog 2026-10-01, „Eigene Shopify-App für
 * den App Proxy") — dann steht ihr Secret in SHOPIFY_PROXY_SECRET. Hängt der
 * Proxy an der KRNL-App selbst, gilt deren SHOPIFY_CLIENT_SECRET. Leer =
 * keine Prüfung möglich → der Aufrufer weist ab.
 */
export function proxySchluessel(env: Env = process.env): string {
  const secret = env.SHOPIFY_PROXY_SECRET?.trim() || env.SHOPIFY_CLIENT_SECRET?.trim() || ''
  if (secret) return secret
  return env.SHOPIFY_FAKE === '1' ? PROXY_FAKE_SECRET : ''
}

/** Die signierte Nachricht — exportiert, damit der Test sie gegen Shopifys Beispiel halten kann. */
export function proxyNachricht(params: URLSearchParams): string {
  const schluessel = [...new Set(params.keys())].filter((k) => k !== 'signature')
  return schluessel
    .map((k) => `${k}=${params.getAll(k).join(',')}`)
    .sort()
    .join('')
}

/** Signatur für Tests und lokale Aufrufe (scripts/shop-proxy-url.ts). */
export function proxySignieren(params: URLSearchParams, secret: string): string {
  return createHmac('sha256', secret).update(proxyNachricht(params), 'utf8').digest('hex')
}

export function proxySignaturPruefen(
  params: URLSearchParams,
  secret: string,
  jetzt: number = Date.now(),
  erwarteterShop: string | undefined = process.env.SHOPIFY_SHOP_DOMAIN,
): ProxyPruefung {
  if (!secret) return { ok: false, grund: 'kein_schluessel' }

  const erhalten = params.get('signature')?.trim().toLowerCase() ?? ''
  if (!erhalten) return { ok: false, grund: 'signatur_fehlt' }

  const erwartet = Buffer.from(proxySignieren(params, secret), 'utf8')
  const empfangen = Buffer.from(erhalten, 'utf8')
  // Längenprüfung vor timingSafeEqual, das bei ungleicher Länge wirft.
  if (erwartet.length !== empfangen.length || !timingSafeEqual(erwartet, empfangen)) {
    return { ok: false, grund: 'signatur_falsch' }
  }

  // Erst nach der Signatur: ungeprüfte Werte sind nichts wert.
  const zeitstempel = Number(params.get('timestamp'))
  if (
    !Number.isFinite(zeitstempel) ||
    Math.abs(jetzt / 1000 - zeitstempel) > PROXY_ZEITFENSTER_SEKUNDEN
  ) {
    return { ok: false, grund: 'zeitstempel' }
  }

  const shop = erwarteterShop?.trim().toLowerCase()
  if (shop && (params.get('shop') ?? '').trim().toLowerCase() !== shop) {
    return { ok: false, grund: 'shop' }
  }

  return { ok: true }
}
