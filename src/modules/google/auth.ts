import { createSign } from 'node:crypto'

/**
 * Google-Anbindung (0092): Anmeldung als Dienstkonto per signiertem JWT
 * (RS256, node:crypto) — ohne googleapis-Abhängigkeit, Muster wie die
 * Odoo-Anbindung. Zwei Wege (Entscheidungslog 2026-09-30):
 *
 *   * Drive OHNE Delegation: das Dienstkonto ist Inhaltsmanager der
 *     geteilten Ablage „Einkauf" und legt dort selbst an.
 *   * Gmail MIT domänenweiter Delegation (`sub` = Einkaufspostfach, nur
 *     Scope gmail.modify) — ab Stufe 2.
 *
 * Env: GOOGLE_DIENSTKONTO_JSON (Schlüsseldatei als JSON oder Base64),
 * GOOGLE_EINKAUF_ABLAGE_ID (ID der geteilten Ablage), EINKAUF_POSTFACH.
 * GOOGLE_FAKE=1 ersetzt Google durch eine Attrappe (Tests, Staging).
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'

export interface Dienstkonto {
  client_email: string
  private_key: string
  token_uri?: string
}

type Env = Record<string, string | undefined>

export function googleFake(env: Env = process.env): boolean {
  return env.GOOGLE_FAKE === '1'
}

/** Schlüsseldatei aus der Umgebung — als JSON oder Base64-kodiertes JSON. */
export function dienstkontoLesen(env: Env = process.env): Dienstkonto | null {
  const roh = env.GOOGLE_DIENSTKONTO_JSON?.trim()
  if (!roh) return null
  const text = roh.startsWith('{') ? roh : Buffer.from(roh, 'base64').toString('utf8')
  try {
    const konto = JSON.parse(text) as Partial<Dienstkonto>
    if (!konto.client_email || !konto.private_key) return null
    return { client_email: konto.client_email, private_key: konto.private_key, token_uri: konto.token_uri }
  } catch {
    return null
  }
}

/** Drive-Ablage nutzbar (Attrappe zählt). */
export function driveKonfiguriert(env: Env = process.env): boolean {
  if (googleFake(env)) return true
  return Boolean(dienstkontoLesen(env) && env.GOOGLE_EINKAUF_ABLAGE_ID)
}

/** Einkaufspostfach nutzbar (Stufe 2). */
export function postfachKonfiguriert(env: Env = process.env): boolean {
  if (googleFake(env)) return true
  return Boolean(dienstkontoLesen(env) && env.EINKAUF_POSTFACH)
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** Das signierte Assertion-JWT für den Token-Tausch — pur, testbar. */
export function jwtBauen(konto: Dienstkonto, scope: string, sub?: string, jetzt = Date.now()): string {
  const iat = Math.floor(jetzt / 1000)
  const kopf = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const inhalt = b64url(
    JSON.stringify({
      iss: konto.client_email,
      scope,
      aud: konto.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
      ...(sub ? { sub } : {}),
    }),
  )
  const signierer = createSign('RSA-SHA256')
  signierer.update(`${kopf}.${inhalt}`)
  return `${kopf}.${inhalt}.${b64url(signierer.sign(konto.private_key))}`
}

const cache = new Map<string, { token: string; bis: number }>()

/** Zugriffstoken je (Scope, Postfach) — eine Stunde gültig, mit Vorlauf erneuert. */
export async function zugriffstoken(scope: string, sub?: string): Promise<string> {
  const schluessel = `${scope}|${sub ?? ''}`
  const treffer = cache.get(schluessel)
  if (treffer && treffer.bis > Date.now() + 60_000) return treffer.token
  const konto = dienstkontoLesen()
  if (!konto) throw new Error('Google ist nicht angebunden — GOOGLE_DIENSTKONTO_JSON setzen')
  const res = await fetch(konto.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwtBauen(konto, scope, sub),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const antwort = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !antwort.access_token) {
    throw new Error(
      `Google-Anmeldung abgelehnt (${antwort.error ?? res.status}${antwort.error_description ? `: ${antwort.error_description}` : ''}) — Dienstkonto und Freigaben prüfen`,
    )
  }
  cache.set(schluessel, { token: antwort.access_token, bis: Date.now() + (antwort.expires_in ?? 3600) * 1000 })
  return antwort.access_token
}
