/**
 * TOTP (RFC 6238) und Base32 — reine Rechnerei, geprüft gegen die
 * Testvektoren aus RFC 6238 Anhang B (SHA1, Geheimnis „12345678901234567890";
 * dort acht Stellen, hier die letzten sechs).
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  backupCodesErzeugen,
  base32Decode,
  base32Encode,
  codeNormalisieren,
  geheimnisErzeugen,
  geheimnisFormatieren,
  hotp,
  istTotpCode,
  otpauthUrl,
  totp,
  totpPruefen,
  totpSchritt,
} from '../src/modules/auth/totp.ts'

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

describe('TOTP', () => {
  test('Base32: Roundtrip und RFC-4648-Beispiele', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
    assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar')
    assert.equal(base32Decode('mzxw 6ytb-oi======').toString(), 'foobar', 'tolerant gegen Gruppen und Padding')
    for (let n = 0; n < 40; n++) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256))
      assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, `Roundtrip bei ${n} Bytes`)
    }
    assert.throws(() => base32Decode('MZXW6YTB0I'), /Ungültiges Base32-Zeichen/)
  })

  test('RFC 6238 Anhang B: die SHA1-Vektoren (letzte sechs Stellen)', () => {
    const vektoren: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [sekunden, erwartet] of vektoren) {
      assert.equal(totp(RFC_SECRET, sekunden * 1000), erwartet, `T=${sekunden}`)
    }
    assert.equal(hotp(base32Decode(RFC_SECRET), 1), '287082', 'Schritt 1 = T zwischen 30 und 59 s')
    assert.equal(totpSchritt(59_000), 1)
  })

  test('Prüfung: Fenster ±1 Schritt, sonst falsch', () => {
    const jetzt = 1234567890 * 1000
    const code = totp(RFC_SECRET, jetzt)
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt }), totpSchritt(jetzt))
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt + 30_000 }), totpSchritt(jetzt), 'ein Schritt später noch gültig')
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt - 30_000 }), totpSchritt(jetzt), 'ein Schritt früher (Uhr geht vor)')
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt + 60_000 }), null, 'zwei Schritte später abgelaufen')
    assert.equal(totpPruefen(RFC_SECRET, '000000', { zeitMs: jetzt }), null)
    assert.equal(totpPruefen(RFC_SECRET, '12345', { zeitMs: jetzt }), null, 'fünf Stellen sind kein Code')
    assert.equal(totpPruefen(RFC_SECRET, 'abcdef', { zeitMs: jetzt }), null)
    assert.equal(totpPruefen(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { zeitMs: jetzt }), totpSchritt(jetzt), 'Leerzeichen sind erlaubt')
  })

  test('Replay: ein verbrauchter oder älterer Schritt geht nicht mehr durch', () => {
    const jetzt = 1234567890 * 1000
    const schritt = totpSchritt(jetzt)
    const code = totp(RFC_SECRET, jetzt)
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt, letzterSchritt: schritt }), null, 'derselbe Code ein zweites Mal')
    assert.equal(totpPruefen(RFC_SECRET, code, { zeitMs: jetzt, letzterSchritt: schritt - 1 }), schritt, 'nach einem älteren Schritt erlaubt')
    const vorher = totp(RFC_SECRET, jetzt - 30_000)
    assert.equal(totpPruefen(RFC_SECRET, vorher, { zeitMs: jetzt, letzterSchritt: schritt }), null, 'älterer Code nach einem neueren')
  })

  test('otpauth-URL trägt Label, Aussteller und Parameter', () => {
    const url = otpauthUrl('max@example.com', 'KRNL ANVIL GmbH', 'JBSWY3DPEHPK3PXP')
    assert.equal(
      url,
      'otpauth://totp/KRNL%20ANVIL%20GmbH%3Amax%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=KRNL%20ANVIL%20GmbH&algorithm=SHA1&digits=6&period=30',
    )
    assert.equal(geheimnisFormatieren('JBSWY3DPEHPK3PXP'), 'JBSW Y3DP EHPK 3PXP')
  })

  test('Geheimnis und Backup-Codes: Länge, Alphabet, keine Dubletten', () => {
    const geheimnis = geheimnisErzeugen()
    assert.match(geheimnis, /^[A-Z2-7]{32}$/, '20 Bytes → 32 Base32-Zeichen')
    assert.equal(base32Decode(geheimnis).length, 20)
    assert.notEqual(geheimnisErzeugen(), geheimnis)

    const codes = backupCodesErzeugen(10)
    assert.equal(codes.length, 10)
    assert.equal(new Set(codes).size, 10)
    for (const c of codes) assert.match(c, /^[a-hj-kmnp-z2-9]{4}-[a-hj-kmnp-z2-9]{4}$/, c)
    assert.equal(codeNormalisieren(' AbCd-EfGh '), 'abcdefgh')
    assert.equal(istTotpCode('123 456'), true)
    assert.equal(istTotpCode('abcd-efgh'), false)
  })
})
