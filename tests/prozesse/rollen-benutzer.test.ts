/**
 * Mehrere Rollen je Benutzer und Anmeldung ohne E-Mail (Migration 0096)
 * gegen die echte Datenbank: Konto mit Benutzername statt E-Mail anlegen,
 * Kennungen eindeutig über beide Felder (ohne Groß/Klein), Hauptrolle plus
 * Zusatzrollen setzen, und der Torwächter rechnet mit der Vereinigung der
 * Rollen — Lager allein darf keinen Fertigungsauftrag anlegen, Lager +
 * Fertigung schon.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { RechteFehler, aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_rollen_benutzer_check'
const ADMIN = { name: 'rollen-admin', role: 'admin' as const }

let h: Harness
const ids: Record<string, string> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Mehrere Rollen, Benutzername statt E-Mail', () => {
  test('Konto ohne E-Mail mit Benutzername und Zusatzrolle anlegen', async () => {
    const r = await aktionAusfuehrenGeprueft(
      'einstellungen.benutzer_anlegen',
      {
        parameter: {
          benutzername: 'Max.M',
          name: 'Max Muster',
          password: 'lager-geheim-1',
          role: 'lager',
          zusatz_rollen: ['fertigung', 'lager'],
        },
      },
      ADMIN,
    )
    ids.max = r.recordId!
    const [u] = await h.sql<{ email: string | null; benutzername: string; role: string; zusatz_rollen: string[] }[]>`
      select email, benutzername, role::text, zusatz_rollen::text[] as zusatz_rollen from users where id = ${ids.max}`
    assert.deepEqual(u, { email: null, benutzername: 'max.m', role: 'lager', zusatz_rollen: ['fertigung'] })
  })

  test('Kennungen sind über E-Mail und Benutzername eindeutig; ohne beides geht es nicht', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.benutzer_anlegen',
        { parameter: { benutzername: 'MAX.M', name: 'Doppel', password: 'geheim-123', role: 'lager' } },
        ADMIN,
      ),
      /bereits vergeben/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.benutzer_anlegen',
        { parameter: { name: 'Niemand', password: 'geheim-123', role: 'lager' } },
        ADMIN,
      ),
      /E-Mail oder Benutzername/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'einstellungen.benutzer_anlegen',
        { parameter: { benutzername: 'max m', name: 'Leer', password: 'geheim-123', role: 'lager' } },
        ADMIN,
      ),
      /Benutzername: 2–40 Zeichen/,
    )
  })

  test('Rollen ändern: Zusatzrollen setzen und entfernen; Administrator ohne Zusatzrollen', async () => {
    await aktionAusfuehrenGeprueft(
      'einstellungen.benutzer_rolle',
      { recordId: ids.max, parameter: { role: 'fertigung', zusatz_rollen: ['lager', 'mitarbeiter'] } },
      ADMIN,
    )
    let [u] = await h.sql<{ role: string; zusatz_rollen: string[] }[]>`
      select role::text, zusatz_rollen::text[] as zusatz_rollen from users where id = ${ids.max}`
    assert.deepEqual(u, { role: 'fertigung', zusatz_rollen: ['lager', 'mitarbeiter'] })

    // Nur die Hauptrolle ändern: Zusatzrollen bleiben, die neue Hauptrolle fällt aus ihnen heraus.
    await aktionAusfuehrenGeprueft('einstellungen.benutzer_rolle', { recordId: ids.max, parameter: { role: 'lager' } }, ADMIN)
    ;[u] = await h.sql<{ role: string; zusatz_rollen: string[] }[]>`
      select role::text, zusatz_rollen::text[] as zusatz_rollen from users where id = ${ids.max}`
    assert.deepEqual(u, { role: 'lager', zusatz_rollen: ['mitarbeiter'] })

    await aktionAusfuehrenGeprueft(
      'einstellungen.benutzer_rolle',
      { recordId: ids.max, parameter: { role: 'lager', zusatz_rollen: ['fertigung'] } },
      ADMIN,
    )
  })

  test('Torwächter: Lager allein darf nicht fertigen, Lager + Fertigung schon', async () => {
    const [v] = await h.sql<{ id: string }[]>`select id from product_variants limit 1`
    const aufruf = { parameter: { variant_id: v?.id ?? 'gibt-es-nicht', qty: 1 } }
    await assert.rejects(
      aktionAusfuehrenGeprueft('fertigung.auftrag_anlegen', aufruf, { name: 'max.m', role: 'lager' }),
      (err: unknown) => err instanceof RechteFehler,
    )
    // Mit beiden Rollen besteht die Rechteprüfung; was danach fachlich passiert
    // (Stückliste vorhanden oder nicht), ist kein Rechtefehler mehr.
    try {
      await aktionAusfuehrenGeprueft('fertigung.auftrag_anlegen', aufruf, {
        name: 'max.m',
        role: 'lager',
        rollen: ['lager', 'fertigung'],
      })
    } catch (err) {
      assert.ok(!(err instanceof RechteFehler), `unerwarteter Rechtefehler: ${String(err)}`)
    }
  })
  test('Konto löschen: Zuständigkeiten leer, Verlauf bleibt; nie sich selbst, nie den letzten Admin', async () => {
    const angelegt = await aktionAusfuehrenGeprueft(
      'einstellungen.benutzer_anlegen',
      { parameter: { email: 'seed@example.com', name: 'Seed', password: 'geheim-1234', role: 'mitarbeiter' } },
      ADMIN,
    )
    const id = angelegt.recordId!
    const [kunde] = await h.sql<{ id: string }[]>`
      insert into partners (name, is_customer, user_id) values ('Löschtest Kunde', true, ${id}) returning id`
    await h.sql`insert into sessions (token, user_id, expires_at) values (${'loeschtest-' + id}, ${id}, now() + interval '1 day')`

    await assert.rejects(
      aktionAusfuehrenGeprueft('einstellungen.benutzer_loeschen', { recordId: id }, { ...ADMIN, id }),
      /eigene Konto/,
    )
    const r = await aktionAusfuehrenGeprueft('einstellungen.benutzer_loeschen', { recordId: id }, ADMIN)
    assert.match(r.text ?? '', /seed@example\.com gelöscht/)
    const [{ n }] = await h.sql<{ n: number }[]>`select count(*)::int as n from users where id = ${id}`
    assert.equal(n, 0)
    const [{ s: sitzungen }] = await h.sql<{ s: number }[]>`select count(*)::int as s from sessions where user_id = ${id}`
    assert.equal(sitzungen, 0, 'Sitzungen sind weg')
    const [partner] = await h.sql<{ user_id: string | null }[]>`select user_id from partners where id = ${kunde.id}`
    assert.equal(partner.user_id, null, 'Zuständigkeit geleert, der Kunde bleibt')
    const [spur] = await h.sql<{ n: number }[]>`
      select count(*)::int as n from audit_log where record_id = ${id} and message like 'Benutzer gelöscht%'`
    assert.equal(spur.n, 1, 'der Verlauf behält den Namen')

    // Der letzte aktive Administrator bleibt.
    const admins = await h.sql<{ id: string }[]>`select id from users where role = 'admin' and active`
    if (admins.length === 1) {
      await assert.rejects(
        aktionAusfuehrenGeprueft('einstellungen.benutzer_loeschen', { recordId: admins[0].id }, ADMIN),
        /letzte aktive Administrator/,
      )
    }
  })
})
