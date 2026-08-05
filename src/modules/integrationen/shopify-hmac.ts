import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-Prüfung der Shopify-Webhooks — bewusst ohne Server-Abhängigkeiten,
 * damit dieser sicherheitskritische Teil direkt getestet werden kann.
 *
 * Geprüft wird gegen den ROHEN Request-Body: sobald der Body geparst und neu
 * serialisiert wird, stimmt die Signatur nicht mehr.
 */
export function verifyWebhookHmac(
  rawBody: string,
  headerHmac: string | null | undefined,
  secret: string | undefined = process.env.SHOPIFY_WEBHOOK_SECRET,
): boolean {
  if (!secret || !headerHmac) return false

  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest()

  let received: Buffer
  try {
    received = Buffer.from(headerHmac, 'base64')
  } catch {
    return false
  }

  // Längenprüfung vor timingSafeEqual, das bei ungleicher Länge wirft.
  return digest.length === received.length && timingSafeEqual(digest, received)
}

/** Erzeugt eine Signatur — für Tests und lokale Webhook-Simulationen. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
}
