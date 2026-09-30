import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import type { GmailTeil } from '../src/modules/google/gmail.ts'
import { adresseKodieren, antwortKoepfe, kopfKodieren, mimeBauen } from '../src/modules/einkauf/mail-bauen.ts'
import { kopfDekodieren, mailZerlegen } from '../src/modules/einkauf/mail-zerlegen.ts'
import { offenePlatzhalter, spracheErkennen, vorlageFuellen } from '../src/modules/einkauf/mail-vorlagen.ts'

/**
 * Ausgehende Mails (0094) ohne Netz: die gebaute Rohnachricht wird hier
 * zurück in eine Gmail-Nutzlast übersetzt und mit derselben Zerlegung
 * gelesen wie eingehende Post — Hin- und Rückweg müssen deckungsgleich
 * sein (UTF-8/Chinesisch, HTML-Alternative, Anhänge, Thread-Köpfe).
 */

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Mini-Parser: Rohnachricht → GmailTeil (so wie Gmail sie mit format=full liefert). */
function parsen(roh: string): GmailTeil {
  const [kopfRoh, ...rest] = roh.split('\r\n\r\n')
  const koerper = rest.join('\r\n\r\n')
  const headers = kopfRoh
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n')
    .filter(Boolean)
    .map((z) => ({ name: z.slice(0, z.indexOf(':')), value: z.slice(z.indexOf(':') + 1).trim() }))
  const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? 'text/plain'
  const mimeType = ct.split(';')[0].trim().toLowerCase()
  const grenze = ct.match(/boundary="([^"]+)"/)?.[1]
  if (grenze) {
    const teile = koerper
      .split(`--${grenze}`)
      .slice(1, -1)
      .map((t) => t.replace(/^\r\n/, '').replace(/\r\n$/, ''))
    return { mimeType, headers, parts: teile.map(parsen) }
  }
  const disp = headers.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? ''
  const bytes = Buffer.from(koerper.replace(/\r\n/g, ''), 'base64')
  const dateiname = disp.match(/filename\*=UTF-8''([^;]+)/)?.[1]
  const filename = dateiname ? decodeURIComponent(dateiname) : disp.match(/filename="([^"]+)"/)?.[1]
  if (filename) return { mimeType, headers, filename, body: { size: bytes.byteLength, attachmentId: b64url(bytes) } }
  return { mimeType, headers, body: { data: b64url(bytes) } }
}

describe('mimeBauen', () => {
  test('Chinesisch, HTML-Alternative, Anhang mit Umlaut-Dateiname — Rückweg deckungsgleich', () => {
    const pdf = Buffer.from('%PDF-1.4 bestellung', 'utf8')
    const { raw, messageId } = mimeBauen({
      von: 'einkauf@anvil.de',
      vonName: 'ANVIL Einkauf',
      an: ['wei@pcbway.com'],
      cc: ['tino@anvil.de'],
      betreff: 'Re: 报价 PCB rev C — Bestätigung',
      text: '您好 Wei,\n请确认交期。\n\nGrüße\nTino',
      html: '<p>您好 Wei,</p><p>请确认交期。</p>',
      inReplyTo: '<a@pcbway.com>',
      references: ['<x@anvil.de>', '<a@pcbway.com>'],
      anhaenge: [{ dateiname: 'Bestellung P00042 Übersicht.pdf', mime: 'application/pdf', bytes: pdf }],
    })
    assert.match(messageId, /^<krnl\.[0-9a-f-]+@anvil\.de>$/)
    assert.ok(raw.split('\r\n').every((z) => z.length <= 998), 'keine Zeile über 998 Zeichen')
    assert.ok([...raw].every((z) => z.charCodeAt(0) < 128), 'die Rohnachricht ist reines ASCII (alles kodiert)')

    const m = mailZerlegen(parsen(raw))
    assert.deepEqual(m.von, { email: 'einkauf@anvil.de', name: 'ANVIL Einkauf' })
    assert.deepEqual(m.an, ['wei@pcbway.com'])
    assert.deepEqual(m.cc, ['tino@anvil.de'])
    assert.equal(m.betreff, 'Re: 报价 PCB rev C — Bestätigung')
    assert.equal(m.text, '您好 Wei,\n请确认交期。\n\nGrüße\nTino')
    assert.equal(m.html, '<p>您好 Wei,</p><p>请确认交期。</p>')
    assert.equal(m.rfc822Id, messageId)
    assert.equal(m.inReplyTo, '<a@pcbway.com>')
    assert.equal(m.anhaenge.length, 1)
    assert.equal(m.anhaenge[0].dateiname, 'Bestellung P00042 Übersicht.pdf')
    assert.equal(Buffer.from(m.anhaenge[0].attachmentId.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(), pdf.toString())
    assert.match(raw, /\r\nReferences: <x@anvil\.de> <a@pcbway\.com>\r\n/)
  })

  test('nur Text ohne Anhang: einteilige Nachricht', () => {
    const { raw } = mimeBauen({ von: 'a@b.de', an: ['c@d.cn'], betreff: 'Tracking?', text: 'Hi, tracking number please.' })
    assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/)
    assert.equal(mailZerlegen(parsen(raw)).text, 'Hi, tracking number please.')
  })

  test('lange Nicht-ASCII-Köpfe werden in Wörter gestückelt und korrekt zurückgelesen', () => {
    const lang = '关于样品的反馈和下一步的生产安排以及包装要求的确认'.repeat(2)
    const k = kopfKodieren(lang)
    assert.ok(k.split('\r\n').every((z) => z.length < 78))
    assert.equal(kopfDekodieren(k.replace(/\r\n /g, ' ')), lang)
    assert.equal(adresseKodieren('x@y.de', 'Müller, Hans'), '=?UTF-8?B?TcO8bGxlciwgSGFucw==?= <x@y.de>')
    assert.equal(adresseKodieren('x@y.de', 'Tino "T" K'), '"Tino \\"T\\" K" <x@y.de>')
  })
})

