import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ROWS, runReadOnlyQuery } from '../src/modules/ki/sql-tool.ts'
import { closeDb, db } from './helpers.ts'

after(closeDb)

describe('KI: SQL-Werkzeug (Schutzmechanismen)', () => {
  test('einfache Leseabfrage funktioniert', async () => {
    const result = await runReadOnlyQuery(db(), 'select 1 as eins')
    assert.equal(result.error, undefined)
    assert.equal(result.rows?.[0].eins, 1)
  })

  test('Schreibversuche scheitern an der Read-only-Transaktion', async () => {
    for (const query of [
      "insert into partners (name) values ('KI-Eindringling')",
      "update product_templates set list_price = 0",
      "delete from stock_moves",
      "create table ki_tmp (id int)",
    ]) {
      const result = await runReadOnlyQuery(db(), query)
      assert.ok(result.error, `sollte scheitern: ${query}`)
      assert.match(result.error!, /read-only|gesperrte/i)
    }
  })

  test('gesperrte Tabellen und Spalten werden abgewiesen', async () => {
    for (const query of [
      'select * from users',
      'select token from sessions',
      'select value from settings',
      'select password_hash from partners',
      'select * from integration_jobs',
    ]) {
      const result = await runReadOnlyQuery(db(), query)
      assert.ok(result.error, `sollte blockiert werden: ${query}`)
      assert.match(result.error!, /gesperrte Tabellen/)
    }
  })

  test('Ergebnisse werden auf die Zeilengrenze gekappt', async () => {
    const result = await runReadOnlyQuery(db(), `select generate_series(1, ${MAX_ROWS + 100}) as n`)
    assert.equal(result.error, undefined)
    assert.equal(result.rows?.length, MAX_ROWS)
    assert.equal(result.gekappt, true)
  })

  test('Syntaxfehler kommen als Fehlermeldung zurück, nicht als Absturz', async () => {
    const result = await runReadOnlyQuery(db(), 'select kaputt from')
    assert.ok(result.error)
  })
})

// --- Diagramme und schreibende Aktionen (Ausbau) ---------------------------

describe('Diagramm-Vorgaben des Agenten', () => {
  test('Säulendiagramm braucht zu jeder Kategorie einen Wert', async () => {
    const { diagrammSchema } = await import('../src/modules/ki/diagramm.ts')

    const gut = diagrammSchema.safeParse({
      art: 'saeulen',
      titel: 'Umsatz je Monat',
      einheit: '€',
      kategorien: ['2026-01', '2026-02'],
      serien: [{ name: 'Umsatz', werte: [100, 200] }],
    })
    assert.ok(gut.success, 'passende Längen werden angenommen')

    const schief = diagrammSchema.safeParse({
      art: 'saeulen',
      titel: 'Umsatz je Monat',
      kategorien: ['2026-01', '2026-02', '2026-03'],
      serien: [{ name: 'Umsatz', werte: [100, 200] }],
    })
    assert.equal(schief.success, false, 'zu wenige Werte werden abgelehnt')
    if (!schief.success) {
      assert.match(schief.error.issues[0].message, /Kategorien/)
    }
  })

  test('Balken und Anteile brauchen Punkte', async () => {
    const { diagrammSchema } = await import('../src/modules/ki/diagramm.ts')
    assert.equal(
      diagrammSchema.safeParse({ art: 'balken', titel: 'Top 5' }).success,
      false,
      'ohne punkte kein Diagramm',
    )
    assert.ok(
      diagrammSchema.safeParse({
        art: 'anteile',
        titel: 'Wertanteile',
        punkte: [{ label: 'A', wert: 3 }],
      }).success,
    )
  })
})

describe('Schreibende Aktionen', () => {
  test('unbekannte Aktionen werden abgewiesen', async () => {
    const { aktionPruefen } = await import('../src/modules/ki/aktionen.ts')
    assert.throws(
      () => aktionPruefen('tabelle_loeschen', {}),
      /Unbekannte Aktion/,
      'der Katalog ist abschließend',
    )
  })

  test('fehlende Felder nennen die Ursache im Klartext', async () => {
    const { aktionPruefen } = await import('../src/modules/ki/aktionen.ts')
    assert.throws(() => aktionPruefen('kontakt_anlegen', { email: 'keine-adresse' }), /name|email/)
    assert.throws(() => aktionPruefen('fertigungsauftrag_anlegen', { produkt: 'X', menge: -1 }), /menge/)
  })

  test('jede Aktion nennt einen Bereich, der der Rechtematrix bekannt ist', async () => {
    const { AKTIONEN } = await import('../src/modules/ki/aktionen.ts')
    const { canWrite } = await import('../src/modules/auth/permissions.ts')
    for (const [name, a] of Object.entries(AKTIONEN)) {
      assert.equal(typeof a.bereich, 'string', `${name} ohne Bereich`)
      // canWrite darf für keinen Bereich stolpern und der Admin darf überall
      assert.equal(canWrite('admin', a.bereich), true, `${name}: Admin muss dürfen`)
    }
  })

  test('gültige Felder kommen typisiert mit Vorgabewerten zurück', async () => {
    const { aktionPruefen } = await import('../src/modules/ki/aktionen.ts')
    const { aktion, werte } = aktionPruefen('kontakt_anlegen', { name: 'Muster GmbH' })
    assert.equal(aktion.bereich, 'kontakte')
    assert.equal(werte.kunde, true, 'Vorgabe: Kunde')
    assert.equal(werte.lieferant, false)
    assert.match(aktion.zusammenfassung(werte), /Muster GmbH/)
  })

  test('der Fertigungsmitarbeiter darf über die KI keinen Kunden anlegen', async () => {
    const { AKTIONEN } = await import('../src/modules/ki/aktionen.ts')
    const { canWrite } = await import('../src/modules/auth/permissions.ts')
    assert.equal(canWrite('fertigung', AKTIONEN.kontakt_anlegen.bereich), false)
    assert.equal(canWrite('fertigung', AKTIONEN.fertigungsauftrag_anlegen.bereich), true)
  })
})
