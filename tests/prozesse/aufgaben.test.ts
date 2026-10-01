/**
 * Aufgaben für Mitarbeiter (0104, Entscheidungslog 2026-10-01): anlegen mit
 * Termin für eine Person (per Name, Vorname, Benutzername) oder ein Team,
 * erscheinen beim Zuständigen („Meine", Navi-Zähler), abhaken per ID oder
 * Stichwort — mit Rechten. Dazu der Weg über Sprechen: Schema- und
 * Rechteprüfung, wie vorgang_sammeln sie beim Notieren macht.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft, aktionErlaubt, aktionPruefen } from '../../src/modules/prozesse/torwaechter.ts'
import { heuteInBerlin } from '../../src/modules/aufgaben/termin.ts'

const DATENBANK = 'erp_aufgaben_check'
let h: Harness

type Nutzer = { id: string; name: string; role: 'admin' | 'mitarbeiter' | 'lager' | 'fertigung'; rollen: ('admin' | 'mitarbeiter' | 'lager' | 'fertigung')[] }
const n: Record<string, Nutzer> = {}

before(async () => {
  h = await harnessStart(DATENBANK)
  const anlegen = async (schluessel: string, name: string, role: Nutzer['role'], benutzername: string, zusatz: string[] = []) => {
    const [u] = await h.sql<{ id: string }[]>`
      insert into users (name, benutzername, password_hash, role, zusatz_rollen)
      values (${name}, ${benutzername}, 'x', ${role}, ${zusatz}::user_role[]) returning id`
    n[schluessel] = { id: u.id, name, role, rollen: [role, ...(zusatz as Nutzer['rollen'])] }
  }
  await anlegen('chef', 'Patrick Chef', 'admin', 'patrick')
  await anlegen('tino', 'Tino Lagerfeld', 'lager', 'tino.l')
  await anlegen('tina', 'Tina Lager', 'lager', 'tina')
  await anlegen('fred', 'Fred Fertig', 'fertigung', 'fred')
  await h.sql`insert into employees (number, name, active) values ('MA9001', 'Olga Ohnekonto', true)`
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

const anlegen = (parameter: Record<string, unknown>, wer: Nutzer = n.chef) =>
  aktionAusfuehrenGeprueft('aufgaben.anlegen', { parameter }, wer)

const meine = async (wer: Nutzer) => {
  const { aufgabenListe } = await import('../../src/modules/aufgaben/liste.ts')
  return (await aufgabenListe(wer, 'meine')).map((a) => a.titel)
}

describe('Aufgaben: anlegen, sehen, abhaken', () => {
  const ids: Record<string, string> = {}

  test('für eine Person per Vorname — mit Uhrzeit und Dauer', async () => {
    const r = await anlegen({ titel: 'Lager hinten durchfegen', zustaendig: 'Tino', uhrzeit: '15 Uhr', dauer_min: 30 })
    assert.match(r.text ?? '', /für Tino Lagerfeld angelegt — fällig heute, 15:00 Uhr/)
    ids.fegen = r.recordId!
    const [a] = await h.sql<{ zustaendig_id: string; uhrzeit: string; dauer_min: number; faellig_am: string }[]>`
      select zustaendig_id, uhrzeit::text, dauer_min, faellig_am::text from aufgaben where id = ${ids.fegen}`
    assert.deepEqual(a, { zustaendig_id: n.tino.id, uhrzeit: '15:00:00', dauer_min: 30, faellig_am: heuteInBerlin() })
  })

  test('per Benutzername, ganzem Namen, Nachnamen; ans Team; für mich', async () => {
    await anlegen({ titel: 'Kartons falten', zustaendig: 'tino.l', faellig_am: 'morgen' })
    await anlegen({ titel: 'Gehäuse vorbereiten', zustaendig: 'Fred Fertig' })
    await anlegen({ titel: 'Lötstation reinigen', zustaendig: 'Fertig' })
    const team = await anlegen({ titel: 'Wareneingang auspacken', zustaendig: 'das Lager' })
    assert.match(team.text ?? '', /für Team Lager angelegt/)
    ids.team = team.recordId!
    const selbst = await anlegen({ titel: 'Steuerberater anrufen' })
    assert.match(selbst.text ?? '', /für dich angelegt/)
  })

  test('mehrdeutig, unbekannt, ohne Konto, Vergangenheit: Klartext statt Raten', async () => {
    await assert.rejects(anlegen({ titel: 'x', zustaendig: 'Lager Tina' }), /Niemanden namens/)
    await assert.rejects(anlegen({ titel: 'x', zustaendig: 'Ti' }), /Niemanden namens/)
    await assert.rejects(anlegen({ titel: 'x', zustaendig: 'Olga' }), /Olga Ohnekonto hat kein Benutzerkonto/)
    await assert.rejects(anlegen({ titel: 'x', zustaendig: 'Tino', faellig_am: '01.01.2020' }), /in der Vergangenheit/)
    await assert.rejects(anlegen({ titel: 'x', faellig_am: 'irgendwann' }), /verstehe ich nicht/)
    await h.sql`insert into users (name, benutzername, password_hash, role) values ('Tino Zwei', 'tino2', 'x', 'lager')`
    await assert.rejects(anlegen({ titel: 'x', zustaendig: 'Tino' }), /mehrdeutig: Tino Lagerfeld, Tino Zwei/)
    await h.sql`update users set active = false where benutzername = 'tino2'`
  })

  test('jeder sieht seine: Person, Team (auch über Zusatzrolle), nicht die der anderen', async () => {
    assert.deepEqual(await meine(n.tino), ['Lager hinten durchfegen', 'Wareneingang auspacken', 'Kartons falten'])
    assert.deepEqual(await meine(n.tina), ['Wareneingang auspacken'])
    assert.deepEqual(await meine(n.fred), ['Gehäuse vorbereiten', 'Lötstation reinigen'])
    assert.deepEqual(await meine(n.chef), ['Steuerberater anrufen'])
    const { meineFaelligenAufgaben } = await import('../../src/modules/aufgaben/liste.ts')
    assert.equal(await meineFaelligenAufgaben(n.tino), 2, 'Kartons falten ist erst morgen fällig')
  })

  test('abhaken per Stichwort — nur unter den eigenen, eindeutig', async () => {
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: 'Gehäuse' } }, n.tino),
      /Keine offene Aufgabe zu „Gehäuse" bei dir/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: 'a' } }, n.tino),
      /Mehrere passen/,
    )
    const r = await aktionAusfuehrenGeprueft(
      'aufgaben.erledigen', { parameter: { aufgabe: 'fegen', notiz: 'Regal 4 war voll' } }, n.tino)
    assert.equal(r.text, 'Erledigt: Lager hinten durchfegen.')
    const [a] = await h.sql<{ status: string; erledigt_von: string; notiz: string }[]>`
      select status::text, erledigt_von, notiz from aufgaben where id = ${ids.fegen}`
    assert.deepEqual(a, { status: 'erledigt', erledigt_von: 'Tino Lagerfeld', notiz: 'Regal 4 war voll' })
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: ids.fegen } }, n.tino),
      /schon erledigt/,
    )
  })

  test('Rechte: fremde Aufgabe nein, Team-Aufgabe ja, Büro immer; verwerfen nur Anleger und Büro', async () => {
    const [geh] = await h.sql<{ id: string }[]>`select id from aufgaben where titel = 'Gehäuse vorbereiten'`
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: geh.id } }, n.tino),
      /nicht deine Aufgabe/,
    )
    await assert.rejects(
      aktionAusfuehrenGeprueft('aufgaben.verwerfen', { parameter: { aufgabe_id: geh.id } }, n.fred),
      /Verwerfen darf, wer die Aufgabe angelegt hat/,
    )
    await aktionAusfuehrenGeprueft('aufgaben.erledigen', { parameter: { aufgabe: ids.team } }, n.tina)
    assert.deepEqual(await meine(n.tino), ['Kartons falten'], 'Team-Aufgabe ist für alle im Team weg')
    await aktionAusfuehrenGeprueft('aufgaben.verwerfen', { parameter: { aufgabe_id: geh.id } }, n.chef)
    assert.deepEqual(await meine(n.fred), ['Lötstation reinigen'])
  })

  test('Lager und Fertigung dürfen Aufgaben anlegen und abhaken (Bereich für alle)', () => {
    const { aktion } = aktionPruefen('aufgaben.anlegen', { parameter: { titel: 'x' } })
    for (const rolle of ['lager', 'fertigung', 'mitarbeiter', 'admin'] as const) {
      assert.equal(aktionErlaubt(aktion, rolle), true, rolle)
    }
  })

  test('Sprechen: der notierte Wunsch besteht die Prüfung — Dauer auch als Text', async () => {
    const { werte } = aktionPruefen('aufgaben.anlegen', {
      parameter: { titel: 'Paletten wegräumen', zustaendig: 'Tino', faellig_am: 'Freitag', uhrzeit: '9:30', dauer_min: '45' },
    })
    assert.equal((werte as { dauer_min: number }).dauer_min, 45)
    const { kiKatalog } = await import('../../src/modules/prozesse/introspektion.ts')
    const namen = kiKatalog().map((a) => a.name)
    assert.ok(namen.includes('aufgaben.anlegen') && namen.includes('aufgaben.erledigen'))
    // Gebucht wird nach der Sichtprüfung — mit dem Benutzer, der gesprochen hat.
    const r = await aktionAusfuehrenGeprueft('aufgaben.anlegen', { parameter: werte }, n.chef)
    assert.match(r.text ?? '', /für Tino Lagerfeld angelegt — fällig (heute|\d\d\.\d\d\.\d{4}), 09:30 Uhr/)
  })
})
