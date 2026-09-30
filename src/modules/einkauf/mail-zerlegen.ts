import type { GmailTeil } from '../google/gmail.ts'

/**
 * Mails zerlegen (0093), pur und app-frei: aus der Gmail-Nutzlast
 * (multipart-Baum, base64url) werden Absender, Empfänger, Betreff, Datum,
 * Text/HTML und Anhänge. Zeichensätze kommen aus dem Content-Type — auch
 * GBK/GB2312/Big5 chinesischer Lieferanten. Dazu das Zerlegen
 * weitergeleiteter Mails (Tino leitet Alt-Threads an das Einkaufspostfach
 * weiter): der ursprüngliche Absender steht im Weiterleitungskopf.
 */

export interface Adresse {
  email: string
  name: string | null
}

export interface MailAnhang {
  dateiname: string
  mime: string
  groesse: number | null
  attachmentId: string
}

export interface ZerlegteMail {
  von: Adresse | null
  an: string[]
  cc: string[]
  betreff: string
  datum: Date | null
  rfc822Id: string | null
  inReplyTo: string | null
  text: string
  html: string | null
  anhaenge: MailAnhang[]
}

/** RFC 2047 („=?UTF-8?B?…?=", „=?GBK?Q?…?=") — bereits dekodierte Werte bleiben, wie sie sind. */
export function kopfDekodieren(wert: string): string {
  return wert
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_ganz, charset: string, art: string, inhalt: string) => {
      try {
        const bytes =
          art.toUpperCase() === 'B'
            ? Buffer.from(inhalt, 'base64')
            : Buffer.from(
                inhalt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
                'latin1',
              )
        return new TextDecoder(charset.toLowerCase()).decode(bytes)
      } catch {
        return inhalt
      }
    })
}

/** „Name <a@b>, c@d, "Nach, Name" <e@f>" → Adressen (Kleinschreibung der E-Mail). */
export function adressenLesen(kopf: string | null | undefined): Adresse[] {
  if (!kopf) return []
  const teile: string[] = []
  let aktuell = ''
  let inAnf = false
  let inWinkel = false
  for (const z of kopfDekodieren(kopf)) {
    if (z === '"') inAnf = !inAnf
    if (z === '<') inWinkel = true
    if (z === '>') inWinkel = false
    if (z === ',' && !inAnf && !inWinkel) {
      teile.push(aktuell)
      aktuell = ''
    } else aktuell += z
  }
  teile.push(aktuell)
  return teile
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = t.match(/^(.*?)<([^>]+)>\s*$/)
      if (m) {
        const name = m[1].trim().replace(/^"|"$/g, '').trim()
        return { email: m[2].trim().toLowerCase(), name: name || null }
      }
      return { email: t.replace(/^mailto:/i, '').trim().toLowerCase(), name: null }
    })
    .filter((a) => a.email.includes('@'))
}

function kopf(teil: GmailTeil | undefined, name: string): string | null {
  const h = teil?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h ? h.value : null
}

function charsetAus(teil: GmailTeil): string {
  const ct = kopf(teil, 'Content-Type') ?? ''
  const m = ct.match(/charset="?([^";\s]+)"?/i)
  const cs = (m?.[1] ?? 'utf-8').toLowerCase()
  return cs === 'gb2312' ? 'gbk' : cs
}

