import { createHash, timingSafeEqual } from 'node:crypto'
import {
  type Track17Eintrag,
  webhookSignatur,
} from './track17-logik'

/**
 * 17TRACK Tracking API v2.2 — ein Dienst für alle Carrier des Zulaufs
 * (0112, Entscheidungslog 2026-10-15). Drei Aufrufe: Nummer anmelden
 * (kostet Kontingent, einmal je Sendung), Stand abfragen (Stapel bis 40),
 * Kontingent lesen (Wächter). Statuswechsel schiebt 17TRACK per Webhook
 * (/api/webhooks/17track) — der stündliche Abruf ist das Sicherheitsnetz.
 *
 * Security Key = API-Key: Header `17token` bei Aufrufen, Salz der
 * Webhook-Signatur. Im Fake-Betrieb (TRACK17_FAKE=1, Prozesstests)
 * antwortet track17-fake.ts deterministisch.
 */

export const TRACK17_BASE = 'https://api.17track.net/track/v2.2'

export function track17Config(): { base: string; apiKey: string } {
  const fake = process.env.TRACK17_FAKE === '1'
  return {
    base: process.env.TRACK17_API_BASE ?? TRACK17_BASE,
    apiKey: process.env.TRACK17_API_KEY?.trim() || (fake ? 'fake-17track-key' : ''),
  }
}

export function track17Konfiguriert(): boolean {
  return process.env.TRACK17_FAKE === '1' || Boolean(process.env.TRACK17_API_KEY?.trim())
}

/** Fehlende Pflichtvariablen — nur die Namen, nie Werte (Muster dhlFehlendeVariablen). */
export function track17FehlendeVariablen(): string[] {
  if (process.env.TRACK17_FAKE === '1') return []
  return process.env.TRACK17_API_KEY?.trim() ? [] : ['TRACK17_API_KEY']
}

export class Track17Error extends Error {
  readonly status?: number
  readonly code?: number
  constructor(message: string, status?: number, code?: number) {
    super(message)
    this.name = 'Track17Error'
    this.status = status
    this.code = code
  }
}

export interface Angemeldet {
  number: string
  carrier: number | null
}
export interface Abgelehnt {
  number: string
  carrier: number | null
  code: number | null
  message: string | null
}

export interface Kontingent {
  quota_total: number
  quota_used: number
  quota_remain: number
  today_used: number
  max_track_daily: number
}

interface Antwort<T> {
  code?: number
  data?: T
  message?: string
}

async function protokoll(t: {
  kind: string
  reference?: string | null
  request?: unknown
  response?: unknown
  ok: boolean
  statusCode?: number | null
  error?: string | null
  durationMs?: number
}) {
  const { logTransaction } = await import('../integrationen/transaktionen')
  await logTransaction({ system: 'track17', ...t })
}

