/**
 * Welche Umgebungsvariablen jede Anbindung braucht — die Grundlage der
 * Seite Einstellungen → Schnittstellen. Regel (Entscheidungslog 2026-09-26):
 * Zugangsdaten sind Umgebungsvariablen, die Oberfläche zeigt nur, OB sie
 * gesetzt sind — nie ihren Wert.
 *
 * Pur (Umgebung als Parameter), damit unter blankem Node testbar.
 */

type Env = Record<string, string | undefined>

export interface Variable {
  name: string
  /** Pflicht für den Betrieb der Anbindung (sonst optional). */
  pflicht: boolean
  zweck: string
}

export interface Anbindung {
  schluessel: 'shopify' | 'dhl' | 'mail' | 'ki' | 'sprache' | 'telegram' | 'system'
  titel: string
  /** Umgebungsvariable, die die Anbindung durch eine Attrappe ersetzt (Tests, Staging). */
  fake?: string
  variablen: readonly Variable[]
}

export const ANBINDUNGEN: readonly Anbindung[] = [
  {
    schluessel: 'shopify',
    titel: 'Shopify',
    fake: 'SHOPIFY_FAKE',
    variablen: [
      { name: 'SHOPIFY_SHOP_DOMAIN', pflicht: true, zweck: 'die .myshopify.com-Adresse des Shops' },
      { name: 'SHOPIFY_CLIENT_ID', pflicht: true, zweck: 'App im Dev Dashboard → Settings → Credentials' },
      { name: 'SHOPIFY_CLIENT_SECRET', pflicht: true, zweck: 'dazu; das ERP holt und erneuert das Access Token selbst' },
      { name: 'SHOPIFY_WEBHOOK_SECRET', pflicht: false, zweck: 'nur für Webhooks, die über die Shopify-Admin-Seite angelegt wurden' },
      { name: 'SHOPIFY_ADMIN_TOKEN', pflicht: false, zweck: 'nur Alt-Apps mit statischem Token (statt Client ID/Secret)' },
    ],
  },
  {
    schluessel: 'dhl',
    titel: 'DHL Parcel DE',
    fake: 'DHL_FAKE',
    variablen: [
      { name: 'DHL_API_BASE', pflicht: false, zweck: 'Produktion https://api-eu.dhl.com (Standard: Sandbox)' },
      { name: 'DHL_API_KEY', pflicht: true, zweck: 'Key der App im DHL Developer Portal' },
      { name: 'DHL_API_SECRET', pflicht: true, zweck: 'Secret der App' },
      { name: 'DHL_GKP_USER', pflicht: true, zweck: 'Systembenutzer im Geschäftskundenportal (Passwort läuft nach 365 Tagen ab)' },
      { name: 'DHL_GKP_PASSWORD', pflicht: true, zweck: 'dessen Passwort' },
      { name: 'DHL_BILLING_NUMBER', pflicht: true, zweck: '14-stellige Abrechnungsnummer (Paket national)' },
      { name: 'DHL_RETURN_RECEIVER_ID', pflicht: false, zweck: 'Empfänger-ID für Retourenlabels (Standard deu)' },
      { name: 'DHL_TRACKING_USER', pflicht: false, zweck: 'nur für die Tracking-Sandbox' },
    ],
  },
  {
    schluessel: 'mail',
    titel: 'E-Mail (Resend)',
    variablen: [
      { name: 'RESEND_API_KEY', pflicht: true, zweck: 'ohne Schlüssel werden Mails nur protokolliert' },
      { name: 'MAIL_FROM', pflicht: false, zweck: 'Absender, z. B. „Einkauf <einkauf@firma.de>"' },
      { name: 'REPARATUR_MAIL', pflicht: false, zweck: 'Hinweise zu Reparaturanfragen (sonst Firmen-E-Mail)' },
      { name: 'REGISTRIERUNG_MAIL', pflicht: false, zweck: 'Hinweise zu Registrierungen der Startseite' },
    ],
  },
  {
    schluessel: 'ki',
    titel: 'KI (Anthropic)',
    variablen: [{ name: 'ANTHROPIC_API_KEY', pflicht: true, zweck: 'KI-Analyse, Prozess-Aufnahme, Interview' }],
  },
  {
    schluessel: 'sprache',
    titel: 'Sprache (OpenAI)',
    variablen: [{ name: 'OPENAI_API_KEY', pflicht: true, zweck: 'Spracheingabe (Whisper) und Sprachmodus (Realtime)' }],
  },
  {
    schluessel: 'telegram',
    titel: 'Telegram',
    fake: 'TELEGRAM_FAKE',
    variablen: [
      { name: 'TELEGRAM_BOT_TOKEN', pflicht: true, zweck: 'Token vom @BotFather' },
      { name: 'TELEGRAM_CHAT_ID', pflicht: true, zweck: 'Ziel-Chat — über Benachrichtigungen → „Chat-IDs ermitteln"' },
    ],
  },
  {
    schluessel: 'system',
    titel: 'Betrieb',
    variablen: [
      { name: 'CRON_SECRET', pflicht: true, zweck: 'ohne Wert läuft auf Vercel kein einziger Cron' },
      { name: 'SESSION_SECRET', pflicht: true, zweck: 'Salz für Drossel und Backup-Codes' },
      { name: 'ZWEIFAKTOR_SCHLUESSEL', pflicht: false, zweck: 'Schlüssel der TOTP-Geheimnisse (sonst SESSION_SECRET)' },
      { name: 'ERP_PUBLIC_URL', pflicht: false, zweck: 'öffentliche Adresse, vorbelegt für die Webhook-Registrierung' },
    ],
  },
]

export interface VariablenStand extends Variable {
  gesetzt: boolean
}

export interface AnbindungsStand {
  anbindung: Anbindung
  variablen: VariablenStand[]
  fake: boolean
  /** Alle Pflichtvariablen gesetzt (oder Attrappe aktiv). */
  vollstaendig: boolean
  fehlend: string[]
}

export function anbindungsStand(a: Anbindung, env: Env = process.env): AnbindungsStand {
  const variablen = a.variablen.map((v) => ({ ...v, gesetzt: Boolean(env[v.name]?.trim()) }))
  const fake = a.fake ? env[a.fake] === '1' : false
  // Shopify-Sonderfall: statisches Admin-Token ersetzt Client ID/Secret.
  const ersetzt = (name: string) =>
    a.schluessel === 'shopify' &&
    (name === 'SHOPIFY_CLIENT_ID' || name === 'SHOPIFY_CLIENT_SECRET') &&
    Boolean(env.SHOPIFY_ADMIN_TOKEN?.trim())
  const fehlend = variablen.filter((v) => v.pflicht && !v.gesetzt && !ersetzt(v.name)).map((v) => v.name)
  return { anbindung: a, variablen, fake, vollstaendig: fake || fehlend.length === 0, fehlend }
}

export function anbindungZu(schluessel: Anbindung['schluessel']): Anbindung {
  const a = ANBINDUNGEN.find((x) => x.schluessel === schluessel)
  if (!a) throw new Error(`Unbekannte Anbindung ${schluessel}`)
  return a
}
