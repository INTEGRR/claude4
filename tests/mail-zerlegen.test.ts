import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import type { GmailTeil } from '../src/modules/google/gmail.ts'
import {
  adressenLesen,
  betreffKern,
  htmlZuText,
  kopfDatumLesen,
  kopfDekodieren,
  mailZerlegen,
  weiterleitungZerlegen,
  zitatTrennen,
} from '../src/modules/einkauf/mail-zerlegen.ts'
import { absenderKennung, istFreemail, mailKennungFehler } from '../src/modules/einkauf/mail-regeln.ts'

/**
 * Mails zerlegen (0093) ohne Netz: Gmail-Nutzlast (multipart, base64url)
 * mit UTF-8 und GBK, HTML-Rückfall, Adresslisten, RFC 2047, Weiterleitungs-
 * köpfe von Gmail/Outlook/Apple Mail (deutsch, englisch) und die Regeln für
 * Freemailer in der Lieferantenakte.
 */

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function teil(mime: string, inhalt: Buffer | string, charset = 'UTF-8'): GmailTeil {
  return {
    mimeType: mime,
    headers: [{ name: 'Content-Type', value: `${mime}; charset="${charset}"` }],
    body: { data: b64url(inhalt) },
  }
}

describe('mailZerlegen', () => {
  test('multipart/mixed mit Text, HTML und Anhang', () => {
    const payload: GmailTeil = {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: '"Li, Wei" <Wei.Li@PCBWay.com>' },
        { name: 'To', value: 'einkauf@anvil.de, tino@anvil.de' },
        { name: 'Cc', value: 'Boss <boss@pcbway.com>' },
        { name: 'Subject', value: 'Re: Quote P00042' },
        { name: 'Date', value: 'Tue, 4 Mar 2025 09:01:02 +0800' },
        { name: 'Message-ID', value: '<abc@pcbway.com>' },
        { name: 'In-Reply-To', value: '<xyz@anvil.de>' },
      ],
      parts: [
        { mimeType: 'multipart/alternative', parts: [teil('text/plain', 'Hallo Tino,\nPreis 0,0034 USD.'), teil('text/html', '<p>Hallo</p>')] },
        {
          mimeType: 'application/pdf',
          filename: 'PI-2025-001.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="PI-2025-001.pdf"' }],
          body: { size: 12345, attachmentId: 'att-1' },
        },
      ],
    }
    const m = mailZerlegen(payload, '0')
    assert.deepEqual(m.von, { email: 'wei.li@pcbway.com', name: 'Li, Wei' })
    assert.deepEqual(m.an, ['einkauf@anvil.de', 'tino@anvil.de'])
    assert.deepEqual(m.cc, ['boss@pcbway.com'])
    assert.equal(m.betreff, 'Re: Quote P00042')
    assert.equal(m.datum?.toISOString(), '2025-03-04T01:01:02.000Z')
    assert.equal(m.rfc822Id, '<abc@pcbway.com>')
    assert.equal(m.inReplyTo, '<xyz@anvil.de>')
    assert.equal(m.text, 'Hallo Tino,\nPreis 0,0034 USD.')
    assert.equal(m.html, '<p>Hallo</p>')
    assert.deepEqual(m.anhaenge, [{ dateiname: 'PI-2025-001.pdf', mime: 'application/pdf', groesse: 12345, attachmentId: 'att-1' }])
  })

  test('GBK/GB2312 chinesischer Lieferanten wird richtig dekodiert', () => {
    const gbk = Buffer.from('c4e3bac3', 'hex') // „你好" in GBK
    const m = mailZerlegen({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=gb2312' }], body: { data: b64url(gbk) } })
    assert.equal(m.text, '你好')
  })

  test('nur HTML → Text als Rückfall, Skripte und Stile fliegen raus', () => {
    const m = mailZerlegen(teil('text/html', '<style>p{}</style><p>Lead time&nbsp;15 days</p><br>MOQ 500<script>x()</script>'))
    assert.equal(m.text, 'Lead time 15 days\n\nMOQ 500')
    assert.equal(htmlZuText('<div>a</div><div>b &amp; c</div>'), 'a\nb & c')
  })

  test('ohne Date-Kopf gilt internalDate', () => {
    const m = mailZerlegen(teil('text/plain', 'x'), '1700000000000')
    assert.equal(m.datum?.getTime(), 1700000000000)
  })
})

describe('Kopfzeilen', () => {
  test('RFC 2047 (Base64 und Quoted-Printable, auch GBK)', () => {
    assert.equal(kopfDekodieren('=?UTF-8?B?w4RuZGVydW5n?='), 'Änderung')
    assert.equal(kopfDekodieren('=?ISO-8859-1?Q?Gr=FC=DFe_aus_M=FCnchen?='), 'Grüße aus München')
    assert.equal(kopfDekodieren('=?GBK?B?xOO6ww==?= =?UTF-8?B?IQ==?='), '你好!')
    assert.equal(kopfDekodieren('schon klar'), 'schon klar')
  })

  test('Adresslisten mit Anführungszeichen, Kommas im Namen und nackten Adressen', () => {
    assert.deepEqual(adressenLesen('"Müller, Hans" <H.Mueller@X.de>, lisa@y.com, <a@b.cn>'), [
      { email: 'h.mueller@x.de', name: 'Müller, Hans' },
      { email: 'lisa@y.com', name: null },
      { email: 'a@b.cn', name: null },
    ])
    assert.deepEqual(adressenLesen('kaputt, auch kaputt'), [])
  })

  test('Betreffkern ohne Re/AW/Fwd/WG/回复-Ketten', () => {
    assert.equal(betreffKern('AW: Re: WG: 回复：Quote PCB v3'), 'Quote PCB v3')
    assert.equal(betreffKern('Fwd: [2] Re: Samples'), 'Samples')
    assert.equal(betreffKern('Rechnung RE-2025-1'), 'Rechnung RE-2025-1')
  })

  test('Datum aus Weiterleitungsköpfen', () => {
    assert.equal(kopfDatumLesen('Mon, Mar 3, 2025 at 10:15 AM')?.getUTCDate(), 3)
    assert.equal(kopfDatumLesen('Montag, 3. März 2025 10:15')?.getUTCMonth(), 2)
    assert.equal(kopfDatumLesen('3. März 2025 um 10:15')?.getUTCFullYear(), 2025)
    assert.equal(kopfDatumLesen('03.03.2025 10:15')?.getUTCHours(), 10)
    assert.equal(kopfDatumLesen('irgendwann'), null)
    assert.equal(kopfDatumLesen(null), null)
  })
})

