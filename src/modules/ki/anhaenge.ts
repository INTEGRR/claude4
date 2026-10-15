import type Anthropic from '@anthropic-ai/sdk'

/**
 * Anhänge im KI-Chat (Bilder und PDFs): Belege wie Commercial Invoices,
 * Pro-forma-Rechnungen oder Fotos eines Lieferscheins gehen mit der Frage
 * an das Modell — als Bild- bzw. Dokument-Block vor dem Text, derselbe
 * Aufrufweg wie beim Dokument-Leser des Einkaufs (dokument-lesen.ts).
 *
 * Bewusst DB- und App-frei (nur Typen aus dem SDK), damit Prüfung und
 * Blockbau unter blankem Node testbar sind (tests/ki-anhaenge.test.ts).
 *
 * Größen: Der Browser verkleinert Bilder vorab (chat.tsx), hier gilt die
 * harte Grenze je Datei und je Anfrage — Vercel nimmt rund 4,5 MB je
 * Anfrage an, base64 bläht um ein Drittel auf.
 */

export const ERLAUBTE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const
export type AnhangMime = (typeof ERLAUBTE_MIME)[number]

/** Rohbytes je Datei (vor base64). */
export const MAX_ANHANG_BYTES = 3 * 1024 * 1024
/** Rohbytes aller Anhänge einer Anfrage zusammen. */
export const MAX_ANFRAGE_BYTES = 4 * 1024 * 1024
export const MAX_ANHAENGE_JE_NACHRICHT = 5

export interface ChatAnhang {
  name: string
  mime: AnhangMime
  /** Inhalt base64 (ohne data:-Präfix). */
  data: string
}

export type Pruefung<T> = { ok: true; wert: T } | { ok: false; fehler: string }

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Rohbytes eines base64-Strings, ohne ihn zu dekodieren. */
export function base64Bytes(data: string): number {
  const polster = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - polster
}

/** Anhänge einer Nachricht aus der Anfrage lesen — alles Unbekannte wird abgewiesen. */
export function anhaengeLesen(roh: unknown): Pruefung<ChatAnhang[]> {
  if (roh === undefined || roh === null) return { ok: true, wert: [] }
  if (!Array.isArray(roh)) return { ok: false, fehler: 'Anhänge müssen eine Liste sein' }
  if (roh.length > MAX_ANHAENGE_JE_NACHRICHT) {
    return { ok: false, fehler: `Höchstens ${MAX_ANHAENGE_JE_NACHRICHT} Anhänge je Nachricht` }
  }
  const liste: ChatAnhang[] = []
  for (const eintrag of roh) {
    const a = eintrag as { name?: unknown; mime?: unknown; data?: unknown }
    if (typeof a?.name !== 'string' || typeof a.mime !== 'string' || typeof a.data !== 'string') {
      return { ok: false, fehler: 'Anhang ohne Name, Typ oder Inhalt' }
    }
    if (!(ERLAUBTE_MIME as readonly string[]).includes(a.mime)) {
      return { ok: false, fehler: `„${a.name}": nur JPEG, PNG, WebP, GIF und PDF sind möglich` }
    }
    const data = a.data.replace(/\s+/g, '')
    if (!data || !BASE64.test(data)) return { ok: false, fehler: `„${a.name}": Inhalt ist kein base64` }
    if (base64Bytes(data) > MAX_ANHANG_BYTES) {
      return { ok: false, fehler: `„${a.name}" ist größer als ${MAX_ANHANG_BYTES / 1024 / 1024} MB` }
    }
    liste.push({ name: a.name.slice(0, 200), mime: a.mime as AnhangMime, data })
  }
  return { ok: true, wert: liste }
}

/** Summe der Rohbytes über alle Nachrichten einer Anfrage. */
export function anhangBytesGesamt(nachrichten: { anhaenge?: ChatAnhang[] }[]): number {
  return nachrichten.reduce(
    (summe, n) => summe + (n.anhaenge ?? []).reduce((s, a) => s + base64Bytes(a.data), 0),
    0,
  )
}

/** Bild- oder Dokument-Block für die Anfrage an das Modell. */
export function anhangBlock(a: ChatAnhang): Anthropic.Messages.ContentBlockParam {
  if (a.mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name }
  }
  return { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }
}

/** Standardtext, wenn jemand nur eine Datei schickt. */
export const NUR_ANHANG_TEXT = 'Bitte werte den Anhang aus und sag, was du darin siehst.'

/**
 * Inhalt einer Benutzer-Nachricht: erst die Anhänge, dann der Text — so
 * bezieht sich die Frage auf das Gesehene. Der Text nennt die Dateinamen,
 * damit das Modell sie in Vorschlägen und Antworten benennen kann.
 */
export function nachrichtInhalt(
  text: string,
  anhaenge: ChatAnhang[] = [],
): string | Anthropic.Messages.ContentBlockParam[] {
  if (anhaenge.length === 0) return text
  const namen = anhaenge.map((a, i) => `[Anhang ${i + 1}: ${a.name}]`).join(' ')
  const klar = text.trim() || NUR_ANHANG_TEXT
  return [...anhaenge.map(anhangBlock), { type: 'text', text: `${namen}\n${klar}` }]
}
