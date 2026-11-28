/**
 * Absender auf dem Versandlabel (Entscheidungslog 2026-11-28): das Lager,
 * wenn es nicht am Firmensitz liegt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { versandAbsender } from '../src/modules/versand/absender.ts'

const SITZ = { name: 'ANVIL GmbH', street: 'Am Sitz', house: '1', zip: '10115', city: 'Berlin', country: 'DEU', phone: '030 1' }

test('ohne Versandabsender bleibt es beim Firmensitz', () => {
  assert.deepEqual(versandAbsender(SITZ), SITZ)
  assert.deepEqual(versandAbsender({ ...SITZ, versand_street: '', versand_zip: '', versand_city: '' }).street, 'Am Sitz')
})

test('mit Versandabsender steht das Lager auf dem Label — Land, Telefon und Name bleiben', () => {
  const a = versandAbsender({ ...SITZ, versand_street: 'Hallenweg', versand_house: '7a', versand_zip: '32457', versand_city: 'Porta Westfalica' })
  assert.deepEqual(
    [a.name, a.street, a.house, a.zip, a.city, a.country, a.phone],
    ['ANVIL GmbH', 'Hallenweg', '7a', '32457', 'Porta Westfalica', 'DEU', '030 1'],
  )
})

test('eigener Name auf dem Label, wenn gesetzt', () => {
  const a = versandAbsender({ ...SITZ, versand_name: 'ANVIL Logistik', versand_street: 'Hallenweg', versand_zip: '32457', versand_city: 'Porta Westfalica' })
  assert.equal(a.name, 'ANVIL Logistik')
  assert.equal(a.house, '', 'ohne Hausnummer bleibt sie leer — nie die des Firmensitzes')
})

test('eine halbe Adresse wird nie mit dem Firmensitz gemischt', () => {
  for (const halb of [
    { versand_street: 'Hallenweg' },
    { versand_street: 'Hallenweg', versand_zip: '32457' },
    { versand_zip: '32457', versand_city: 'Porta Westfalica' },
  ]) {
    const a = versandAbsender({ ...SITZ, ...halb })
    assert.deepEqual([a.street, a.house, a.zip, a.city], ['Am Sitz', '1', '10115', 'Berlin'])
  }
})
