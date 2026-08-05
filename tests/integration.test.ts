import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { splitStreet } from '../src/modules/shared/address.ts'
import { signWebhookBody, verifyWebhookHmac } from '../src/modules/integrationen/shopify-hmac.ts'
import { productForCountry, toAlpha3, trackingUrl } from '../src/modules/versand/dhl-codes.ts'

describe('Adressaufteilung für DHL', () => {
  test('trennt die deutsche Schreibweise', () => {
    assert.deepEqual(splitStreet('Musterstraße 12'), { street: 'Musterstraße', houseNumber: '12' })
    assert.deepEqual(splitStreet('Musterstr. 12a'), { street: 'Musterstr.', houseNumber: '12a' })
    assert.deepEqual(splitStreet('Am Hang 3-5'), { street: 'Am Hang', houseNumber: '3-5' })
    assert.deepEqual(splitStreet('Lange Reihe 7 b'), { street: 'Lange Reihe', houseNumber: '7b' })
  })

  test('erkennt die Hausnummer am Anfang', () => {
    assert.deepEqual(splitStreet('12 Rue de la Paix'), {
      street: 'Rue de la Paix',
      houseNumber: '12',
    })
  })

  test('lässt Adressen ohne Hausnummer unverändert', () => {
    assert.deepEqual(splitStreet('Postfach'), { street: 'Postfach', houseNumber: '' })
    assert.deepEqual(splitStreet(null), { street: '', houseNumber: '' })
    assert.deepEqual(splitStreet('  '), { street: '', houseNumber: '' })
  })
})

describe('Shopify-Webhook-Signatur', () => {
  const secret = 'geheimes-client-secret'
  const body = JSON.stringify({ id: 12345, name: '#1001' })

  test('akzeptiert eine gültige Signatur', () => {
    assert.equal(verifyWebhookHmac(body, signWebhookBody(body, secret), secret), true)
  })

  test('weist eine verfälschte Nutzlast ab', () => {
    const signature = signWebhookBody(body, secret)
    const tampered = JSON.stringify({ id: 12345, name: '#9999' })
    assert.equal(verifyWebhookHmac(tampered, signature, secret), false)
  })

  test('weist ein falsches Secret ab', () => {
    assert.equal(verifyWebhookHmac(body, signWebhookBody(body, 'anderes'), secret), false)
  })

  test('weist fehlende Angaben ab', () => {
    assert.equal(verifyWebhookHmac(body, null, secret), false)
    assert.equal(verifyWebhookHmac(body, signWebhookBody(body, secret), undefined), false)
  })

  test('stürzt bei unsinnigen Signaturen nicht ab', () => {
    assert.equal(verifyWebhookHmac(body, 'kein-base64!!', secret), false)
    assert.equal(verifyWebhookHmac(body, 'YWJj', secret), false) // zu kurz
  })
})

describe('DHL-Hilfen', () => {
  test('wandelt Ländercodes in alpha-3', () => {
    assert.equal(toAlpha3('DE'), 'DEU')
    assert.equal(toAlpha3('at'), 'AUT')
    assert.equal(toAlpha3('DEU'), 'DEU')
    assert.equal(toAlpha3(''), 'DEU') // Rückfall auf Inland
  })

  test('wählt das Produkt nach Zielland', () => {
    assert.equal(productForCountry('DE'), 'V01PAK')
    assert.equal(productForCountry('AT'), 'V54EPAK')
    assert.equal(productForCountry('US'), 'V53WPAK')
  })

  test('baut die Tracking-URL', () => {
    assert.match(trackingUrl('00340434161094042557'), /piececode=00340434161094042557/)
  })
})
