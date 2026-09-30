import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import {
  DRIVE_SCOPE,
  GMAIL_SCOPE,
  dienstkontoLesen,
  driveKonfiguriert,
  jwtBauen,
  postfachKonfiguriert,
} from '../src/modules/google/auth.ts'
import { artAusDateiname, ordnerName } from '../src/modules/einkauf/dokument-modelle.ts'

/**
 * Google-Anmeldung (0092) ohne Netz: das Assertion-JWT ist mit dem Schlüssel
 * des Dienstkontos signiert und trägt Scope, Audience und — nur für Gmail —
 * das Postfach als `sub`. Dazu die reinen Helfer der Einkaufsablage.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KONTO = {
  client_email: 'krnl@projekt.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
}

const teil = (jwt: string, i: number) =>
  JSON.parse(Buffer.from(jwt.split('.')[i].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))

describe('Google-Dienstkonto', () => {
  test('JWT ist RS256-signiert und trägt Scope, Audience und Laufzeit', () => {
    const jetzt = Date.UTC(2026, 8, 30, 10, 0, 0)
    const jwt = jwtBauen(KONTO, DRIVE_SCOPE, undefined, jetzt)
    const [kopf, inhalt, signatur] = jwt.split('.')
    assert.deepEqual(teil(jwt, 0), { alg: 'RS256', typ: 'JWT' })
    const daten = teil(jwt, 1)
    assert.equal(daten.iss, KONTO.client_email)
    assert.equal(daten.scope, DRIVE_SCOPE)
    assert.equal(daten.aud, 'https://oauth2.googleapis.com/token')
    assert.equal(daten.exp - daten.iat, 3600)
    assert.equal(daten.sub, undefined, 'Drive läuft ohne Delegation')
    const pruefer = createVerify('RSA-SHA256')
    pruefer.update(`${kopf}.${inhalt}`)
    assert.ok(pruefer.verify(publicKey, Buffer.from(signatur.replace(/-/g, '+').replace(/_/g, '/'), 'base64')))
  })

  test('Gmail-Token handelt im Namen des Einkaufspostfachs (sub)', () => {
    const daten = teil(jwtBauen(KONTO, GMAIL_SCOPE, 'einkauf@anvil.example'), 1)
    assert.equal(daten.sub, 'einkauf@anvil.example')
    assert.equal(daten.scope, GMAIL_SCOPE)
  })

  test('Schlüsseldatei als JSON oder Base64; ohne Pflichtfelder keine Anbindung', () => {
    const json = JSON.stringify({ ...KONTO, type: 'service_account' })
    assert.equal(dienstkontoLesen({ GOOGLE_DIENSTKONTO_JSON: json })?.client_email, KONTO.client_email)
    assert.equal(
      dienstkontoLesen({ GOOGLE_DIENSTKONTO_JSON: Buffer.from(json).toString('base64') })?.client_email,
      KONTO.client_email,
    )
    assert.equal(dienstkontoLesen({ GOOGLE_DIENSTKONTO_JSON: '{"client_email":"x"}' }), null)
    assert.equal(dienstkontoLesen({ GOOGLE_DIENSTKONTO_JSON: 'kaputt' }), null)
    assert.equal(dienstkontoLesen({}), null)
  })

  test('Ablage braucht Konto + Ablage-ID, Postfach braucht Konto + Adresse; Attrappe zählt', () => {
    const json = JSON.stringify(KONTO)
    assert.equal(driveKonfiguriert({ GOOGLE_DIENSTKONTO_JSON: json }), false)
    assert.equal(driveKonfiguriert({ GOOGLE_DIENSTKONTO_JSON: json, GOOGLE_EINKAUF_ABLAGE_ID: '0AB' }), true)
    assert.equal(postfachKonfiguriert({ GOOGLE_DIENSTKONTO_JSON: json }), false)
    assert.equal(postfachKonfiguriert({ GOOGLE_DIENSTKONTO_JSON: json, EINKAUF_POSTFACH: 'einkauf@x.de' }), true)
    assert.equal(driveKonfiguriert({ GOOGLE_FAKE: '1' }), true)
  })
})

describe('Einkaufsablage: Helfer', () => {
  test('Dokumentart aus dem Dateinamen (nur Vorbelegung)', () => {
    assert.equal(artAusDateiname('Gehaeuse_RevB.STEP'), 'step')
    assert.equal(artAusDateiname('PCB_gerber.zip'), 'gerber')
    assert.equal(artAusDateiname('keycaps_legends.ai'), 'ai')
    assert.equal(artAusDateiname('PI-2026-044.pdf'), 'pi')
    assert.equal(artAusDateiname('Commercial Invoice 88.pdf'), 'ci')
    assert.equal(artAusDateiname('packing list.xlsx'), 'packing_list')
    assert.equal(artAusDateiname('Invoice_1234.pdf'), 'rechnung')
    assert.equal(artAusDateiname('BOM native75.xlsx'), 'bom')
    assert.equal(artAusDateiname('Quotation v2.pdf'), 'angebot')
    assert.equal(artAusDateiname('IMG_2031.jpg'), 'foto')
    assert.equal(artAusDateiname('notizen.txt'), 'sonstiges')
  })

  test('Ordnernamen ohne Schrägstriche und gekürzt', () => {
    assert.equal(ordnerName('Shenzhen A/B Tech  Co.'), 'Shenzhen A-B Tech Co.')
    assert.equal(ordnerName('   '), 'Ohne Namen')
    assert.equal(ordnerName('x'.repeat(150)).length, 100)
  })
})
