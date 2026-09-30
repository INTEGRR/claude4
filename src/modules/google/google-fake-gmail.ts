import { randomUUID } from 'node:crypto'
import type { GmailApi, GmailNachricht, GmailTeil } from './gmail.ts'
import { VerlaufAbgelaufen } from './gmail.ts'

/**
 * Gmail-Attrappe (GOOGLE_FAKE=1): ein Postfach im Speicher mit Verlaufs-
 * Cursor wie bei Google. Tests und der lokale Browsertest liefern Mails mit
 * `fakeMailEinliefern` ein — im Rohformat der Gmail-API (multipart, base64url),
 * damit die Zerlegung genau so läuft wie gegen das echte Postfach.
 */

interface FakePostfach {
  nachrichten: Map<string, GmailNachricht & { historyId: number }>
  anhaenge: Map<string, Buffer>
  historyId: number
  /** Verläufe älter als dieser Cursor gelten als abgelaufen (Test des Rückfalls). */
  aeltesterCursor: number
}

const postfach = (): FakePostfach => {
  const g = globalThis as unknown as { __krnlGmailFake?: FakePostfach }
  g.__krnlGmailFake ??= { nachrichten: new Map(), anhaenge: new Map(), historyId: 1000, aeltesterCursor: 0 }
  return g.__krnlGmailFake
}

export function fakeGmailLeeren(): void {
  const p = postfach()
  p.nachrichten.clear()
  p.anhaenge.clear()
  p.historyId = 1000
  p.aeltesterCursor = 0
}

/** Für den Rückfall-Test: alles vor dem aktuellen Stand gilt als abgelaufen. */
export function fakeVerlaufVerfallen(): void {
  postfach().aeltesterCursor = postfach().historyId + 1
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export interface FakeMail {
  threadId?: string
  von: string
  an?: string
  cc?: string
  betreff: string
  text?: string
  html?: string
  /** 'SENT' für Mails, die das Postfach selbst verschickt hat. */
  labels?: string[]
  messageIdHeader?: string
  inReplyTo?: string
  datum?: Date
  anhaenge?: { name: string; mime: string; bytes: Buffer }[]
  /** Zeichensatz des Textteils (z. B. 'gbk' für chinesische Mails). */
  charset?: string
  textBytes?: Buffer
}

/** Liefert eine Mail ins Postfach ein; gibt Nachrichten- und Thread-ID zurück. */
export function fakeMailEinliefern(m: FakeMail): { id: string; threadId: string } {
  const p = postfach()
  const id = `fake-msg-${randomUUID()}`
  const threadId = m.threadId ?? `fake-thread-${randomUUID()}`
  const kopf = [
    { name: 'From', value: m.von },
    { name: 'To', value: m.an ?? 'einkauf@anvil.example' },
    ...(m.cc ? [{ name: 'Cc', value: m.cc }] : []),
    { name: 'Subject', value: m.betreff },
    { name: 'Date', value: (m.datum ?? new Date()).toUTCString() },
    { name: 'Message-ID', value: m.messageIdHeader ?? `<${id}@fake.mail>` },
    ...(m.inReplyTo ? [{ name: 'In-Reply-To', value: m.inReplyTo }] : []),
  ]
  const teile: GmailTeil[] = []
  if (m.text !== undefined || m.textBytes) {
    teile.push({
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: `text/plain; charset="${m.charset ?? 'UTF-8'}"` }],
      body: { data: b64url(m.textBytes ?? Buffer.from(m.text ?? '', 'utf8')) },
    })
  }
  if (m.html !== undefined) {
    teile.push({
      mimeType: 'text/html',
      headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
      body: { data: b64url(m.html) },
    })
  }
  const alternativ: GmailTeil = { mimeType: 'multipart/alternative', parts: teile }
  const anhangTeile: GmailTeil[] = (m.anhaenge ?? []).map((a) => {
    const attachmentId = `fake-att-${randomUUID()}`
    p.anhaenge.set(attachmentId, a.bytes)
    return {
      mimeType: a.mime,
      filename: a.name,
      headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }],
      body: { size: a.bytes.byteLength, attachmentId },
    }
  })
  p.historyId += 1
  p.nachrichten.set(id, {
    id,
    threadId,
    labelIds: m.labels ?? ['INBOX'],
    internalDate: String((m.datum ?? new Date()).getTime()),
    payload: {
      mimeType: 'multipart/mixed',
      headers: kopf,
      parts: [alternativ, ...anhangTeile],
    },
    historyId: p.historyId,
  })
  return { id, threadId }
}

export const fakeGmail: GmailApi = {
  async profil() {
    return { emailAddress: process.env.EINKAUF_POSTFACH ?? 'einkauf@anvil.example', historyId: String(postfach().historyId) }
  },

  async verlauf(startHistoryId) {
    const p = postfach()
    const start = Number(startHistoryId)
    if (start < p.aeltesterCursor) throw new VerlaufAbgelaufen('Verlauf abgelaufen')
    const ids = [...p.nachrichten.values()].filter((n) => n.historyId > start).map((n) => n.id)
    return { ids, historyId: String(p.historyId) }
  },

  async liste() {
    return { ids: [...postfach().nachrichten.keys()] }
  },

  async nachricht(id) {
    const n = postfach().nachrichten.get(id)
    if (!n) throw new Error(`Gmail (gmail.nachricht): 404 ${id}`)
    const { historyId: _h, ...rest } = n
    return rest
  },

  async anhang(_messageId, attachmentId) {
    const a = postfach().anhaenge.get(attachmentId)
    if (!a) throw new Error(`Gmail (gmail.anhang): 404 ${attachmentId}`)
    return new Uint8Array(a)
  },
}
