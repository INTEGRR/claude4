import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY } from '../src/modules/prozesse/registry/index.ts'
import { aktionErlaubt } from '../src/modules/prozesse/torwaechter.ts'
import { demodatenEinspielen } from '../src/modules/demo/daten.ts'
import { closeDb, makeProduct, withRollback } from './helpers.ts'

after(closeDb)

/**
 * Erststart-Onboarding: die Weiche (Demo oder geführt) hängt an drei
 * Registry-Aktionen und einer Frisch-Erkennung im ERP-Layout. Hier wird
 * geprüft, dass die Aktionen sauber registriert sind, der Demodaten-
 * Idempotenz-Wächter greift und die Weichen-Heuristik richtig kippt.
 */
describe('Einrichtung: Registry-Aktionen', () => {
  const AKTIONEN = [
    'einstellungen.firma_speichern',
    'einstellungen.demodaten_einspielen',
    'einstellungen.einrichtung_abschliessen',
  ] as const

  test('alle drei existieren, nurAdmin und prozessfrei', () => {
    for (const name of AKTIONEN) {
      const a = REGISTRY[name]
      assert.ok(a, `${name} fehlt in der Registry`)
      assert.equal(a.nurAdmin, true, `${name} muss nurAdmin sein`)
      assert.equal(a.prozessfrei, true)
      assert.equal(a.bindung, 'frei')
      assert.equal(aktionErlaubt(a, 'admin', []), true)
      assert.equal(aktionErlaubt(a, 'mitarbeiter', []), false, `${name}: kein Mitarbeiter-Zugriff`)
    }
  })

  test('Schemata: Firma braucht einen Namen, der Abschluss einen gültigen Modus', () => {
    const firma = REGISTRY['einstellungen.firma_speichern'].schema
    assert.equal(firma.safeParse({}).success, false)
    assert.equal(firma.safeParse({ name: 'ANVIL GmbH' }).success, true, 'Rest hat Defaults')
    const abschluss = REGISTRY['einstellungen.einrichtung_abschliessen'].schema
    assert.equal(abschluss.safeParse({ modus: 'irgendwas' }).success, false)
    assert.equal(abschluss.safeParse({ modus: 'demo' }).success, true)
    assert.equal(abschluss.safeParse({ modus: 'gefuehrt' }).success, true)
  })
})

describe('Einrichtung: Demodaten-Wächter und Weichen-Heuristik', () => {
  test('Demodaten verweigern sich einem Bestand mit Produkten', async () => {
    await withRollback(async (t) => {
      await makeProduct(t, 'Bestandsware')
      await assert.rejects(() => demodatenEinspielen(t), /bereits Produkte/)
    })
  })

  test('die Frisch-Erkennung kippt mit dem settings-Schlüssel', async () => {
    await withRollback(async (t) => {
      const offen = async () => {
        const [zeile] = await t<{ offen: boolean }[]>`
          select not exists (select 1 from settings where key = 'einrichtung')
             and (select value ->> 'name' from settings where key = 'company') = 'Meine Firma GmbH'
             and (select count(*) from users) = 1 as offen`
        return zeile.offen
      }
      // Eingerichtete Instanz (Demodaten, mehrere Nutzer): Weiche bleibt zu.
      assert.equal(await offen(), false)
      // Selbst wenn alles andere „frisch" aussähe: der Schlüssel gewinnt —
      // er überlebt auch die Gefahrenzone (demodaten_loeschen behält settings).
      await t`insert into settings (key, value)
              values ('einrichtung', '{"abgeschlossen": true, "modus": "gefuehrt"}')
              on conflict (key) do update set value = excluded.value`
      assert.equal(await offen(), false)
    })
  })
})
