import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY } from '../src/modules/prozesse/registry/index.ts'
import { aktionErlaubt } from '../src/modules/prozesse/torwaechter.ts'
import {
  normalisiereRegistrierung,
  pruefeRegistrierung,
} from '../src/modules/shared/registrierung.ts'
import { closeDb, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Registrierung von der öffentlichen Startseite. Sie ist der einzige
 * Schreibweg ohne Sitzung — deshalb wird hier beides geprüft: dass die
 * Eingangsregeln greifen (sie sind die ganze Verteidigung) und dass alles
 * DANACH wieder über eine Registry-Aktion läuft.
 */

const VOLLSTAENDIG = {
  firma: 'Nordwerk GmbH',
  ansprechpartner: 'Mira Kessler',
  email: 'm.kessler@nordwerk.de',
  telefon: '040 123456',
  nutzer: '11–50',
  heutiges_system: 'Excel & Insellösungen',
  ablauf: 'Der Auftragsdurchlauf vom Shop bis zum Versand.',
}

describe('Eingangsregeln (Formular und Endpunkt teilen sie)', () => {
  test('vollständige Angaben passieren', () => {
    assert.deepEqual(pruefeRegistrierung(normalisiereRegistrierung(VOLLSTAENDIG)), {})
  })

  test('jedes Pflichtfeld wird einzeln bemängelt', () => {
    for (const feld of ['firma', 'ansprechpartner', 'email', 'ablauf'] as const) {
      const fehler = pruefeRegistrierung(
        normalisiereRegistrierung({ ...VOLLSTAENDIG, [feld]: '   ' }),
      )
      assert.ok(fehler[feld], `${feld} fehlt in der Prüfung`)
      assert.equal(Object.keys(fehler).length, 1, `${feld}: es darf nur ein Fehler entstehen`)
    }
  })

  test('Kür-Felder sind wirklich freiwillig', () => {
    const fehler = pruefeRegistrierung(
      normalisiereRegistrierung({
        ...VOLLSTAENDIG,
        telefon: '',
        nutzer: '',
        heutiges_system: '',
      }),
    )
    assert.deepEqual(fehler, {})
  })

  test('offensichtlich falsche E-Mail-Adressen fallen durch', () => {
    for (const email of ['keine', 'a@b', 'a b@c.de', '@nordwerk.de']) {
      const fehler = pruefeRegistrierung(normalisiereRegistrierung({ ...VOLLSTAENDIG, email }))
      assert.ok(fehler.email, `„${email}" wurde durchgelassen`)
    }
  })

  test('zu lange Eingaben werden beschnitten, nicht abgewiesen', () => {
    const daten = normalisiereRegistrierung({ ...VOLLSTAENDIG, ablauf: 'x'.repeat(9000) })
    assert.equal(daten.ablauf.length, 4000)
    assert.deepEqual(pruefeRegistrierung(daten), {})
  })

  test('fehlende Felder werfen nicht, sie werden leer', () => {
    const daten = normalisiereRegistrierung({})
    assert.equal(daten.firma, '')
    assert.equal(Object.keys(pruefeRegistrierung(daten)).length, 4)
  })
})

describe('Speicherung und Weiterarbeit', () => {
  test('die Tabelle nimmt nur bekannte Stände an', async () => {
    await withRollback(async (t) => {
      const [zeile] = await t<{ id: string; status: string }[]>`
        insert into registrierungen (firma, ansprechpartner, email, ablauf)
        values ('Nordwerk GmbH', 'Mira Kessler', 'm.kessler@nordwerk.de', 'Auftragsdurchlauf')
        returning id, status`
      assert.equal(zeile.status, 'offen', 'frische Eingänge sind offen')

      await assert.rejects(
        () => t`update registrierungen set status = 'irgendwas' where id = ${zeile.id}`,
        /registrierungen_status_check|violates check constraint/,
      )
    })
  })

  test('die Drosselung findet Eingänge desselben Absenders im Zeitfenster', async () => {
    await withRollback(async (t) => {
      for (let i = 0; i < 3; i++) {
        await t`insert into registrierungen (firma, ansprechpartner, email, ablauf, ip_hash)
                values ('Flut GmbH', 'Bot', 'bot@example.com', 'x', 'hash-a')`
      }
      // Älterer Eintrag desselben Absenders — außerhalb des Fensters.
      await t`insert into registrierungen (firma, ansprechpartner, email, ablauf, ip_hash, created_at)
              values ('Flut GmbH', 'Bot', 'bot@example.com', 'x', 'hash-a', now() - interval '2 hours')`
      const [{ anzahl }] = await t<{ anzahl: number }[]>`
        select count(*)::int as anzahl from registrierungen
        where ip_hash = 'hash-a' and created_at > now() - interval '10 minutes'`
      assert.equal(anzahl, 3, 'nur die Eingänge im Fenster zählen')
    })
  })
})

describe('Bearbeitung läuft über die Registry', () => {
  test('einstellungen.registrierung_status ist registriert und nur für Admins', () => {
    const a = REGISTRY['einstellungen.registrierung_status']
    assert.ok(a, 'Aktion fehlt in der Registry')
    assert.equal(a.nurAdmin, true)
    assert.equal(a.prozessfrei, true)
    assert.equal(a.bindung, 'beleg', 'sie arbeitet an einem konkreten Eingang')
    assert.equal(aktionErlaubt(a, 'admin', []), true)
    assert.equal(aktionErlaubt(a, 'mitarbeiter', []), false)
  })

  test('das Schema kennt genau die vier Stände', () => {
    const schema = REGISTRY['einstellungen.registrierung_status'].schema
    for (const status of ['offen', 'kontaktiert', 'erledigt', 'abgelehnt']) {
      assert.equal(schema.safeParse({ status }).success, true, status)
    }
    assert.equal(schema.safeParse({ status: 'vielleicht' }).success, false)
    assert.equal(schema.safeParse({}).success, false, 'ein Stand ist Pflicht')
  })
})