describe('weiterleitungZerlegen', () => {
  test('Gmail englisch', () => {
    const w = weiterleitungZerlegen(
      'FYI\n\n---------- Forwarded message ---------\nFrom: Wei Li <wei@pcbway.com>\nDate: Mon, Mar 3, 2025 at 10:15 AM\nSubject: Quote PCB v3\nTo: Tino <tino@anvil.de>\n\nDear Tino,\nprice is 1.20 USD.',
    )
    assert.deepEqual(w?.von, { email: 'wei@pcbway.com', name: 'Wei Li' })
    assert.equal(w?.betreff, 'Quote PCB v3')
    assert.equal(w?.datum, 'Mon, Mar 3, 2025 at 10:15 AM')
    assert.equal(w?.text, 'Dear Tino,\nprice is 1.20 USD.')
  })

  test('Gmail deutsch', () => {
    const w = weiterleitungZerlegen(
      '---------- Weitergeleitete Nachricht ---------\nVon: Anna <anna@foam.cn>\nDate: Di., 4. März 2025 um 08:00 Uhr\nSubject: Foam samples\nTo: <tino@anvil.de>\n\nHi',
    )
    assert.equal(w?.von.email, 'anna@foam.cn')
    assert.equal(w?.betreff, 'Foam samples')
  })

  test('Outlook deutsch mit [mailto:]', () => {
    const w = weiterleitungZerlegen(
      'Siehe unten.\n\n-----Ursprüngliche Nachricht-----\nVon: Zhang San [mailto:zhang@cnc-parts.com]\nGesendet: Montag, 3. März 2025 10:15\nAn: Tino\nBetreff: CNC housing rev B\n\nPlease check drawing.',
    )
    assert.deepEqual(w?.von, { email: 'zhang@cnc-parts.com', name: 'Zhang San' })
    assert.equal(w?.datum, 'Montag, 3. März 2025 10:15')
    assert.equal(w?.betreff, 'CNC housing rev B')
    assert.equal(w?.text, 'Please check drawing.')
  })

  test('Apple Mail englisch', () => {
    const w = weiterleitungZerlegen(
      'Begin forwarded message:\n\nFrom: Keycap Factory <sales@keycaps.cn>\nSubject: Dye-sub proof\nDate: 3 March 2025 at 10:15:00 CET\nTo: tino@anvil.de\n\nProof attached.',
    )
    assert.equal(w?.von.email, 'sales@keycaps.cn')
    assert.equal(w?.text, 'Proof attached.')
  })

  test('keine Weiterleitung → null', () => {
    assert.equal(weiterleitungZerlegen('Hallo,\nanbei die Rechnung.\nGruß'), null)
    assert.equal(weiterleitungZerlegen('---------- Forwarded message ---------\nkein Kopf hier'), null)
  })
})

describe('Freemailer in der Lieferantenakte', () => {
  test('Domain oder volle Adresse, Freemail-Domain wird abgewiesen', () => {
    assert.equal(mailKennungFehler('pcbway.com'), null)
    assert.equal(mailKennungFehler('sales123@qq.com'), null)
    assert.match(mailKennungFehler('qq.com') ?? '', /Freemailer/)
    assert.match(mailKennungFehler('kein domain') ?? '', /weder/)
  })

  test('Absenderkennung: Domain, bei Freemailern die Adresse', () => {
    assert.equal(absenderKennung('Wei@PCBWay.com'), 'pcbway.com')
    assert.equal(absenderKennung('Sales123@163.com'), 'sales123@163.com')
    assert.ok(istFreemail('Foxmail.com'))
  })
})

describe('zitatTrennen', () => {
  test('Gmail „On … wrote:" und „>"-Zeilen', () => {
    const r = zitatTrennen('Price is 1.20 USD.\n\nOn Mon, Mar 3, 2025 at 10:15 AM Tino <tino@anvil.de> wrote:\n> Please quote\n> 500 pcs')
    assert.equal(r.neu, 'Price is 1.20 USD.')
    assert.match(r.zitat ?? '', /^On Mon/)
  })

  test('Outlook deutsch und chinesischer Kopf', () => {
    assert.equal(zitatTrennen('Danke!\n\nVon: Wei\nGesendet: Montag\nBetreff: x\n\nalt').neu, 'Danke!')
    assert.equal(zitatTrennen('好的\n\n发件人: Tino\n发送时间: 2025年3月3日\n\n旧').neu, '好的')
  })

  test('„Von:" im Fließtext ist kein Zitat; ohne Zitat bleibt alles neu', () => {
    assert.deepEqual(zitatTrennen('Hallo\nVon: Montag an liefern wir.\nGruß'), { neu: 'Hallo\nVon: Montag an liefern wir.\nGruß', zitat: null })
    assert.deepEqual(zitatTrennen('Nur Text'), { neu: 'Nur Text', zitat: null })
  })
})
