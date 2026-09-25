/**
 * Zweiter Faktor als Sitzungszustand (0083): wartende Sitzung, Bestätigung,
 * Replay-Schutz, Backup-Codes, vertraute Geräte, Reset, Pflicht.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, makeUser, withRollback } from './helpers.ts'
import {
  backupCodeEinloesen,
  backupCodesErneuern,
  codePruefenUndMerken,
  einmalAbholen,
  einmalSetzen,
  entwurfSicherstellen,
  geraetBezeichnung,
  geraetVertrauen,
  geraetVertraut,
  geraeteAufraeumen,
  geraeteAuflisten,
  geraetWiderrufen,
  pflichtGilt,
  sicherheitsEinstellung,
  sitzungBestaetigen,
  sitzungErstellen,
  sitzungNutzer,
  tokenHash,
  totpAktivieren,
  wartendeSitzung,
  zweifaktorStatus,
  zweifaktorZuruecksetzen,
} from '../src/modules/auth/zweifaktor.ts'
import { geheimnisErzeugen, totp, totpSchritt } from '../src/modules/auth/totp.ts'

before(() => {
  // Die Verschlüsselung verlangt einen Schlüssel — ohne .env ist keiner gesetzt.
  process.env.SESSION_SECRET ??= 'zweifaktor-test'
})
after(closeDb)

describe('Zweiter Faktor', () => {
  test('Pflicht: alle / admins / freiwillig; ohne Eintrag gilt alle', async () => {
    assert.equal(pflichtGilt('lager', 'alle'), true)
    assert.equal(pflichtGilt('admin', 'admins'), true)
    assert.equal(pflichtGilt('lager', 'admins'), false)
    assert.equal(pflichtGilt('admin', 'freiwillig'), false)
    await withRollback(async (t) => {
      await t`delete from settings where key = 'sicherheit'`
      assert.deepEqual(await sicherheitsEinstellung(t), { zwei_faktor: 'alle' })
      await t`insert into settings (key, value) values ('sicherheit', '{"zwei_faktor":"admins"}')`
      assert.deepEqual(await sicherheitsEinstellung(t), { zwei_faktor: 'admins' })
      await t`update settings set value = '{"zwei_faktor":"unsinn"}' where key = 'sicherheit'`
      assert.deepEqual(await sicherheitsEinstellung(t), { zwei_faktor: 'alle' }, 'Unbekanntes fällt auf alle')
    })
  })

  test('wartende Sitzung ist für currentUser unsichtbar, nach Bestätigung 30 Tage gültig', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Zwei Faktor')
      const secret = geheimnisErzeugen()
      const token = await sitzungErstellen(t, user.id, { bestaetigt: false, entwurf: secret })
      const hash = tokenHash(token)

      assert.equal(await sitzungNutzer(t, hash), null, 'wartend → kein Nutzer')
      const wartend = await wartendeSitzung(t, hash)
      assert.ok(wartend)
      assert.equal(wartend.user_id, user.id)
      assert.equal(wartend.totp_aktiv, false)
      assert.equal(wartend.entwurf, secret, 'Entwurf kommt entschlüsselt zurück')
      const [roh] = await t<{ entwurf: string }[]>`select entwurf from sessions where token = ${hash}`
      assert.notEqual(roh.entwurf, secret, 'in der Datenbank nur verschlüsselt')
      assert.equal(await entwurfSicherstellen(t, hash), secret, 'vorhandener Entwurf bleibt stabil')

      await totpAktivieren(t, user.id, secret)
      assert.equal(await sitzungBestaetigen(t, hash), true)
      assert.equal(await sitzungBestaetigen(t, hash), false, 'zweite Bestätigung ist keine')
      const nutzer = await sitzungNutzer(t, hash)
      assert.ok(nutzer)
      assert.equal(nutzer.totp_aktiv, true)
      assert.equal(await wartendeSitzung(t, hash), null)
      const [s] = await t<{ tage: number; entwurf: string | null }[]>`
        select extract(epoch from (expires_at - now())) / 86400 as tage, entwurf
        from sessions where token = ${hash}`
      assert.ok(Number(s.tage) > 29, 'auf 30 Tage verlängert')
      assert.equal(s.entwurf, null)
    })
  })

  test('bestätigte Sitzung direkt (vertrautes Gerät) und Einmal-Anzeige', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Direkt Voll')
      const hash = tokenHash(await sitzungErstellen(t, user.id, { bestaetigt: true }))
      assert.ok(await sitzungNutzer(t, hash))
      await einmalSetzen(t, hash, { backup_codes: ['aaaa-bbbb'] })
      assert.deepEqual(await einmalAbholen(t, hash), { backup_codes: ['aaaa-bbbb'] })
      assert.equal(await einmalAbholen(t, hash), null, 'genau einmal')
    })
  })

  test('App-Code: richtig einmal, Replay nie, Fenster ±1 Schritt', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Code Prüfer')
      const secret = geheimnisErzeugen()
      const jetzt = Date.now()
      await totpAktivieren(t, user.id, secret)
      assert.equal(await codePruefenUndMerken(t, user.id, '000000', jetzt), false)
      const code = totp(secret, jetzt)
      assert.equal(await codePruefenUndMerken(t, user.id, code, jetzt), true)
      assert.equal(await codePruefenUndMerken(t, user.id, code, jetzt), false, 'derselbe Code nicht zweimal')
      assert.equal(await codePruefenUndMerken(t, user.id, totp(secret, jetzt - 30_000), jetzt), false, 'älterer Code nach neuerem')
      assert.equal(await codePruefenUndMerken(t, user.id, totp(secret, jetzt + 30_000), jetzt), true, 'nächster Schritt geht')
      const [u] = await t<{ schritt: string }[]>`select totp_letzter_schritt as schritt from users where id = ${user.id}`
      assert.equal(Number(u.schritt), totpSchritt(jetzt + 30_000))
      const status = await zweifaktorStatus(t, user.id)
      assert.equal(status.aktiv, true)
      assert.equal(status.backup_offen, 0)
    })
  })

  test('Backup-Codes: zehn Stück, jeder genau einmal, nur Hashes in der Datenbank', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Backup Nutzer')
      const codes = await backupCodesErneuern(t, user.id)
      assert.equal(codes.length, 10)
      const [zeile] = await t<{ code_hash: string }[]>`select code_hash from backup_codes where user_id = ${user.id} limit 1`
      assert.ok(!codes.includes(zeile.code_hash), 'Klartext steht nicht in der Tabelle')
      assert.equal(await backupCodeEinloesen(t, user.id, codes[0].toUpperCase()), true, 'Groß-/Kleinschreibung egal')
      assert.equal(await backupCodeEinloesen(t, user.id, codes[0]), false, 'verbraucht')
      assert.equal(await backupCodeEinloesen(t, user.id, 'zzzz-zzzz'), false)
      assert.equal((await zweifaktorStatus(t, user.id)).backup_offen, 9)
      const neu = await backupCodesErneuern(t, user.id)
      assert.equal(await backupCodeEinloesen(t, user.id, codes[1]), false, 'alte Codes gelten nach Erneuern nicht mehr')
      assert.equal(await backupCodeEinloesen(t, user.id, neu[0]), true)
    })
  })

  test('vertraute Geräte: nur für den Besitzer, bis zum Ablauf, widerrufbar', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Gerät Besitzer')
      const fremd = await makeUser(t, 'Gerät Fremder')
      const token = await geraetVertrauen(t, user.id, 'Chrome · Windows')
      assert.equal(await geraetVertraut(t, user.id, token), true)
      assert.equal(await geraetVertraut(t, fremd.id, token), false, 'anderer Benutzer, gleicher Browser')
      assert.equal(await geraetVertraut(t, user.id, 'falsch'), false)
      const liste = await geraeteAuflisten(t, user.id)
      assert.equal(liste.length, 1)
      assert.equal(liste[0].bezeichnung, 'Chrome · Windows')
      assert.ok(liste[0].zuletzt_at)

      await t`update vertraute_geraete set laeuft_ab_at = now() - interval '1 minute' where id = ${liste[0].id}`
      assert.equal(await geraetVertraut(t, user.id, token), false, 'abgelaufen')
      assert.equal((await geraeteAuflisten(t, user.id)).length, 0)
      assert.equal(await geraeteAufraeumen(t), 1)

      const zweites = await geraetVertrauen(t, user.id, 'Safari · iOS')
      const [g] = await geraeteAuflisten(t, user.id)
      assert.equal(await geraetWiderrufen(t, fremd.id, g.id), false, 'Fremde können nicht widerrufen')
      assert.equal(await geraetWiderrufen(t, user.id, g.id), true)
      assert.equal(await geraetVertraut(t, user.id, zweites), false)
    })
  })

  test('Reset räumt Geheimnis, Codes, Geräte und Sitzungen; Löschen des Benutzers kaskadiert', async () => {
    await withRollback(async (t) => {
      const user = await makeUser(t, 'Reset Kandidat')
      await totpAktivieren(t, user.id, geheimnisErzeugen())
      await backupCodesErneuern(t, user.id)
      await geraetVertrauen(t, user.id, 'x')
      const hash = tokenHash(await sitzungErstellen(t, user.id, { bestaetigt: true }))
      await zweifaktorZuruecksetzen(t, user.id)
      assert.equal((await zweifaktorStatus(t, user.id)).aktiv, false)
      assert.equal((await zweifaktorStatus(t, user.id)).backup_offen, 0)
      assert.equal((await geraeteAuflisten(t, user.id)).length, 0)
      assert.equal(await sitzungNutzer(t, hash), null)

      await backupCodesErneuern(t, user.id)
      await geraetVertrauen(t, user.id, 'y')
      await t`delete from users where id = ${user.id}`
      const [z] = await t<{ n: number }[]>`
        select (select count(*) from backup_codes where user_id = ${user.id})::int
             + (select count(*) from vertraute_geraete where user_id = ${user.id})::int as n`
      assert.equal(Number(z.n), 0)
    })
  })

  test('Gerätebezeichnung aus dem User-Agent', () => {
    assert.equal(
      geraetBezeichnung('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'),
      'Chrome · Windows',
    )
    assert.equal(
      geraetBezeichnung('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
      'Safari · iOS',
    )
    assert.equal(geraetBezeichnung('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox · Linux')
    assert.equal(geraetBezeichnung(null), 'Browser · unbekanntes System')
  })
})
