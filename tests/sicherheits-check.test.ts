import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  FEHLANMELDUNGEN_AUFFAELLIG,
  PORTAL_FEHLSUCHEN_AUFFAELLIG,
  type SicherheitsStand,
  lueckenAbrufen,
  paketeAusLockfile,
  sicherheitsBefunde,
  sicherheitsText,
} from '../src/modules/einstellungen/sicherheits-check.ts'

/**
 * Täglicher Sicherheits-Check (Entscheidungslog 2026-11-13): meldet nur bei
 * Befunden. Geprüft werden die Regeln, der Text und das Lesen der Lockfile —
 * der Abruf der Advisory-Datenbank mit einer Attrappe.
 */

const RUHIG: SicherheitsStand = {
  luecken: [],
  adminsOhne2fa: 0,
  startkontoAktiv: false,
  fehlanmeldungen24h: 3,
  portalFehlsuchen24h: 0,
  fehlendeGeheimnisse: [],
}

describe('Sicherheits-Check', () => {
  test('ruhiger Stand: keine Befunde, keine Nachricht', () => {
    assert.deepEqual(sicherheitsBefunde(RUHIG), [])
    assert.equal(sicherheitsText([], { datum: '2026-11-14' }), null)
  })

  test('jeder Auslöser ergibt einen Befund; Schwellen gelten ab dem Wert', () => {
    const b = sicherheitsBefunde({
      luecken: [{ paket: 'zod', versionen: ['3.25.76'], schwere: 'high', titel: 'Speicher', betroffen: '<4.6.6', url: 'https://x' }],
      adminsOhne2fa: 1,
      startkontoAktiv: true,
      fehlanmeldungen24h: FEHLANMELDUNGEN_AUFFAELLIG,
      portalFehlsuchen24h: PORTAL_FEHLSUCHEN_AUFFAELLIG,
      fehlendeGeheimnisse: ['CRON_SECRET'],
    })
    assert.equal(b.length, 6)
    assert.match(b[0], /^Abhängigkeit zod 3\.25\.76: hoch — Speicher \(betroffen <4\.6\.6\)$/)
    assert.ok(b.includes('Ein Admin hat keinen zweiten Faktor'))
    assert.deepEqual(sicherheitsBefunde({ ...RUHIG, fehlanmeldungen24h: FEHLANMELDUNGEN_AUFFAELLIG - 1 }), [])
    assert.deepEqual(sicherheitsBefunde({ ...RUHIG, adminsOhne2fa: 2 }), ['2 Admins haben keinen zweiten Faktor'])
  })

  test('Text: Kopf mit Datum und Anzahl, maskiert, Link zum Produktivgang', () => {
    const text = sicherheitsText(['Paket <b>x</b> & y', 'zweiter'], { datum: '2026-11-14', basisUrl: 'https://krnl.example' })!
    assert.match(text, /Sicherheits-Check 14\.11\.2026<\/b> — 2 Punkte/)
    assert.ok(text.includes('• Paket &lt;b&gt;x&lt;/b&gt; &amp; y'))
    assert.ok(text.endsWith('https://krnl.example/einstellungen/produktivgang'))
    assert.match(sicherheitsText(['einer'], { datum: '2026-11-14' })!, /— 1 Punkt\n• einer$/)
  })

  test('Lockfile: Name hinter dem letzten node_modules/, Versionen gesammelt, das Projekt selbst nicht', () => {
    assert.deepEqual(
      paketeAusLockfile({
        packages: {
          '': { version: '0.1.0' },
          'node_modules/zod': { version: '3.25.76' },
          'node_modules/@img/sharp-linux-x64': { version: '0.35.3' },
          'node_modules/a/node_modules/zod': { version: '4.6.7' },
          'node_modules/ohne': {},
        },
      }),
      { zod: ['3.25.76', '4.6.7'], '@img/sharp-linux-x64': ['0.35.3'] },
    )
    // Die echte Lockfile des Repos lässt sich lesen und enthält die direkten Abhängigkeiten.
    const echt = paketeAusLockfile(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')))
    assert.ok(echt.next?.length === 1 && echt.zod?.length >= 1)
  })

  test('Advisory-Abruf: nur hoch und kritisch, kritisch zuerst; HTTP-Fehler wirft', async () => {
    let gesendet: unknown
    const attrappe = (async (_url: unknown, init?: { body?: unknown }) => {
      gesendet = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          zod: [{ severity: 'high', title: 'Speicher', vulnerable_versions: '<4.6.6', url: 'https://ghsa/1' }],
          next: [{ severity: 'critical', title: 'RCE', vulnerable_versions: '<16.3.3', url: 'https://ghsa/2' }],
          nanoid: [{ severity: 'moderate', title: 'egal' }],
        }),
      )
    }) as unknown as typeof fetch
    const l = await lueckenAbrufen({ zod: ['3.25.76'], next: ['16.4.2'], nanoid: ['3.3.7'] }, attrappe)
    assert.deepEqual(gesendet, { zod: ['3.25.76'], next: ['16.4.2'], nanoid: ['3.3.7'] })
    assert.deepEqual(l.map((x) => `${x.paket}:${x.schwere}`), ['next:critical', 'zod:high'])
    assert.deepEqual(l[1].versionen, ['3.25.76'])

    const kaputt = (async () => new Response('nein', { status: 503 })) as unknown as typeof fetch
    await assert.rejects(lueckenAbrufen({ zod: ['1'] }, kaputt), /HTTP 503/)
  })
})