async function aufruf<T>(pfad: string, body: unknown, reference: string | null): Promise<T> {
  const c = track17Config()
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(`${c.base}${pfad}`, {
      method: 'POST',
      headers: { '17token': c.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    await protokoll({ kind: pfad.slice(1), reference, request: body, ok: false, error: text, durationMs: Date.now() - start })
    throw new Track17Error(`17TRACK nicht erreichbar: ${text}`)
  }
  const json = (await res.json().catch(() => ({}))) as Antwort<T>
  const ok = res.ok && (json.code ?? 0) === 0
  await protokoll({
    kind: pfad.slice(1),
    reference,
    request: body,
    response: json,
    ok,
    statusCode: res.status,
    error: ok ? null : json.message ?? `HTTP ${res.status}`,
    durationMs: Date.now() - start,
  })
  if (res.status === 429) throw new Track17Error('17TRACK-Limit erreicht (3 Aufrufe je Sekunde)', 429)
  if (res.status === 401 || res.status === 403) throw new Track17Error('17TRACK lehnt den API-Key ab', res.status)
  if (!res.ok) throw new Track17Error(`17TRACK antwortet ${res.status}`, res.status)
  if ((json.code ?? 0) !== 0) throw new Track17Error(json.message ?? `17TRACK-Fehler ${json.code}`, res.status, json.code)
  return json.data as T
}

type AnmeldeAntwort = {
  accepted?: { number: string; carrier?: number | null }[]
  rejected?: { number: string; carrier?: number | null; error?: { code?: number; message?: string } | null }[]
}

/** Nummern anmelden (bis 40). Carrier null = 17TRACK erkennt ihn selbst. */
export async function nummernAnmelden(
  eintraege: { nummer: string; carrier: number | null; tag?: string }[],
): Promise<{ angemeldet: Angemeldet[]; abgelehnt: Abgelehnt[] }> {
  if (eintraege.length === 0) return { angemeldet: [], abgelehnt: [] }
  if (process.env.TRACK17_FAKE === '1') {
    return (await import('./track17-fake')).fakeNummernAnmelden(eintraege)
  }
  // lang „de": Carrier mit offizieller deutscher Sprache (DHL, DPD, …)
  // liefern ihre Ereignisse auf Deutsch — die Texte, die auch die
  // DHL-Seite zeigt. Andere bleiben in ihrer Standardsprache.
  const body = eintraege.map((e) => ({
    number: e.nummer,
    lang: 'de',
    ...(e.carrier ? { carrier: e.carrier } : { auto_detection: true }),
    ...(e.tag ? { tag: e.tag.slice(0, 100) } : {}),
  }))
  const data = await aufruf<AnmeldeAntwort>('/register', body, eintraege.map((e) => e.nummer).join(','))
  return {
    angemeldet: (data.accepted ?? []).map((a) => ({ number: a.number, carrier: a.carrier ?? null })),
    abgelehnt: (data.rejected ?? []).map((r) => ({
      number: r.number,
      carrier: r.carrier ?? null,
      code: r.error?.code ?? null,
      message: r.error?.message ?? null,
    })),
  }
}

type StandAntwort = {
  accepted?: Track17Eintrag[]
  rejected?: { number: string; error?: { code?: number; message?: string } | null }[]
}

/** Stand je Nummer (bis 40). Nicht angemeldete Nummern fehlen im Ergebnis. */
export async function staendeAbfragen(
  eintraege: { nummer: string; carrier: number | null }[],
): Promise<Map<string, Track17Eintrag>> {
  if (eintraege.length === 0) return new Map()
  if (process.env.TRACK17_FAKE === '1') {
    return (await import('./track17-fake')).fakeStaendeAbfragen(eintraege)
  }
  const body = eintraege.map((e) => ({ number: e.nummer, ...(e.carrier ? { carrier: e.carrier } : {}) }))
  const data = await aufruf<StandAntwort>('/gettrackinfo', body, eintraege.map((e) => e.nummer).join(','))
  return new Map((data.accepted ?? []).map((a) => [a.number, a]))
}

/** Kontingent — für den Dienste-Wächter und die Schnittstellen-Seite. */
export async function kontingentLesen(): Promise<Kontingent> {
  if (process.env.TRACK17_FAKE === '1') {
    return (await import('./track17-fake')).fakeKontingent()
  }
  return aufruf<Kontingent>('/getquota', {}, null)
}

/** Webhook-Signatur prüfen (Header `sign` = SHA-256 hex von „<Rohtext>/<Key>"). */
export function webhookSignaturPruefen(roh: string, sign: string | null): boolean {
  const key = track17Config().apiKey
  if (!key || !sign) return false
  const erwartet = webhookSignatur(roh, key, (s) => createHash('sha256').update(s, 'utf8').digest('hex'))
  const a = Buffer.from(erwartet.toLowerCase())
  const b = Buffer.from(sign.trim().toLowerCase())
  return a.length === b.length && timingSafeEqual(a, b)
}
