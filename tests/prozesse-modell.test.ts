/**
 * Das Prozessmodell in der Datenbank (Migration 0036/0037): Bedingungssprache,
 * Belegstandort, nächste Schritte, Overrides, Versionspflege mit Validierung
 * und die beleglosen Instanzen.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { TransactionSql } from 'postgres'
import { closeDb, db, expectError, withRollback } from './helpers.ts'

after(closeDb)

const pruefe = async (t: TransactionSql, daten: object, bedingung: object | null) => {
  const [row] = await t<{ ok: boolean }[]>`
    select bedingung_pruefen(${t.json(daten as never)}, ${bedingung ? t.json(bedingung as never) : null}) as ok`
  return row.ok
}

describe('Prozessmodell: Bedingungssprache', () => {
  test('Vergleiche, Mengen, Verknüpfungen', async () => {
    await withRollback(async (t) => {
      const beleg = { state: 'sale', total: '250.50', tags: null, name: 'A-100' }

      assert.equal(await pruefe(t, beleg, null), true, 'null = immer')
      assert.equal(await pruefe(t, beleg, { feld: 'state', op: '=', wert: 'sale' }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'state', op: '!=', wert: 'draft' }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'state', op: 'in', wert: ['draft', 'sale'] }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'total', op: '>', wert: 200 }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'total', op: '<=', wert: 250.5 }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'total', op: '>', wert: 300 }), false)
      assert.equal(await pruefe(t, beleg, { feld: 'tags', op: 'leer' }), true)
      assert.equal(await pruefe(t, beleg, { feld: 'name', op: 'beginnt_mit', wert: 'A-' }), true)
      // "250.50" und 250.5 müssen numerisch gleich sein.
      assert.equal(await pruefe(t, beleg, { feld: 'total', op: '=', wert: 250.5 }), true)

      assert.equal(
        await pruefe(t, beleg, {
          alle: [
            { feld: 'state', op: '=', wert: 'sale' },
            { eine: [{ feld: 'total', op: '>', wert: 1000 }, { feld: 'tags', op: 'leer' }] },
          ],
        }),
        true,
      )
      assert.equal(await pruefe(t, beleg, { nicht: { feld: 'state', op: '=', wert: 'sale' } }), false)

      await expectError(t, (sp) => sp`select bedingung_pruefen('{}', '{"feld":"x","op":"??"}')`,
        /Unbekannter Operator/)
    })
  })
})

describe('Prozessmodell: Standort und nächste Schritte', () => {
  test('ein Ticket wandert durch den Bug-Prozess', async () => {
    await withRollback(async (t) => {
      const [ticket] = await t<{ id: string }[]>`
        insert into bug_reports (number, titel, gemeldet_von, status)
        values ('BUG/99999', 'Testfall', 'test', 'offen') returning id`

      assert.equal(
        (await t<{ s: string }[]>`select prozess_aktueller_schritt('bug_ticket', ${ticket.id}) as s`)[0].s,
        'melden',
      )

      let naechste = await t<{ code: string }[]>`
        select code from prozess_naechste_schritte('bug_ticket', ${ticket.id}) order by code`
      assert.deepEqual(naechste.map((n) => n.code), ['uebernehmen', 'verwerfen'])

      await t`update bug_reports set status = 'in_arbeit' where id = ${ticket.id}`
      const inArbeit = await t<{ code: string; params: { status?: string } }[]>`
        select code, params from prozess_naechste_schritte('bug_ticket', ${ticket.id}) order by code`
      assert.deepEqual(inArbeit.map((n) => n.code), ['beheben', 'verwerfen'])
      // Die Schritt-params tragen den vorbelegten Zielstatus.
      assert.equal(inArbeit[0].params.status, 'behoben')

      await t`update bug_reports set status = 'behoben' where id = ${ticket.id}`
      naechste = await t<{ code: string }[]>`
        select code from prozess_naechste_schritte('bug_ticket', ${ticket.id})`
      assert.equal(naechste.length, 0, 'behoben ist ein Endzustand')
    })
  })

  test('das XOR der Reparatur folgt der Garantie', async () => {
    await withRollback(async (t) => {
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde', true) returning id`
      const [uom] = await t<{ id: string }[]>`select id from uoms where name = 'Stück'`
      const [tpl] = await t<{ id: string }[]>`
        insert into product_templates (name, uom_id) values ('Gerät', ${uom.id}) returning id`
      await t`select generate_variants(${tpl.id})`
      const [variante] = await t<{ id: string }[]>`
        select id from product_variants where template_id = ${tpl.id}`

      const repair = async (garantie: boolean) => {
        const [r] = await t<{ id: string }[]>`
          insert into repair_orders (number, partner_id, variant_id, qty, under_warranty, state)
          values (next_sequence('repair'), ${partner.id}, ${variante.id}, 1, ${garantie}, 'repaired')
          returning id`
        return t<{ code: string }[]>`
          select code from prozess_naechste_schritte('reparatur', ${r.id})`
      }

      // Kostenpflichtig → das Angebot ist der nächste Schritt.
      assert.deepEqual((await repair(false)).map((n) => n.code), ['angebot'])
      // Garantie → direkt zum Ende, kein Angebot.
      assert.deepEqual((await repair(true)).map((n) => n.code), [])
    })
  })

  test('Overrides schalten optionale Schritte ab, Nachfolger rücken nach', async () => {
    await withRollback(async (t) => {
      const [partner] = await t<{ id: string }[]>`
        insert into partners (name, is_customer) values ('Kunde', true) returning id`
      const [uom] = await t<{ id: string }[]>`select id from uoms where name = 'Stück'`
      const [tpl] = await t<{ id: string }[]>`
        insert into product_templates (name, uom_id) values ('Gerät', ${uom.id}) returning id`
      await t`select generate_variants(${tpl.id})`
      const [variante] = await t<{ id: string }[]>`
        select id from product_variants where template_id = ${tpl.id}`
      const [r] = await t<{ id: string }[]>`
        insert into repair_orders (number, partner_id, variant_id, qty, state)
        values (next_sequence('repair'), ${partner.id}, ${variante.id}, 1, 'under_repair')
        returning id`

      const vorher = await t<{ code: string }[]>`
        select code from prozess_naechste_schritte('reparatur', ${r.id}) order by code`
      assert.deepEqual(vorher.map((n) => n.code), ['abschliessen', 'stornieren', 'teile'])

      // Firma will keine Teileerfassung: optionaler Schritt aus.
      await t`insert into prozess_overrides (prozess_code, schritt_code, aktiv)
              values ('reparatur', 'teile', false)`
      const nachher = await t<{ code: string }[]>`
        select code from prozess_naechste_schritte('reparatur', ${r.id}) order by code`
      assert.deepEqual(nachher.map((n) => n.code), ['abschliessen', 'stornieren'])
    })
  })
})

describe('Prozessmodell: Versionspflege', () => {
  test('Kopie und Aktivierung; die Validierung hält kaputte Entwürfe zurück', async () => {
    await withRollback(async (t) => {
      const [kopie] = await t<{ id: string }[]>`select prozess_version_kopieren('bug_ticket') as id`

      const [zaehlung] = await t<{ schritte: number; kanten: number }[]>`
        select (select count(*)::int from prozess_schritte where version_id = ${kopie.id}) as schritte,
               (select count(*)::int from prozess_uebergaenge where version_id = ${kopie.id}) as kanten`
      assert.equal(zaehlung.schritte, 6)
      assert.equal(zaehlung.kanten, 7)

      // Doppelter Zustand macht den Standort mehrdeutig → Ablehnung.
      await t`update prozess_schritte set zustand = 'offen'
              where version_id = ${kopie.id} and code = 'uebernehmen'`
      await expectError(t, (sp) => sp`select prozess_version_aktivieren(${kopie.id})`,
        /Zustand .* Schritten zugeordnet/)
      await t`update prozess_schritte set zustand = 'in_arbeit'
              where version_id = ${kopie.id} and code = 'uebernehmen'`

      // Unerreichbarer Schritt → Ablehnung.
      await t`insert into prozess_schritte (version_id, code, name, art, aktion)
              values (${kopie.id}, 'insel', 'Insel', 'aktion', 'fehler.ticket_status')`
      await expectError(t, (sp) => sp`select prozess_version_aktivieren(${kopie.id})`,
        /erreichbar/)
      await t`delete from prozess_schritte where version_id = ${kopie.id} and code = 'insel'`

      // Schleife → Ablehnung.
      const [schleife] = await t<{ id: string }[]>`
        insert into prozess_uebergaenge (version_id, von_code, nach_code)
        values (${kopie.id}, 'beheben', 'uebernehmen') returning id`
      await expectError(t, (sp) => sp`select prozess_version_aktivieren(${kopie.id})`,
        /Schleife/)
      await t`delete from prozess_uebergaenge where id = ${schleife.id}`

      // Sauber → Aktivierung schaltet um, alte Version archiviert.
      await t`select prozess_version_aktivieren(${kopie.id})`
      const versionen = await t<{ version: number; status: string }[]>`
        select v.version, v.status from prozess_versionen v
        join prozesse p on p.id = v.prozess_id
        where p.code = 'bug_ticket' order by v.version`
      // postgres.js liefert ein Result-Objekt — für den Vergleich in ein
      // schlichtes Array mit echten Zahlen überführen.
      assert.deepEqual(
        versionen.map((v) => ({ version: Number(v.version), status: v.status })),
        [
          { version: 1, status: 'archiviert' },
          { version: 2, status: 'aktiv' },
        ],
      )
    })
  })
})

describe('Prozessmodell: beleglose Instanzen', () => {
  test('starten, weiterschalten, fertig — beleggebundene Prozesse lehnen ab', async () => {
    await withRollback(async (t) => {
      await expectError(t, (sp) => sp`select prozess_instanz_starten('reparatur', 'test')`,
        /beleggebunden/)

      // Eigener beleg­loser Miniprozess für den Test.
      const [p] = await t<{ id: string }[]>`
        insert into prozesse (code, name, bereich, modell)
        values ('test_assistent', 'Testassistent', 'lager', null) returning id`
      const [v] = await t<{ id: string }[]>`
        insert into prozess_versionen (prozess_id, version, status)
        values (${p.id}, 1, 'aktiv') returning id`
      await t`insert into prozess_schritte (version_id, code, name, art, sequence, aktion) values
        (${v.id}, 'start', 'Start', 'start', 0, null),
        (${v.id}, 's1', 'Schritt 1', 'aktion', 10, 'lager.zaehlung_erfassen'),
        (${v.id}, 'ende', 'Ende', 'ende', 20, null)`
      await t`insert into prozess_uebergaenge (version_id, von_code, nach_code) values
        (${v.id}, 'start', 's1'), (${v.id}, 's1', 'ende')`

      const [instanz] = await t<{ id: string }[]>`
        select prozess_instanz_starten('test_assistent', 'test') as id`
      const [kopf] = await t<{ number: string; schritt_code: string; status: string }[]>`
        select number, schritt_code, status from prozess_instanzen where id = ${instanz.id}`
      assert.match(kopf.number, /^PRZ\//)
      assert.equal(kopf.schritt_code, 'start')
      assert.equal(kopf.status, 'laufend')

      await t`select prozess_instanz_weiter(${instanz.id}, 's1', ${t.json({ zaehlung_id: 'x' } as never)}, 'test')`
      const [fertig] = await t<{ schritt_code: string; status: string; daten: { zaehlung_id?: string } }[]>`
        select schritt_code, status, daten from prozess_instanzen where id = ${instanz.id}`
      // Nach s1 führt nur noch die Kante zum Ende → Instanz ist fertig.
      assert.equal(fertig.status, 'fertig')
      assert.equal(fertig.daten.zaehlung_id, 'x')

      await expectError(t, (sp) => sp`select prozess_instanz_weiter(${instanz.id}, 's1', '{}', 'test')`,
        /bereits fertig/)
    })
  })
})