function inhaltDekodieren(teil: GmailTeil): string {
  const data = teil.body?.data
  if (!data) return ''
  const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  try {
    return new TextDecoder(charsetAus(teil)).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** HTML grob als Text — für Vorschau, Suche und den Agenten; die Anzeige bleibt HTML. */
export function htmlZuText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sammeln(teil: GmailTeil, text: string[], html: string[], anhaenge: MailAnhang[]) {
  const mime = (teil.mimeType ?? '').toLowerCase()
  const dispo = (kopf(teil, 'Content-Disposition') ?? '').toLowerCase()
  if (teil.filename && (teil.body?.attachmentId || dispo.startsWith('attachment'))) {
    if (teil.body?.attachmentId) {
      anhaenge.push({
        dateiname: kopfDekodieren(teil.filename),
        mime: mime || 'application/octet-stream',
        groesse: teil.body?.size ?? null,
        attachmentId: teil.body.attachmentId,
      })
    }
    return
  }
  if (teil.parts?.length) {
    for (const t of teil.parts) sammeln(t, text, html, anhaenge)
    return
  }
  if (mime === 'text/plain') text.push(inhaltDekodieren(teil))
  else if (mime === 'text/html') html.push(inhaltDekodieren(teil))
}

export function mailZerlegen(payload: GmailTeil | undefined, internalDate?: string): ZerlegteMail {
  const text: string[] = []
  const html: string[] = []
  const anhaenge: MailAnhang[] = []
  if (payload) sammeln(payload, text, html, anhaenge)
  const datumKopf = kopf(payload, 'Date')
  const datum = datumKopf && !Number.isNaN(Date.parse(datumKopf))
    ? new Date(datumKopf)
    : internalDate
      ? new Date(Number(internalDate))
      : null
  const htmlText = html.join('\n')
  return {
    von: adressenLesen(kopf(payload, 'From'))[0] ?? null,
    an: adressenLesen(kopf(payload, 'To')).map((a) => a.email),
    cc: adressenLesen(kopf(payload, 'Cc')).map((a) => a.email),
    betreff: kopfDekodieren(kopf(payload, 'Subject') ?? '').trim(),
    datum,
    rfc822Id: kopf(payload, 'Message-ID') ?? kopf(payload, 'Message-Id'),
    inReplyTo: kopf(payload, 'In-Reply-To'),
    text: text.join('\n').trim() || (htmlText ? htmlZuText(htmlText) : ''),
    html: htmlText || null,
    anhaenge,
  }
}

const MARKER =
  /^[-\s>]*(?:-{3,}\s*)?(?:forwarded message|weitergeleitete nachricht|ursprüngliche nachricht|original message|begin forwarded message|anfang der weitergeleiteten nachricht)[:\s-]*$/i
const FELD = /^[>\s]*(from|von|date|datum|gesendet|sent|subject|betreff|to|an|cc)\s*:\s*(.*)$/i

export interface Weiterleitung {
  von: Adresse
  datum: string | null
  betreff: string | null
  text: string
}

/**
 * Weiterleitungskopf erkennen (Gmail, Outlook, Apple Mail; deutsch und
 * englisch) und den ursprünglichen Absender samt Text herauslösen.
 * Kein Kopf gefunden → null (dann ist es keine Weiterleitung).
 */
export function weiterleitungZerlegen(text: string): Weiterleitung | null {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n')
  let start = zeilen.findIndex((z) => MARKER.test(z.trim()))
  start = start >= 0 ? start + 1 : zeilen.slice(0, 40).findIndex((z) => /^[>\s]*(from|von)\s*:/i.test(z))
  if (start < 0) return null
  const felder: Record<string, string> = {}
  let i = start
  while (i < zeilen.length && zeilen[i].trim() === '') i++
  for (; i < zeilen.length; i++) {
    const z = zeilen[i]
    if (z.trim() === '') break
    const m = z.match(FELD)
    if (!m) {
      if (Object.keys(felder).length === 0) return null
      break
    }
    const schluessel = m[1].toLowerCase()
    const norm =
      schluessel === 'von' ? 'from'
      : schluessel === 'datum' || schluessel === 'gesendet' || schluessel === 'sent' ? 'date'
      : schluessel === 'betreff' ? 'subject'
      : schluessel === 'an' ? 'to'
      : schluessel
    felder[norm] ??= m[2].trim()
  }
  const von = adressenLesen(felder.from?.replace(/\[mailto:([^\]]+)\]/i, '<$1>'))[0]
  if (!von) return null
  return {
    von,
    datum: felder.date ?? null,
    betreff: felder.subject ?? null,
    text: zeilen.slice(i).join('\n').replace(/^\n+/, '').trim(),
  }
}

const PRAEFIX = /^\s*(?:\[\d+\]\s*)?(?:re|aw|antw|fw|fwd|wg|sv|vs|回复|答复|转发)\s*(?:\[\d+\])?\s*[:：]\s*/i

/** Betreff ohne „Re:/AW:/Fwd:/WG:/回复:"-Ketten — der Kern, unter dem ein Thread steht. */
export function betreffKern(betreff: string): string {
  let s = betreff.trim()
  for (let i = 0; i < 10 && PRAEFIX.test(s); i++) s = s.replace(PRAEFIX, '')
  return s.trim()
}

const MONATE: Record<string, string> = {
  januar: 'Jan', jan: 'Jan', februar: 'Feb', feb: 'Feb', märz: 'Mar', maerz: 'Mar', mär: 'Mar',
  april: 'Apr', apr: 'Apr', mai: 'May', juni: 'Jun', jun: 'Jun', juli: 'Jul', jul: 'Jul',
  august: 'Aug', aug: 'Aug', september: 'Sep', sep: 'Sep', sept: 'Sep', oktober: 'Oct', okt: 'Oct',
  november: 'Nov', nov: 'Nov', dezember: 'Dec', dez: 'Dec',
}

/**
 * Datum aus einem Weiterleitungskopf: „Mon, Mar 3, 2025 at 10:15 AM" (Gmail),
 * „Montag, 3. März 2025 10:15" (Outlook deutsch), „3. März 2025 um 10:15"
 * (Apple Mail) oder RFC 2822. Unlesbar → null.
 */
export function kopfDatumLesen(roh: string | null | undefined): Date | null {
  if (!roh) return null
  const direkt = Date.parse(roh)
  if (!Number.isNaN(direkt)) return new Date(direkt)
  let s = roh
    .replace(/^[A-Za-zÄÖÜäöü]+\.?,\s*/, '')
    .replace(/\s(?:at|um)\s/gi, ' ')
    .replace(/\sUhr\b/i, '')
    .replace(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\.?\s+(\d{4})/, (_m, t: string, mon: string, j: string) => {
      const en = MONATE[mon.toLowerCase()]
      return en ? `${t} ${en} ${j}` : _m
    })
    .replace(/(\d{1,2})\.(\d{1,2})\.(\d{4})/, (_m, t: string, mo: string, j: string) => `${j}-${mo.padStart(2, '0')}-${t.padStart(2, '0')}`)
  s = s.replace(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/, '$1T$2')
  const zweit = Date.parse(s)
  return Number.isNaN(zweit) ? null : new Date(zweit)
}

const ZITAT_BEGINN = [
  /^On .{4,200}wrote:\s*$/i,
  /^Am .{4,200}schrieb.{0,200}:\s*$/i,
  /^在.{2,120}写道[:：]\s*$/,
  /^-{2,}\s*(?:original message|ursprüngliche nachricht|forwarded message|weitergeleitete nachricht|原始邮件|回复的原邮件)\s*-{0,}\s*$/i,
  /^_{10,}\s*$/,
  /^(?:from|von|发件人|寄件者)\s*[:：].+$/i,
]

/**
 * Antwort und Zitat trennen: Lieferanten zitieren bei jeder Antwort den
 * ganzen Verlauf. Die Ansicht zeigt das Neue und klappt das Zitat ein —
 * erkannt an „On … wrote:", „Am … schrieb", „在 … 写道：", Outlook-Trennern,
 * chinesischen Köpfen („发件人:") oder einem Block aus „>"-Zeilen. Kein Zitat → alles neu.
 */
export function zitatTrennen(text: string): { neu: string; zitat: string | null } {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 1; i < zeilen.length; i++) {
    const z = zeilen[i].trim()
    const kopf = ZITAT_BEGINN.some((m) => m.test(z))
    // „Von:"/„From:" zählt nur als Zitatkopf, wenn gleich danach weitere Kopfzeilen folgen.
    const echterKopf =
      kopf && (!/^(?:from|von|发件人|寄件者)\s*[:：]/i.test(z) || /^(?:sent|date|gesendet|datum|发送时间|to|an|收件人)\s*[:：]/i.test(zeilen[i + 1]?.trim() ?? ''))
    const zitatBlock = z.startsWith('>') && zeilen.slice(i).filter((x) => x.trim() !== '').every((x) => x.trim().startsWith('>'))
    if (echterKopf || zitatBlock) {
      const neu = zeilen.slice(0, i).join('\n').trim()
      if (!neu) return { neu: text.trim(), zitat: null }
      return { neu, zitat: zeilen.slice(i).join('\n').trim() }
    }
  }
  return { neu: text.trim(), zitat: null }
}
