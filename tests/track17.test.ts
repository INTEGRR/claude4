import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BEREITS_ANGEMELDET,
  carrierCode,
  registrierungWiederholen,
  registrierungsFehlerText,
  standText,
  statusAusTrack17,
  subStatusText,
  trackStandLesen,
  verfolgungAktiv,
  webhookSignatur,
  zeitKurz,
} from '../src/modules/versand/track17-logik.ts'
import { LABELS, tone } from '../src/modules/shared/format.ts'

/**
 * Zulauf-Sendungsverfolgung über 17TRACK (0112): der pure Teil — Carrier-
 * Zuordnung, Statusabbildung, Lesen der Antwort, Signatur. Der Ablauf mit
 * Datenbank, Job und Webhook steht in tests/prozesse/zulauf-verfolgung.test.ts.
 */

describe('17TRACK: Carrier-Zuordnung', () => {
  test('bekannte Namen, Groß/Klein, Zusätze — sonst automatisch erkennen', () => {
    assert.equal(carrierCode('DHL'), 7041)
    assert.equal(carrierCode('dhl paket'), 7041)
    assert.equal(carrierCode('DHL Express'), 100001)
    assert.equal(carrierCode('DHL Freight'), 100245)
    assert.equal(carrierCode('K+N'), 100164)
    assert.equal(carrierCode('Kühne + Nagel'), 100164)
    assert.equal(carrierCode('Kurier: FedEx'), 100003)
    assert.equal(carrierCode('UPS Standard'), 100002)
    assert.equal(carrierCode('Maersk Line'), 100768)
    assert.equal(carrierCode('Spedition Müller'), null)
    assert.equal(carrierCode(''), null)
    assert.equal(carrierCode(null), null)
  })
})

describe('17TRACK: Status', () => {
  test('die neun Hauptstatus und Endzustände', () => {
    assert.equal(statusAusTrack17('InTransit'), 'unterwegs')
    assert.equal(statusAusTrack17('Delivered'), 'zugestellt')
    assert.equal(statusAusTrack17('Exception'), 'problem')
    assert.equal(statusAusTrack17('OutForDelivery'), 'in_zustellung')
    assert.equal(statusAusTrack17('NotFound'), 'nicht_gefunden')
    assert.equal(statusAusTrack17(null), 'nicht_gefunden')
    assert.equal(statusAusTrack17('Unbekannt'), 'nicht_gefunden')
    assert.equal(verfolgungAktiv('unterwegs'), true)
    assert.equal(verfolgungAktiv('zugestellt'), false)
    assert.equal(verfolgungAktiv('abgelaufen'), false)
    assert.equal(verfolgungAktiv('nicht_verfolgbar'), false)
  })

  test('Unterstatus nur, wo er dem Lager etwas sagt', () => {
    assert.equal(subStatusText('InTransit_CustomsProcessing'), 'in der Zollabfertigung')
    assert.equal(subStatusText('InTransit_Other'), null)
    assert.equal(subStatusText(null), null)
  })

  test('jeder Status hat ein Schild und einen Ton', () => {
    for (const status of Object.keys(LABELS.sendungsverfolgung)) {
      // „Vorgemerkt" ist bewusst tonlos: noch keine Aussage über die Sendung.
      if (status === 'vorgemerkt') continue
      assert.notEqual(tone(status), 'neutral', `${status} braucht einen Ton`)
    }
    assert.equal(verfolgungAktiv('vorgemerkt'), true, 'vorgemerkt bleibt aktiv — wartet auf „Verfolgen"')
    assert.equal(tone('zugestellt'), 'success')
    assert.equal(tone('problem'), 'danger')
    assert.equal(tone('unterwegs'), 'info')
    assert.equal(tone('nicht_gefunden'), 'warn')
  })
})

describe('17TRACK: Antwort lesen', () => {
  const EINTRAG = {
    number: 'JJD014600003000123455',
    carrier: 7041,
    track_info: {
      latest_status: { status: 'InTransit', sub_status: 'InTransit_CustomsProcessing' },
      latest_event: {
        time_iso: '2026-10-14T22:10:00+02:00',
        description: 'Shipment is in customs',
        description_translation: { description: 'Sendung in der Zollabfertigung' },
        location: 'Leipzig',
      },
      tracking: {
        providers: [
          {
            provider: { key: 7041, name: 'DHL Paket' },
            events: [
              { time_iso: '2026-10-14T22:10:00+02:00', description: 'Shipment is in customs', location: 'Leipzig' },
              { time_utc: '2026-10-13T06:00:00Z', description: 'Picked up', location: 'Shenzhen' },
            ],
          },
        ],
      },
    },
  }

  test('Status, Unterstatus, Carrier, Ereignisse — Übersetzung vor Original', () => {
    const s = trackStandLesen(EINTRAG)
    assert.equal(s.status, 'unterwegs')
    assert.equal(s.subStatus, 'InTransit_CustomsProcessing')
    assert.equal(s.carrierCode, 7041)
    assert.equal(s.carrierName, 'DHL Paket')
    assert.deepEqual(s.letztesEreignis, { zeit: '2026-10-14T22:10:00+02:00', text: 'Sendung in der Zollabfertigung', ort: 'Leipzig' })
    assert.equal(s.ereignisse.length, 2)
    assert.equal(s.ereignisse[1].zeit, '2026-10-13T06:00:00Z')
    assert.equal(
      standText(s),
      'Unterwegs (in der Zollabfertigung) — Leipzig, 14.10. 22:10: Sendung in der Zollabfertigung',
    )
  })

  test('nicht gefunden: ohne Ereignis, Text bleibt lesbar', () => {
    const s = trackStandLesen({ number: 'X', track_info: { latest_status: { status: 'NotFound' }, latest_event: null } })
    assert.equal(s.status, 'nicht_gefunden')
    assert.equal(s.letztesEreignis, null)
    assert.equal(standText(s), 'Noch nicht im Tracking')
  })

  test('zeitKurz', () => {
    assert.equal(zeitKurz('2026-10-14T22:10:00+02:00'), '14.10. 22:10')
    assert.equal(zeitKurz('2026-10-14'), '14.10.')
    assert.equal(zeitKurz('gestern'), 'gestern')
  })
})

describe('17TRACK: Anmeldung und Signatur', () => {
  test('Fehlertexte, Wiederholung, „bereits angemeldet"', () => {
    assert.match(registrierungsFehlerText(-18019903), /Carrier nicht erkennbar/)
    assert.match(registrierungsFehlerText(-18019908), /Kontingent/)
    assert.equal(registrierungsFehlerText(null, 'Irgendwas'), 'Irgendwas')
    assert.equal(registrierungWiederholen(-18019907), true)
    assert.equal(registrierungWiederholen(-18019903), false)
    assert.equal(BEREITS_ANGEMELDET, -18019901)
  })

  test('Webhook-Signatur = SHA-256(„<Rohtext>/<Key>")', () => {
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
    const roh = '{"event":"TRACKING_UPDATED"}'
    assert.equal(webhookSignatur(roh, '123456ABCDEF', sha), sha(`${roh}/123456ABCDEF`))
    assert.notEqual(webhookSignatur(roh, 'anderer', sha), webhookSignatur(roh, '123456ABCDEF', sha))
  })
})
