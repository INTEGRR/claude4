import { randomUUID } from 'node:crypto'
import { betreffKern } from './mail-zerlegen.ts'

/**
 * Ausgehende Mails bauen (0094), pur: RFC-5322-Nachricht mit UTF-8
 * (chinesischer Text, Umlaute), Anhängen und den Thread-Köpfen
 * In-Reply-To/References — damit die Antwort beim Lieferanten (QQ, 163,
 * Outlook) und in Gmail im selben Gespräch landet. Gesendet wird sie als
 * `raw` über die Gmail-API (google/gmail.ts).
 */

export interface MailAnhangDaten {
  dateiname: string
  mime: string
  bytes: Uint8Array
}

export interface AusgehendeMail {
  von: string
  vonName?: string | null
  an: string[]
  cc?: string[]
  betreff: string
  text: string
  html?: string | null
  inReplyTo?: string | null
  references?: string[]
  anhaenge?: MailAnhangDaten[]
  messageId?: string
  datum?: Date
}

const CRLF = '\r\n'

const nurAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)

/** RFC 2047 für Köpfe mit Nicht-ASCII (Betreff, Namen) — in Stücken, damit keine Zeile ausufert. */
export function kopfKodieren(wert: string): string {
  if (nurAscii(wert)) return wert
  const teile: string[] = []
  let stueck = ''
  for (const z of wert) {
    // ~45 Bytes Rohtext je Wort → < 76 Zeichen kodiert
    if (Buffer.byteLength(stueck + z, 'utf8') > 45) {
      teile.push(stueck)
      stueck = ''
    }
    stueck += z
  }
  if (stueck) teile.push(stueck)
  return teile.map((t) => `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

export function adresseKodieren(email: string, name?: string | null): string {
  if (!name) return email
  const n = nurAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : kopfKodieren(name)
  return `${n} <${email}>`
}

function base64Zeilen(bytes: Uint8Array | string): string {
  const b64 = Buffer.from(bytes).toString('base64')
  return b64.replace(/.{1,76}/g, (z) => z + CRLF).trimEnd()
}

function dateinameKopf(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  if (nurAscii(name)) return `filename="${ascii}"`
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function grenze(): string {
  return `krnl_${randomUUID().replace(/-/g, '')}`
}

function textTeil(mime: 'text/plain' | 'text/html', inhalt: string): string {
  return [
    `Content-Type: ${mime}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Zeilen(inhalt),
  ].join(CRLF)
}

/** Message-ID in unserer Domain (die des Absenders). */
export function messageIdErzeugen(von: string): string {
  const domain = von.split('@')[1] || 'krnl.local'
  return `<krnl.${randomUUID()}@${domain}>`
}

/** Die vollständige Nachricht (CRLF) — gibt auch die verwendete Message-ID zurück. */
export function mimeBauen(m: AusgehendeMail): { raw: string; messageId: string } {
  const messageId = m.messageId ?? messageIdErzeugen(m.von)
  const koepfe = [
    `From: ${adresseKodieren(m.von, m.vonName)}`,
    `To: ${m.an.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${kopfKodieren(m.betreff)}`,
    `Date: ${(m.datum ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references?.length ? [`References: ${m.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
  ]

  let koerper: string
  let kopfTyp: string
  const alternativ = m.html
    ? (() => {
        const g = grenze()
        return {
          typ: `multipart/alternative; boundary="${g}"`,
          inhalt: [`--${g}`, textTeil('text/plain', m.text), `--${g}`, textTeil('text/html', m.html), `--${g}--`].join(CRLF),
        }
      })()
    : null

  if (m.anhaenge?.length) {
    const g = grenze()
    const erster = alternativ
      ? [`Content-Type: ${alternativ.typ}`, '', alternativ.inhalt].join(CRLF)
      : textTeil('text/plain', m.text)
    const anhaenge = m.anhaenge.map((a) =>
      [
        `Content-Type: ${a.mime || 'application/octet-stream'}; name="${a.dateiname.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"`,
        `Content-Disposition: attachment; ${dateinameKopf(a.dateiname)}`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Zeilen(a.bytes),
      ].join(CRLF),
    )
    kopfTyp = `multipart/mixed; boundary="${g}"`
    koerper = [`--${g}`, erster, ...anhaenge.flatMap((a) => [`--${g}`, a]), `--${g}--`].join(CRLF)
  } else if (alternativ) {
    kopfTyp = alternativ.typ
    koerper = alternativ.inhalt
  } else {
    kopfTyp = 'text/plain; charset="UTF-8"'
    koerper = base64Zeilen(m.text)
    koepfe.push('Content-Transfer-Encoding: base64')
  }
  koepfe.push(`Content-Type: ${kopfTyp}`)
  return { raw: [...koepfe, '', koerper, ''].join(CRLF), messageId }
}

/**
 * Thread-Köpfe einer Antwort: In-Reply-To = letzte Nachricht mit
 * Message-ID, References = alle bisherigen (höchstens 20, die ersten
 * bleiben — so verlangt es RFC 5322 beim Kürzen), Betreff mit „Re:".
 */
export function antwortKoepfe(
  verlauf: { rfc822Id: string | null }[],
  betreff: string,
): { inReplyTo: string | null; references: string[]; betreff: string } {
  const ids = verlauf.map((n) => n.rfc822Id).filter((x): x is string => Boolean(x))
  const references = ids.length > 20 ? [ids[0], ...ids.slice(-19)] : ids
  const kern = betreffKern(betreff)
  return {
    inReplyTo: ids.at(-1) ?? null,
    references,
    betreff: ids.length ? `Re: ${kern}` : kern,
  }
}

/** base64url für das `raw`-Feld der Gmail-API. */
export function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
