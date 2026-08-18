import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { closeDb, db, expectError, makeProduct, stockUp, withRollback } from './helpers.ts'
import { suchworte, varianteSuchen, wortstamm } from '../src/modules/ki/produkt-suche.ts'
import {
  ARGUMENTE,
  sprechenInstructions,
  sprechenWerkzeuge,
} from '../src/modules/ki/sprechen-katalog.ts'
import { runReadOnlyQuery } from '../src/modules/ki/sql-tool.ts'
import { kiKatalog } from '../src/modules/prozesse/introspektion.ts'
import { aktionErlaubt } from '../src/modules/prozesse/torwaechter.ts'
import { registrierteAktion } from '../src/modules/prozesse/registry/index.ts'

after(closeDb)

/**
 * Sprachmodus (/sprechen, Migration 0062): unscharfer Produkt-Resolver,
 * Werkzeugkatalog, Protokoll-/Sammeltabellen und die Schutzmechanismen.
 * Der WebRTC-Teil ist bewusst nicht hier — den deckt der manuelle
 * Verifikationslauf ab (Plan, Abschnitt Verifikation).
 */

describe('Sprechen: Produkt-Resolver', () => {
  test('exakte SKU gewinnt, unscharfe Wortsuche findet gesprochene Namen', async () => {
    await withRollback(async (t) => {
      const blau = await makeProduct(t, 'Mechanischer Switch Gateron Blue', { sku: 'SW-GAT-BL' })
      const rot = await makeProduct(t, 'Mechanischer Switch Gateron Red', { sku: 'SW-GAT-RD' })
      await stockUp(t, blau, 766)
      await stockUp(t, rot, 120)

      // Exakte SKU → genau ein Treffer, Bestand stimmt.
      const perSku = await varianteSuchen(t, 'SW-GAT-BL')
      assert.equal(perSku.length, 1)
      assert.equal(perSku[0].id, blau)
      assert.equal(perSku[0].bestand, 766)
      assert.equal(perSku[0].hauptlager, 766)

      // Gesprochene Wortfolge (Teilwörter, andere Reihenfolge) → trifft blau.
      const gesprochen = await varianteSuchen(t, 'switches gateron blue')
      assert.ok(gesprochen.some((v) => v.id === blau), 'Wortsuche findet Gateron Blue')
      assert.ok(!gesprochen.some((v) => v.id === rot), '"blue" schließt Red aus')
    })
  })

  test('Mehrdeutigkeit liefert Kandidaten, Fantasie liefert nichts', async () => {
    await withRollback(async (t) => {
      const blau = await makeProduct(t, 'Testschalter Gateron Blue')
      const rot = await makeProduct(t, 'Testschalter Gateron Red')
      const treffer = await varianteSuchen(t, 'testschalter gateron')
      assert.ok(treffer.some((v) => v.id === blau) && treffer.some((v) => v.id === rot),
        'beide Kandidaten erscheinen')

      assert.deepEqual(await varianteSuchen(t, 'gibtsnichtwirklich xyz'), [])
      assert.deepEqual(await varianteSuchen(t, '!!'), [], 'nur Satzzeichen → leer')
    })
  })

  test('suchworte zerlegt robust, wortstamm fängt Plurale', () => {
    assert.deepEqual(suchworte('Switches, Gateron-Blue!'), ['switches', 'gateron', 'blue'])
    assert.deepEqual(suchworte('a'), [], 'Einzelzeichen fliegen raus')
    assert.equal(wortstamm('switches'), 'switch')
    assert.equal(wortstamm('schrauben'), 'schraub')
    assert.equal(wortstamm('pcb'), 'pcb', 'kurze Wörter bleiben unangetastet')
  })
})

