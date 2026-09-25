import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import { dhlConfigured, dhlErreichbar } from '@/modules/versand/dhl'
import { druckbrueckeKonfig } from '@/modules/versand/druckbruecke'
import { kiConfigured } from '@/modules/ki/agent'
import { sprechenKonfiguriert } from '@/modules/ki/sprechen'
import { mailConfigured } from './mail'
import { shopifyConfigured, shopifyGraphQL } from './shopify'
import { TELEGRAM_API, TELEGRAM_ZEITLIMIT_MS, telegramConfigured } from './telegram'
import { type Sonde, SONDEN_ZEITLIMIT_MS, datenbankAusfallFaellig, wacheLaufen } from './wache'
import { telegramSenden } from './telegram'
import { zeitFormat } from './benachrichtigungen'

/**
 * Die echten Sonden — jede so klein wie möglich: ein authentifizierter Aufruf,
 * der ohne Zugangsdaten oder ohne Dienst scheitert. Fakes (DHL_FAKE,
 * SHOPIFY_FAKE, TELEGRAM_FAKE) gelten als erreichbar.
 */

const DRUCKBRUECKE_HEARTBEAT_MINUTEN = 15

async function httpOk(url: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SONDEN_ZEITLIMIT_MS) })
  if (!res.ok) throw new Error(`antwortet ${res.status}`)
}

export function standardSonden(): Sonde[] {
  return [
    {
      dienst: 'dhl',
      konfiguriert: dhlConfigured(),
      pruefen: () => dhlErreichbar(),
    },
    {
      dienst: 'shopify',
      konfiguriert: shopifyConfigured(),
      pruefen: async () => {
        // Der Fake kennt keine „shop"-Abfrage — und ist ohnehin erreichbar.
        if (process.env.SHOPIFY_FAKE === '1') return
        await shopifyGraphQL<{ shop: { name: string } }>('{ shop { name } }')
      },
    },
    {
      dienst: 'mail',
      konfiguriert: mailConfigured(),
      pruefen: () =>
        httpOk('https://api.resend.com/domains', {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        }),
    },
    {
      dienst: 'ki',
      konfiguriert: kiConfigured(),
      pruefen: async () => {
        await new Anthropic({ timeout: SONDEN_ZEITLIMIT_MS, maxRetries: 0 }).models.list({ limit: 1 })
      },
    },
    {
      dienst: 'sprache',
      konfiguriert: sprechenKonfiguriert(),
      pruefen: () =>
        httpOk('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        }),
    },
    {
      dienst: 'druckbruecke',
      konfiguriert: false, // wird unten gesetzt (braucht die Datenbank)
      pruefen: async () => {
        const [row] = await sql<{ letzter: string | null }[]>`
          select max(value) as letzter
          from settings, jsonb_each_text(value -> 'agenten')
          where key = 'druckbruecke'`
        if (!row?.letzter) throw new Error('noch kein Agent gemeldet')
        const alter = (Date.now() - new Date(row.letzter).getTime()) / 60_000
        if (alter > DRUCKBRUECKE_HEARTBEAT_MINUTEN) {
          throw new Error(`kein Agent seit ${Math.round(alter)} min (zuletzt ${zeitFormat(row.letzter)})`)
        }
      },
    },
    {
      dienst: 'telegram',
      konfiguriert: telegramConfigured(),
      pruefen: async () => {
        if (process.env.TELEGRAM_FAKE === '1') return
        const res = await fetch(`${TELEGRAM_API}/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, {
          signal: AbortSignal.timeout(TELEGRAM_ZEITLIMIT_MS),
        })
        if (!res.ok) throw new Error(`antwortet ${res.status} — Token prüfen`)
      },
    },
  ]
}

/** Ein Lauf des Wächters mit den echten Sonden (Cron `wache`, Knopf „Jetzt prüfen"). */
export async function wacheAusfuehren() {
  const sonden = standardSonden()
  const druck = await druckbrueckeKonfig()
  const dbSonde = sonden.find((s) => s.dienst === 'druckbruecke')
  if (dbSonde) dbSonde.konfiguriert = druck.modus === 'bruecke' && Boolean(druck.token)
  return wacheLaufen(sql, sonden)
}

/**
 * Die Datenbank selbst antwortet nicht: keine Outbox, kein Zustand —
 * Direktversand mit Zeitfenster-Gatter (siehe datenbankAusfallFaellig).
 */
export async function datenbankAusfallMelden(err: unknown): Promise<boolean> {
  if (!datenbankAusfallFaellig() || !telegramConfigured()) return false
  const text =
    `<b>KRNL</b>\n🔴 <b>Datenbank nicht erreichbar</b> ${zeitFormat()}\n` +
    `${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`
  const r = await telegramSenden(text)
  return r.ok
}