describe('antwortKoepfe', () => {
  test('In-Reply-To = letzte, References = alle; Betreff mit einem Re:', () => {
    const r = antwortKoepfe([{ rfc822Id: '<1@a>' }, { rfc822Id: null }, { rfc822Id: '<2@b>' }], 'AW: Re: Quote')
    assert.deepEqual(r, { inReplyTo: '<2@b>', references: ['<1@a>', '<2@b>'], betreff: 'Re: Quote' })
  })

  test('mehr als 20 IDs: die erste bleibt, dann die letzten 19', () => {
    const ids = Array.from({ length: 30 }, (_, i) => ({ rfc822Id: `<${i}@x>` }))
    const r = antwortKoepfe(ids, 'x')
    assert.equal(r.references.length, 20)
    assert.equal(r.references[0], '<0@x>')
    assert.equal(r.references[1], '<11@x>')
  })

  test('ohne Vorgänger (von Hand erfasster Thread): neuer Betreff ohne Re:', () => {
    assert.deepEqual(antwortKoepfe([{ rfc822Id: null }], 'Foam 40x30'), { inReplyTo: null, references: [], betreff: 'Foam 40x30' })
  })
})

describe('Vorlagen und Sprache', () => {
  test('Platzhalter füllen; Fehlendes bleibt sichtbar und wird gemeldet', () => {
    const t = vorlageFuellen('Dear {{ansprechpartner}}, order {{bestellnummer}} — ETA {{liefertermin}}?', {
      ansprechpartner: 'Wei',
      bestellnummer: ' ',
    })
    assert.equal(t, 'Dear Wei, order [bestellnummer] — ETA [liefertermin]?')
    assert.deepEqual(offenePlatzhalter(t), ['bestellnummer', 'liefertermin'])
    assert.deepEqual(offenePlatzhalter('Array [0] bleibt [foo]'), [])
  })

  test('Sprache erkennen: Chinesisch, Deutsch, Englisch, zu kurz', () => {
    assert.equal(spracheErkennen('您好 Tino，样品已经寄出，DHL 1234567890。'), 'zh')
    assert.equal(spracheErkennen('Hallo Wei, bitte senden Sie uns die Rechnung. Vielen Dank und Grüße'), 'de')
    assert.equal(spracheErkennen('Dear Tino, the price is 1.20 USD per piece, lead time 15 days.'), 'en')
    assert.equal(spracheErkennen('ok 123'), null)
  })
})
