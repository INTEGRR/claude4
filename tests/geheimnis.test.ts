/** Verschlüsselung ruhender Geheimnisse (AES-256-GCM) — auth/geheimnis.ts. */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { entschluesseln, schluesselAusUmgebung, verschluesseln } from '../src/modules/auth/geheimnis.ts'

describe('Geheimnis', () => {
  const schluessel = schluesselAusUmgebung({ SESSION_SECRET: 'test-geheimnis' })

  test('Roundtrip, jedes Mal ein anderer Blob (zufälliges IV)', () => {
    const a = verschluesseln('JBSWY3DPEHPK3PXP', schluessel)
    const b = verschluesseln('JBSWY3DPEHPK3PXP', schluessel)
    assert.notEqual(a, b)
    assert.match(a, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    assert.equal(entschluesseln(a, schluessel), 'JBSWY3DPEHPK3PXP')
    assert.equal(entschluesseln(b, schluessel), 'JBSWY3DPEHPK3PXP')
    assert.equal(entschluesseln(verschluesseln('', schluessel), schluessel), '', 'leerer Text')
  })

  test('manipulierter Blob und falscher Schlüssel scheitern laut', () => {
    const blob = verschluesseln('geheim', schluessel)
    const [v, iv, tag, ct] = blob.split(':')
    const anders = schluesselAusUmgebung({ ZWEIFAKTOR_SCHLUESSEL: 'x' })
    assert.throws(() => entschluesseln(blob, anders))
    assert.throws(() => entschluesseln([v, iv, tag, ct.slice(0, -2) + 'AA'].join(':'), schluessel))
    assert.throws(() => entschluesseln('v2:a:b:c', schluessel), /Unbekanntes Geheimnisformat/)
  })

  test('ZWEIFAKTOR_SCHLUESSEL geht vor SESSION_SECRET; ohne beides: Fehler statt Standardwert', () => {
    const eigen = schluesselAusUmgebung({ ZWEIFAKTOR_SCHLUESSEL: 'a', SESSION_SECRET: 'b' })
    const nurSitzung = schluesselAusUmgebung({ SESSION_SECRET: 'b' })
    assert.notDeepEqual(eigen, nurSitzung)
    assert.deepEqual(schluesselAusUmgebung({ ZWEIFAKTOR_SCHLUESSEL: 'a' }), eigen)
    assert.throws(() => schluesselAusUmgebung({}), /SESSION_SECRET fehlt/)
  })
})
