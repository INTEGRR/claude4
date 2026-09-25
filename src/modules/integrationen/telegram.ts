/**
 * Telegram-Bot als Betriebskanal (Entscheidungslog 2026-09-25): Anmeldungen,
 * Fehlversuche, endgültig fehlgeschlagene Jobs und Dienststörungen gehen als
 * Nachricht an den Chat des Betreibers.
 *
 * Bewusst ohne Datenbank- und App-Importe: Umgebung und fetch kommen als
 * Parameter, damit Versand und Antwortauswertung unter blankem Node testbar
 * sind. Protokolliert wird NICHT hier, sondern beim Aufrufer
 * (benachrichtigungen.ts schreibt api_transactions mit system 'telegram').
 *
 *   TELEGRAM_BOT_TOKEN   Token vom @BotFather
 *   TELEGRAM_CHAT_ID     Ziel-Chat (privat oder Gruppe); ermitteln über
 *                        Einstellungen → Benachrichtigungen → „Chat-IDs ermitteln"
 *   TELEGRAM_FAKE=1      nichts senden, Erfolg melden (Tests, lokal)
 */

type Env = Record<string, string | undefined>
type FetchFn = typeof fetch

export const TELEGRAM_API = 'https://api.telegram.org'
export const TELEGRAM_ZEITLIMIT_MS = 8000
/** Telegram nimmt 4096 Zeichen je Nachricht — wir kürzen vorher. */
export const TELEGRAM_MAX_ZEICHEN = 3800

export function telegramConfigured(env: Env = process.env): boolean {
  return env.TELEGRAM_FAKE === '1' || Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
}

export interface TelegramErgebnis {
  ok: boolean
  status: number | null
  fehler: string | null
  /** Fake-Betrieb: nichts gesendet, Erfolg gemeldet. */
  fake: boolean
  dauerMs: number
}

/** HTML-Parse-Modus: Nutzertext (Namen, E-Mails, Fehler) maskieren. */
export function telegramSicher(wert: unknown): string {
  return String(wert ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Sendet eine Nachricht (HTML-Parse-Modus) an den konfigurierten Chat.
 * Wirft nicht — das Ergebnis trägt Status und Fehlertext, der Aufrufer
 * entscheidet über Wiederholung.
 */
export async function telegramSenden(
  text: string,
  opts: { env?: Env; fetchFn?: FetchFn } = {},
): Promise<TelegramErgebnis> {
  const env = opts.env ?? process.env
  const start = Date.now()
  if (env.TELEGRAM_FAKE === '1') {
    return { ok: true, status: 200, fehler: null, fake: true, dauerMs: 0 }
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return {
      ok: false,
      status: null,
      fehler: 'Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)',
      fake: false,
      dauerMs: 0,
    }
  }
  const fetchFn = opts.fetchFn ?? fetch
  const gekuerzt =
    text.length > TELEGRAM_MAX_ZEICHEN ? `${text.slice(0, TELEGRAM_MAX_ZEICHEN)}…` : text
  try {
    const res = await fetchFn(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: gekuerzt,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_ZEITLIMIT_MS),
    })
    const dauerMs = Date.now() - start
    if (res.ok) return { ok: true, status: res.status, fehler: null, fake: false, dauerMs }
    let beschreibung = ''
    try {
      const body = (await res.json()) as { description?: string }
      beschreibung = body.description ?? ''
    } catch {
      // Antwort ohne JSON — der Status reicht.
    }
    return {
      ok: false,
      status: res.status,
      fehler: `Telegram antwortet ${res.status}${beschreibung ? `: ${beschreibung}` : ''}`,
      fake: false,
      dauerMs,
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      fehler: err instanceof Error ? err.message : String(err),
      fake: false,
      dauerMs: Date.now() - start,
    }
  }
}

export interface TelegramChat {
  id: string
  titel: string
  art: string
}

/**
 * Hilfe beim Einrichten: getUpdates liefert die Chats, die dem Bot zuletzt
 * geschrieben haben — daraus liest der Betreiber seine TELEGRAM_CHAT_ID ab.
 * (Der Bot muss vorher im Chat angeschrieben bzw. in die Gruppe geholt sein.)
 */
export async function telegramChatsFinden(
  opts: { env?: Env; fetchFn?: FetchFn } = {},
): Promise<TelegramChat[]> {
  const env = opts.env ?? process.env
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN fehlt')
  const fetchFn = opts.fetchFn ?? fetch
  const res = await fetchFn(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`, {
    signal: AbortSignal.timeout(TELEGRAM_ZEITLIMIT_MS),
  })
  if (!res.ok) throw new Error(`Telegram antwortet ${res.status} — Token prüfen`)
  const body = (await res.json()) as {
    result?: {
      message?: { chat?: { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string } }
      my_chat_member?: { chat?: { id: number; type: string; title?: string; username?: string; first_name?: string } }
    }[]
  }
  const chats = new Map<string, TelegramChat>()
  for (const update of body.result ?? []) {
    const chat = update.message?.chat ?? update.my_chat_member?.chat
    if (!chat) continue
    const titel =
      chat.title ??
      [chat.first_name, (chat as { last_name?: string }).last_name].filter(Boolean).join(' ') ??
      chat.username ??
      ''
    chats.set(String(chat.id), { id: String(chat.id), titel: titel || (chat.username ?? ''), art: chat.type })
  }
  return [...chats.values()]
}
