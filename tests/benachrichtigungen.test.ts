/**
 * Telegram-Kanal (0084): Outbox mit natürlichem Schlüssel, Bündelung,
 * Schalter beim Senden, Backoff, Job-Meldungen, Texte — und der reine
 * Telegram-Client mit eingeschleustem fetch.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, withRollback } from './helpers.ts'
import {
  MAX_VERSUCHE,
  artErlaubt,
  benachrichtigungenAufraeumen,
  benachrichtigungenSenden,
  einreihen,
  fehlgeschlageneJobsMelden,
  letzteBenachrichtigungen,
  schalter,
  textFehlversuche,
  textJob,
  textLogin,
  textSperre,
  zeitBucket,
} from '../src/modules/integrationen/benachrichtigungen.ts'
import {
  telegramChatsFinden,
  telegramConfigured,
  telegramSenden,
  telegramSicher,
} from '../src/modules/integrationen/telegram.ts'

after(closeDb)

const okSenden = async () => ({ ok: true, status: 200, fehler: null, fake: false, dauerMs: 3 })
const kaputtSenden = async () => ({ ok: false, status: 502, fehler: 'Telegram antwortet 502', fake: false, dauerMs: 3 })

describe('Benachrichtigungen (Outbox)', () => {
  test('Einreihen: gleicher Schlüssel aktualisiert nur, solange offen', async () => {
    await withRollback(async (t) => {
      const id = await einreihen(t, 'fehlversuch', 'test:fv:1', 'erster Text')
      assert.ok(id)
      const bald = new Date(Date.now() + 120_000)
      const id2 = await einreihen(t, 'fehlversuch', 'test:fv:1', 'zweiter Text', bald)
      assert.equal(id2, id, 'dieselbe Zeile')
      const [z] = await t<{ text: string; spaeter: boolean; n: number }[]>`
        select text, nicht_vor > now() + interval '60 seconds' as spaeter,
               (select count(*) from benachrichtigungen where schluessel = 'test:fv:1')::int as n
        from benachrichtigungen where id = ${id}`
      assert.equal(z.text, 'zweiter Text')
      assert.equal(z.spaeter, true, 'Frist erneuert')
      assert.equal(z.n, 1)

      await t`update benachrichtigungen set status = 'gesendet', gesendet_at = now() where id = ${id}`
      assert.equal(await einreihen(t, 'fehlversuch', 'test:fv:1', 'dritter Text'), null, 'gesendet blockiert')
      const [g] = await t<{ text: string }[]>`select text from benachrichtigungen where id = ${id}`
      assert.equal(g.text, 'zweiter Text')
    })
  })

  test('Senden: fällige Zeilen gehen raus, Fristen und Schalter werden beachtet', async () => {
    await withRollback(async (t) => {
      await t`delete from settings where key = 'benachrichtigungen'`
      await einreihen(t, 'login', 'test:login:a', 'Anmeldung A')
      await einreihen(t, 'fehlversuch', 'test:fv:b', 'Fehlversuche B', new Date(Date.now() + 120_000))
      await einreihen(t, 'job', 'test:job:c', 'Job C')
      const gesendet: string[] = []
      const bilanz = await benachrichtigungenSenden(t, {
        senden: async (text) => { gesendet.push(text); return okSenden() },
        konfiguriert: true,
        prefix: 'KRNL\n',
      })
      assert.deepEqual(bilanz, { gesendet: 2, uebersprungen: 0, fehlgeschlagen: 0, offen: 1 })
      // Gleicher erstellt_at innerhalb der Transaktion — die Reihenfolge ist egal.
      assert.deepEqual([...gesendet].sort(), ['KRNL\nAnmeldung A', 'KRNL\nJob C'])
      const [tx] = await t<{ n: number }[]>`
        select count(*)::int as n from api_transactions where system = 'telegram' and kind = 'send' and ok`
      assert.equal(tx.n, 2, 'jeder Versand im Transaktionslog')

      // Schalter: Fehlversuche aus → die wartende Zeile wird beim Senden übersprungen.
      await t`insert into settings (key, value) values ('benachrichtigungen', '{"fehlversuche": false}')`
      assert.equal((await schalter(t)).fehlversuche, false)
      assert.equal((await schalter(t)).logins, true, 'fehlende Schalter gelten als an')
      await t`update benachrichtigungen set nicht_vor = now() where schluessel = 'test:fv:b'`
      const zweite = await benachrichtigungenSenden(t, { senden: okSenden, konfiguriert: true })
      assert.equal(zweite.uebersprungen, 1)
      const [fv] = await t<{ status: string; fehler: string }[]>`
        select status, fehler from benachrichtigungen where schluessel = 'test:fv:b'`
      assert.equal(fv.status, 'uebersprungen')
      assert.match(fv.fehler, /abgeschaltet/)
    })
  })

  test('nicht konfiguriert → übersprungen mit Grund; Sendefehler → Backoff, dann fehlgeschlagen', async () => {
    await withRollback(async (t) => {
      await t`delete from settings where key = 'benachrichtigungen'`
      await einreihen(t, 'login', 'test:login:x', 'X')
      const b1 = await benachrichtigungenSenden(t, { senden: okSenden, konfiguriert: false })
      assert.equal(b1.uebersprungen, 1)
      const [x] = await t<{ fehler: string }[]>`select fehler from benachrichtigungen where schluessel = 'test:login:x'`
      assert.match(x.fehler, /nicht konfiguriert/)

      await einreihen(t, 'login', 'test:login:y', 'Y')
      const b2 = await benachrichtigungenSenden(t, { senden: kaputtSenden, konfiguriert: true })
      assert.deepEqual([b2.gesendet, b2.fehlgeschlagen], [0, 0])
      const [y] = await t<{ status: string; versuche: number; wartet: boolean; fehler: string }[]>`
        select status, versuche, nicht_vor > now() as wartet, fehler
        from benachrichtigungen where schluessel = 'test:login:y'`
      assert.equal(y.status, 'offen')
      assert.equal(y.versuche, 1)
      assert.equal(y.wartet, true, 'Backoff gesetzt')
      assert.match(y.fehler, /502/)
      const [txf] = await t<{ n: number }[]>`
        select count(*)::int as n from api_transactions where system = 'telegram' and not ok`
      assert.equal(txf.n, 1)

      await t`update benachrichtigungen set versuche = ${MAX_VERSUCHE - 1}, nicht_vor = now()
              where schluessel = 'test:login:y'`
      const b3 = await benachrichtigungenSenden(t, { senden: kaputtSenden, konfiguriert: true })
      assert.equal(b3.fehlgeschlagen, 1)
      const [y2] = await t<{ status: string }[]>`select status from benachrichtigungen where schluessel = 'test:login:y'`
      assert.equal(y2.status, 'fehlgeschlagen')
    })
  })

  test('endgültig fehlgeschlagene Jobs werden genau einmal gemeldet', async () => {
    await withRollback(async (t) => {
      const [job] = await t<{ id: string }[]>`
        insert into integration_jobs (kind, status, attempts, max_attempts, last_error)
        values ('send_po_email', 'failed', 10, 10, 'Resend antwortet 500') returning id`
      assert.equal(await fehlgeschlageneJobsMelden(t), 1)
      assert.equal(await fehlgeschlageneJobsMelden(t), 0, 'zweiter Lauf meldet nichts Neues')
      const [m] = await t<{ text: string; art: string }[]>`
        select text, art from benachrichtigungen where schluessel = ${`job:${job.id}:10`}`
      assert.equal(m.art, 'job')
      assert.match(m.text, /send_po_email/)
      assert.match(m.text, /Resend antwortet 500/)
      // Nach einem Retry (neuer Versuchszähler) darf ein erneutes Scheitern wieder melden.
      await t`update integration_jobs set attempts = 11 where id = ${job.id}`
      assert.equal(await fehlgeschlageneJobsMelden(t), 1)
    })
  })

  test('Texte: maskiert, mit Zeit und IP; Bucket; Aufräumen; Liste', async () => {
    const zeit = new Date('2026-09-25T12:02:00Z')
    const login = textLogin({ name: 'Max <b>Mustermann</b>', rolle: 'Administrator', ip: '203.0.113.7', geraet: 'Chrome · Windows', methode: 'Passwort · TOTP', zeit })
    assert.match(login, /Anmeldung/)
    assert.match(login, /Max &lt;b&gt;Mustermann&lt;\/b&gt;/, 'HTML maskiert')
    assert.match(login, /25\.09\.2026 14:02/, 'Europe/Berlin')
    assert.match(login, /203\.0\.113\.7/)
    const fv = textFehlversuche({ konto: 'max@example.com', anzahl: 3, ip: null, art: 'Code', zeit })
    assert.match(fv, /3 Fehlversuche/)
    assert.match(fv, /unbekannt/)
    assert.match(textFehlversuche({ konto: 'a', anzahl: 1, ip: '1.1.1.1', art: 'Passwort' }), /1 Fehlversuch<\/b> für/)
    assert.match(textSperre({ konto: 'max@example.com', ip: '1.2.3.4', minuten: 15, zeit }), /gesperrt.*15 Minuten/)
    assert.match(textJob({ kind: 'daten_tuev', versuche: 1, max: 1, fehler: null }), /ohne Fehlertext/)
    assert.equal(zeitBucket(15 * 60_000 * 7 + 1000), '7')
    assert.equal(zeitBucket(15 * 60_000 * 8), '8')
    assert.equal(artErlaubt('test', { logins: false, fehlversuche: false, jobs: false, dienste: false }), true)
    assert.equal(artErlaubt('sperre', { logins: true, fehlversuche: false, jobs: true, dienste: true }), false)

    await withRollback(async (t) => {
      await einreihen(t, 'test', 'test:alt', 'alt')
      await t`update benachrichtigungen set erstellt_at = now() - interval '31 days' where schluessel = 'test:alt'`
      await einreihen(t, 'test', 'test:neu', 'neu')
      assert.equal(await benachrichtigungenAufraeumen(t), 1)
      const liste = await letzteBenachrichtigungen(t, 5)
      assert.ok(liste.some((b) => b.text === 'neu'))
      assert.ok(!liste.some((b) => b.text === 'alt'))
    })
  })
})

describe('Telegram-Client', () => {
  test('konfiguriert nur mit Token und Chat-ID — oder im Fake-Betrieb', () => {
    assert.equal(telegramConfigured({}), false)
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 'x' }), false)
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' }), true)
    assert.equal(telegramConfigured({ TELEGRAM_FAKE: '1' }), true)
    assert.equal(telegramSicher('<a & b>'), '&lt;a &amp; b&gt;')
  })

  test('Fake sendet nichts und meldet Erfolg; ohne Konfiguration Fehler statt Aufruf', async () => {
    let aufrufe = 0
    const fetchFn = (async () => { aufrufe++; return new Response('{}', { status: 200 }) }) as typeof fetch
    const fake = await telegramSenden('hallo', { env: { TELEGRAM_FAKE: '1' }, fetchFn })
    assert.deepEqual([fake.ok, fake.fake, aufrufe], [true, true, 0])
    const leer = await telegramSenden('hallo', { env: {}, fetchFn })
    assert.equal(leer.ok, false)
    assert.match(leer.fehler!, /nicht konfiguriert/)
    assert.equal(aufrufe, 0)
  })

  test('sendMessage: Aufruf mit Chat-ID und HTML; Fehlerantwort wird lesbar', async () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42' }
    let gesehen: { url: string; body: Record<string, unknown> } | null = null
    const fetchOk = (async (url: string | URL, init?: RequestInit) => {
      gesehen = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch
    const r = await telegramSenden('<b>x</b>', { env, fetchFn: fetchOk })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.match(gesehen!.url, /\/bottok\/sendMessage$/)
    assert.equal(gesehen!.body.chat_id, '42')
    assert.equal(gesehen!.body.parse_mode, 'HTML')
    assert.equal(gesehen!.body.text, '<b>x</b>')

    const fetchWeg = (async () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 })) as typeof fetch
    const f = await telegramSenden('x', { env, fetchFn: fetchWeg })
    assert.equal(f.ok, false)
    assert.equal(f.status, 401)
    assert.match(f.fehler!, /401: Unauthorized/)

    const fetchTot = (async () => { throw new Error('fetch failed') }) as typeof fetch
    const n = await telegramSenden('x', { env, fetchFn: fetchTot })
    assert.equal(n.ok, false)
    assert.equal(n.status, null)
    assert.match(n.fehler!, /fetch failed/)
  })

  test('Chat-IDs aus getUpdates, ohne Dubletten', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          result: [
            { message: { chat: { id: 1001, type: 'private', first_name: 'Patrick' } } },
            { message: { chat: { id: 1001, type: 'private', first_name: 'Patrick', last_name: 'D' } } },
            { my_chat_member: { chat: { id: -5002, type: 'group', title: 'KRNL Betrieb' } } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch
    const chats = await telegramChatsFinden({ env: { TELEGRAM_BOT_TOKEN: 'tok' }, fetchFn })
    assert.deepEqual(chats, [
      { id: '1001', titel: 'Patrick D', art: 'private' },
      { id: '-5002', titel: 'KRNL Betrieb', art: 'group' },
    ])
    await assert.rejects(() => telegramChatsFinden({ env: {}, fetchFn }), /TELEGRAM_BOT_TOKEN fehlt/)
  })
})
