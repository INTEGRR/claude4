/** Verschlüsselung ruhender Geheimnisse (AES-256-GCM) — auth/geheimnis.ts. */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  alteSchluessel,
  entschluesseln,
  entschluesselnMitRueckfall,
  schluesselAusUmgebung,
  verschluesseln,
} from '../src/modules/auth/geheimnis.ts'

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

  test('Schlüsselwechsel ohne Neueinrichtung: alte Schlüssel lesen noch, melden „veraltet"', () => {
    const alt = verschluesseln('JBSWY3DPEHPK3PXP', schluesselAusUmgebung({ SESSION_SECRET: 'sitzung' }))
    // ZWEIFAKTOR_SCHLUESSEL kam später dazu — SESSION_SECRET gilt beim Lesen weiter.
    const env = { ZWEIFAKTOR_SCHLUESSEL: 'eigen', SESSION_SECRET: 'sitzung' }
    assert.deepEqual(entschluesselnMitRueckfall(alt, env), { klartext: 'JBSWY3DPEHPK3PXP', veraltet: true })
    const neu = verschluesseln('JBSWY3DPEHPK3PXP', schluesselAusUmgebung(env))
    assert.deepEqual(entschluesselnMitRueckfall(neu, env), { klartext: 'JBSWY3DPEHPK3PXP', veraltet: false })
    // Rotation des eigenen Schlüssels über ZWEIFAKTOR_SCHLUESSEL_ALT.
    const rotiert = { ZWEIFAKTOR_SCHLUESSEL: 'eigen-2', ZWEIFAKTOR_SCHLUESSEL_ALT: 'eigen' }
    assert.equal(entschluesselnMitRueckfall(neu, rotiert).veraltet, true)
    // Ohne passenden Schlüssel bleibt es laut.
    assert.throws(() => entschluesselnMitRueckfall(alt, { ZWEIFAKTOR_SCHLUESSEL: 'fremd' }))
  })

  test('alte Schlüssel: nur wenn sie vom aktuellen abweichen', () => {
    assert.equal(alteSchluessel({ SESSION_SECRET: 's' }).length, 0, 'nur SESSION_SECRET: keiner')
    assert.equal(alteSchluessel({ ZWEIFAKTOR_SCHLUESSEL: 'z', SESSION_SECRET: 's' }).length, 1)
    assert.equal(alteSchluessel({ ZWEIFAKTOR_SCHLUESSEL: 's', SESSION_SECRET: 's' }).length, 0, 'gleicher Wert')
    assert.equal(alteSchluessel({ ZWEIFAKTOR_SCHLUESSEL: 'z', ZWEIFAKTOR_SCHLUESSEL_ALT: 'a', SESSION_SECRET: 's' }).length, 2)
  })
})
