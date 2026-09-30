import { GMAIL_SCOPE, googleFake, zugriffstoken } from './auth.ts'

/**
 * Gmail über REST (0093) — handelt im Namen des Einkaufspostfachs
 * (EINKAUF_POSTFACH, domänenweite Delegation nur mit gmail.modify). Nur das
 * Nötige für den Abgleich: Profil (Start-Cursor), Verlauf seit Cursor,
 * Nachricht vollständig, Anhang. Senden kommt mit Stufe 2b. Echte Anbindung
 * und Attrappe (google-fake-gmail.ts) teilen die Schnittstelle.
 */

export interface GmailTeil {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailTeil[]
}

export interface GmailNachricht {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailTeil
}

export class VerlaufAbgelaufen extends Error {}

export interface GmailApi {
  profil(): Promise<{ emailAddress: string; historyId: string }>
  /** Neue Nachrichten seit dem Cursor; wirft VerlaufAbgelaufen, wenn Google ihn nicht mehr kennt. */
  verlauf(startHistoryId: string, pageToken?: string): Promise<{ ids: string[]; historyId: string; weiter?: string }>
  liste(q: string, pageToken?: string): Promise<{ ids: string[]; weiter?: string }>
  nachricht(id: string): Promise<GmailNachricht>
  anhang(messageId: string, attachmentId: string): Promise<Uint8Array>
}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

function postfach(): string {
  const p = process.env.EINKAUF_POSTFACH
  if (!p) throw new Error('Einkaufspostfach fehlt — EINKAUF_POSTFACH setzen')
  return p
}

async function anfrage(pfad: string, art: string): Promise<Response> {
  const token = await zugriffstoken(GMAIL_SCOPE, postfach())
  const res = await fetch(`${API}${pfad}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404 && art === 'gmail.verlauf') throw new VerlaufAbgelaufen('Verlauf abgelaufen')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const { logTransaction } = await import('../integrationen/transaktionen.ts')
    await logTransaction({ system: 'google', kind: art, ok: false, statusCode: res.status, error: text.slice(0, 300) })
    throw new Error(`Gmail (${art}): ${res.status} ${text.slice(0, 200)}`)
  }
  return res
}

/** base64url → Bytes (Gmail kodiert Inhalte und Anhänge so). */
export function base64urlBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

const echtesPostfach: GmailApi = {
  async profil() {
    const res = await anfrage('/profile', 'gmail.profil')
    return (await res.json()) as { emailAddress: string; historyId: string }
  },

  async verlauf(startHistoryId, pageToken) {
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '100' })
    if (pageToken) q.set('pageToken', pageToken)
    const res = await anfrage(`/history?${q}`, 'gmail.verlauf')
    const daten = (await res.json()) as {
      history?: { messagesAdded?: { message: { id: string } }[] }[]
      historyId: string
      nextPageToken?: string
    }
    const ids = (daten.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id))
    return { ids: [...new Set(ids)], historyId: daten.historyId, weiter: daten.nextPageToken }
  },

  async liste(q, pageToken) {
    const p = new URLSearchParams({ q, maxResults: '100' })
    if (pageToken) p.set('pageToken', pageToken)
    const res = await anfrage(`/messages?${p}`, 'gmail.liste')
    const daten = (await res.json()) as { messages?: { id: string }[]; nextPageToken?: string }
    return { ids: (daten.messages ?? []).map((m) => m.id), weiter: daten.nextPageToken }
  },

  async nachricht(id) {
    const res = await anfrage(`/messages/${encodeURIComponent(id)}?format=full`, 'gmail.nachricht')
    return (await res.json()) as GmailNachricht
  },

  async anhang(messageId, attachmentId) {
    const res = await anfrage(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      'gmail.anhang',
    )
    const daten = (await res.json()) as { data: string }
    return base64urlBytes(daten.data)
  },
}

/** Das Postfach — echt oder Attrappe, je nach GOOGLE_FAKE. */
export async function gmail(): Promise<GmailApi> {
  if (googleFake()) {
    const { fakeGmail } = await import('./google-fake-gmail.ts')
    return fakeGmail
  }
  return echtesPostfach
}
