/**
 * Login-Drossel (0079): Fehlversuche je Konto und Absender sperren die
 * Anmeldung zeitweise — pseudonym, ohne Klartext in der Datenbank.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, withRollback } from './helpers.ts'
import {
  MAX_JE_ABSENDER,
  MAX_JE_KONTO,
  fehlversuchMerken,
  fehlversucheLoeschen,
  kennungHash,
  loginGesperrt,
  loginVersucheAufraeumen,
} from '../src/modules/auth/drossel.ts'

after(closeDb)

describe('Login-Drossel', () => {
  test('der Hash ist pseudonym, stabil und unabhängig von Schreibweise', () => {
    assert.equal(kennungHash('Admin@Example.com ', 'salz'), kennungHash('admin@example.com', 'salz'))
    assert.notEqual(kennungHash('admin@example.com', 'salz'), kennungHash('admin@example.com', 'anderes'))
    assert.doesNotMatch(kennungHash('admin@example.com', 'salz'), /admin|example/)
  })

  test('nach MAX_JE_KONTO Fehlversuchen ist das Konto gesperrt, nach Erfolg wieder frei', async () => {
    await withRollback(async (t) => {
      const konto = kennungHash('drossel-test@example.com', 'test')
      for (let i = 0; i < MAX_JE_KONTO - 1; i++) await fehlversuchMerken(t, konto, 'ip-a')
      assert.equal(await loginGesperrt(t, konto, 'ip-a'), false, 'unter der Grenze noch offen')

      await fehlversuchMerken(t, konto, 'ip-a')
      assert.equal(await loginGesperrt(t, konto, 'ip-a'), true, 'Grenze erreicht → gesperrt')
      // Ein anderes Konto vom selben Absender bleibt offen — die Sperre gilt dem Konto.
      assert.equal(await loginGesperrt(t, kennungHash('anderes@example.com', 'test'), 'ip-a'), false)

      await fehlversucheLoeschen(t, konto)
      assert.equal(await loginGesperrt(t, konto, 'ip-a'), false, 'Erfolg setzt zurück')
    })
  })

  test('ein Absender, der viele Konten durchprobiert, wird als Ganzes gesperrt', async () => {
    await withRollback(async (t) => {
      for (let i = 0; i < MAX_JE_ABSENDER; i++) {
        await fehlversuchMerken(t, kennungHash(`konto-${i}@example.com`, 'test'), 'ip-b')
      }
      assert.equal(await loginGesperrt(t, kennungHash('neu@example.com', 'test'), 'ip-b'), true)
      // Ohne bekannten Absender (kein Header) zählt nur das Konto.
      assert.equal(await loginGesperrt(t, kennungHash('neu@example.com', 'test'), null), false)
    })
  })

  test('Housekeeping räumt nur Einträge außerhalb des Fensters ab', async () => {
    await withRollback(async (t) => {
      const konto = kennungHash('alt@example.com', 'test')
      await fehlversuchMerken(t, konto, null)
      await t`update login_versuche set created_at = now() - interval '2 days' where konto_hash = ${konto}`
      await fehlversuchMerken(t, kennungHash('frisch@example.com', 'test'), null)

      const geloescht = await loginVersucheAufraeumen(t)
      assert.equal(geloescht, 1)
      const [{ n }] = await t<{ n: number }[]>`
        select count(*)::int as n from login_versuche where konto_hash = ${konto}`
      assert.equal(n, 0)
    })
  })
})