describe('Sprechen: Werkzeugkatalog (DB-frei)', () => {
  test('Werkzeuge vollständig, datenfrage nur auf Wunsch', () => {
    const ohne = sprechenWerkzeuge(false)
    assert.deepEqual(ohne.map((w) => w.name), [
      'produkt_bestand',
      'vorgang_sammeln',
      'aktionen_suchen',
      'sitzung_beenden',
    ])
    const mit = sprechenWerkzeuge(true)
    assert.ok(mit.some((w) => w.name === 'datenfrage'))
    for (const w of mit) {
      assert.equal(w.type, 'function')
      assert.ok(Array.isArray((w.parameters as { required?: unknown }).required),
        `${w.name} deklariert Pflichtfelder`)
    }
  })

  test('Instructions bleiben kurz — jedes Zeichen kostet in jeder Runde', () => {
    const text = sprechenInstructions({ name: 'Patrick', rolle: 'Administrator' }, 'KRNL', true)
    assert.ok(text.length < 2000, `Instructions zu lang: ${text.length} Zeichen`)
    assert.ok(text.includes('NIE direkt'), 'Sammeln-statt-Buchen steht drin')
  })

  test('Argument-Schemata weisen Müll ab', () => {
    assert.equal(ARGUMENTE.produkt_bestand.safeParse({ suchbegriff: 'x' }).success, false)
    assert.equal(ARGUMENTE.produkt_bestand.safeParse({ suchbegriff: 'Gateron' }).success, true)
    assert.equal(
      ARGUMENTE.vorgang_sammeln.safeParse({ aktion: 'lager.zaehlung_erfassen', parameter: {} })
        .success,
      false,
      'ohne Zusammenfassung keine Sammlung',
    )
    assert.equal(
      ARGUMENTE.vorgang_sammeln.safeParse({
        aktion: 'lager.zaehlung_erfassen',
        parameter: { variant_id: 'x', counted_qty: 5 },
        zusammenfassung: 'Zählung 5',
      }).success,
      true,
    )
  })

  test('Zähl-Aktionen sind KI-sichtbar, nurAdmin bleibt admin-only', () => {
    const katalog = kiKatalog().map((a) => a.name)
    assert.ok(katalog.includes('lager.zaehlung_erfassen'), 'Zählung erfassen im KI-Katalog')
    assert.ok(katalog.includes('lager.zaehlung_buchen'), 'Differenz buchen im KI-Katalog')

    const nurAdmin = registrierteAktion('finanzen.darlehen_anlegen')!
    assert.equal(aktionErlaubt(nurAdmin, 'admin', []), true)
    assert.equal(aktionErlaubt(nurAdmin, 'mitarbeiter', []), false, 'nurAdmin sperrt andere Rollen')
  })
})

describe('Sprechen: Protokoll + Sammlung (0062)', () => {
  async function protokollAnlegen(t: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    const [user] = await t<{ id: string }[]>`select id from users limit 1`
    const [p] = await t<{ id: string }[]>`
      insert into sprachprotokolle (user_id, modell) values (${user.id}, 'test') returning id`
    return p.id
  }

  test('Einträge und Vorgänge hängen am Protokoll (cascade), seq ist eindeutig', async () => {
    await withRollback(async (t) => {
      const protokoll = await protokollAnlegen(t)
      await t`insert into sprachprotokoll_eintraege (protokoll_id, rolle, text)
              values (${protokoll}, 'nutzer', 'Ich zähle 788'),
                     (${protokoll}, 'assistent', 'Im System stehen 766')`
      await t`insert into sprach_vorgaenge (protokoll_id, seq, aktion, parameter, zusammenfassung)
              values (${protokoll}, 1, 'lager.zaehlung_erfassen', '{"counted_qty":788}'::jsonb,
                      'Zählung 788 statt 766')`

      await expectError(
        t,
        (sp) => sp`insert into sprach_vorgaenge (protokoll_id, seq, aktion, parameter, zusammenfassung)
                   values (${protokoll}, 1, 'x', '{}'::jsonb, 'doppelt')`,
        /duplicate key|unique/,
      )

      await t`delete from sprachprotokolle where id = ${protokoll}`
      const [reste] = await t<{ n: number }[]>`
        select (select count(*) from sprachprotokoll_eintraege where protokoll_id = ${protokoll})::int
             + (select count(*) from sprach_vorgaenge where protokoll_id = ${protokoll})::int as n`
      assert.equal(Number(reste.n), 0, 'cascade räumt Einträge und Vorgänge ab')
    })
  })

  test('Status-Check der Vorgänge lässt nur die vier Zustände zu', async () => {
    await withRollback(async (t) => {
      const protokoll = await protokollAnlegen(t)
      await expectError(
        t,
        (sp) => sp`insert into sprach_vorgaenge (protokoll_id, seq, aktion, parameter, zusammenfassung, status)
                   values (${protokoll}, 1, 'x', '{}'::jsonb, 'kaputt', 'halbgar')`,
        /check/,
      )
    })
  })

  test('Sperrliste: Gesprächsmitschnitte sind für KI-SQL tabu', async () => {
    const ergebnis = await runReadOnlyQuery(db(), 'select * from sprachprotokoll_eintraege')
    assert.ok(ergebnis.error, 'Abfrage wird abgewiesen')
    assert.match(ergebnis.error!, /gesperrt|nicht erlaubt|verweigert/i)
  })
})
