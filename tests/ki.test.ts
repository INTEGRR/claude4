import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ERGEBNIS_ZEICHEN,
  MAX_ROWS,
  ergebnisFuerModell,
  runReadOnlyQuery,
} from '../src/modules/ki/sql-tool.ts'
import { produktAnlegen } from '../src/modules/ki/produkt-anlegen.ts'
import { closeDb, db, withRollback } from './helpers.ts'

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

  test('kleine Ergebnisse gehen unverändert ans Modell', () => {
    const text = ergebnisFuerModell({ rows: [{ eins: 1 }], rowCount: 1 })
    assert.deepEqual(JSON.parse(text), { zeilen: 1, daten: [{ eins: 1 }] })
  })

  test('sehr große Ergebnisse werden nach Zeichen gekürzt, mit Hinweis', () => {
    // 500 breite Zeilen à ~400 Zeichen ≈ 200k Zeichen — real passiert mit
    // den importierten Echtdaten (die 30-Euro-Auswertung).
    const breit = Array.from({ length: MAX_ROWS }, (_, i) => ({
      nr: i,
      beschreibung: 'x'.repeat(400),
    }))
    const text = ergebnisFuerModell({ rows: breit, rowCount: MAX_ROWS, gekappt: false })
    assert.ok(text.length <= MAX_ERGEBNIS_ZEICHEN, `zu groß: ${text.length}`)
    const geparst = JSON.parse(text) as { zeilen: number; hinweis: string; daten: unknown[] }
    assert.equal(geparst.zeilen, MAX_ROWS)
    assert.ok(geparst.daten.length < MAX_ROWS)
    assert.match(geparst.hinweis, /gekürzt|aggregieren/)
  })

  test('Fehler bleiben Fehlertext', () => {
    assert.equal(ergebnisFuerModell({ error: 'kaputt' }), 'Fehler: kaputt')
  })
})

describe('KI: Modellwahl je Ebene (Einstellung vor Env vor Standard)', () => {
  test('gespeicherte Katalog-Modelle gewinnen', async () => {
    const { modellAufloesen } = await import('../src/modules/ki/modelle.ts')
    assert.equal(
      modellAufloesen({ auswertung: 'claude-sonnet-5' }, 'auswertung', { ANTHROPIC_MODEL: 'x' }),
      'claude-sonnet-5',
    )
  })

  test('Tippfehler in der Einstellung fällt still auf Env bzw. Standard zurück', async () => {
    const { modellAufloesen } = await import('../src/modules/ki/modelle.ts')
    assert.equal(
      modellAufloesen({ auswertung: 'gpt-99' }, 'auswertung', { ANTHROPIC_MODEL: 'notausgang' }),
      'notausgang',
    )
    assert.equal(modellAufloesen({ auswertung: 'gpt-99' }, 'auswertung', {}), 'claude-opus-5')
    assert.equal(modellAufloesen(null, 'datenfrage', {}), 'claude-haiku-4-5-20251001')
  })

  test('Env-Reihenfolge: AUFNAHME_MODELL vor ANTHROPIC_MODEL für Prozess-Ebene', async () => {
    const { modellAufloesen } = await import('../src/modules/ki/modelle.ts')
    assert.equal(
      modellAufloesen(null, 'prozess', { AUFNAHME_MODELL: 'a', ANTHROPIC_MODEL: 'b' }),
      'a',
    )
  })

  test('Registry-Aktion existiert und lehnt Nicht-Katalog-Modelle ab', async () => {
    const { REGISTRY } = await import('../src/modules/prozesse/registry/index.ts')
    const aktion = REGISTRY['einstellungen.ki_modelle_setzen']
    assert.ok(aktion)
    assert.equal(aktion.nurAdmin, true)
    const gut = aktion.schema.safeParse({
      auswertung: 'claude-sonnet-5',
      prozess: 'claude-opus-5',
      interview: 'claude-opus-5',
      datenfrage: 'claude-haiku-4-5-20251001',
    })
    assert.equal(gut.success, true)
    const schlecht = aktion.schema.safeParse({
      auswertung: 'irgendwas',
      prozess: 'claude-opus-5',
      interview: 'claude-opus-5',
      datenfrage: 'claude-haiku-4-5-20251001',
    })
    assert.equal(schlecht.success, false)
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
    const torwaechter = await import('../src/modules/prozesse/torwaechter.ts')
    // Beleggebunden: ohne record_id kommt die Bindung zu Wort, mit ihr das Schema.
    assert.throws(
      () => torwaechter.aktionPruefen('notiz.anlegen', { parameter: { text: 'x' } }),
      /braucht die ID/,
    )
    assert.throws(
      () =>
        torwaechter.aktionPruefen('notiz.anlegen', {
          recordId: '00000000-0000-4000-8000-000000000000',
          parameter: { text: '' },
        }),
      /model|text/,
    )
    assert.throws(
      () =>
        torwaechter.aktionPruefen('kontakte.partner_anlegen', {
          parameter: { name: 'X', is_company: true, email: 'keine-adresse' },
        }),
      /email/,
    )
    assert.throws(
      () =>
        torwaechter.aktionPruefen('fertigung.auftrag_anlegen', {
          parameter: { variant_id: 'X', qty: -1 },
        }),
      /qty/,
    )
  })

  test('der Alt-Katalog bleibt leer — neue Aktionen gehören in die Registry', async () => {
    const { AKTIONEN } = await import('../src/modules/ki/aktionen.ts')
    assert.deepEqual(
      Object.keys(AKTIONEN),
      [],
      'Anlage-Aktionen laufen seit der Katalog-Auflösung durch den Torwächter (Entscheidungslog 2026-08-27)',
    )
  })

  test('gültige Felder kommen typisiert mit Vorgabewerten zurück', async () => {
    const { aktionPruefen } = await import('../src/modules/prozesse/torwaechter.ts')
    const { aktion, werte } = aktionPruefen('kontakte.partner_anlegen', {
      parameter: { name: 'Muster GmbH', is_company: true },
    })
    assert.equal(aktion.bereich, 'kontakte')
    assert.equal(werte.is_customer, true, 'Vorgabe: Kunde')
    assert.equal(werte.is_vendor, false)
    assert.match(aktion.zusammenfassung!(werte), /Muster GmbH/)
  })

  // Die Produktanlage lebt seit der Katalog-Auflösung in der Registry —
  // geprüft wird sie deshalb über den Torwächter (derselbe Weg wie im
  // Betrieb), nicht mehr über den KI-Katalog.
  test('Produkt mit Attributen: Variantenzahl steht in der Zusammenfassung', async () => {
    const { aktionPruefen } = await import('../src/modules/prozesse/torwaechter.ts')
    const { aktion, werte } = aktionPruefen('produkte.produkt_anlegen', {
      parameter: {
        name: 'Anvil Native 1800',
        verkaufspreis: 349,
        sku: 'AN1800',
        attribute: [
          {
            name: 'Farbe',
            werte: [
              { name: 'Schwarz', kuerzel: 'BK' },
              { name: 'Blau', kuerzel: 'BL' },
              { name: 'Grün', kuerzel: 'GN' },
            ],
          },
          {
            name: 'Switch',
            werte: [
              { name: 'Gateron HE 1', kuerzel: 'HE1' },
              { name: 'Gateron HE 2', kuerzel: 'HE2' },
              { name: 'Gateron HE 3', kuerzel: 'HE3' },
              { name: 'Gateron HE 4', kuerzel: 'HE4' },
            ],
          },
        ],
      },
    })
    assert.equal(aktion.bereich, 'produkte')
    assert.equal(werte.verkaufbar, true, 'Vorgabe: verkaufbar')
    // 3 × 4 — die Zahl muss im Bestätigungstext stehen, sonst bestätigt
    // niemand bewusst zwölf neue Varianten.
    assert.match(aktion.zusammenfassung!(werte), /12 Varianten/)
    assert.match(aktion.zusammenfassung!(werte), /Anvil Native 1800/)
  })

  test('die Variantenmatrix ist gedeckelt', async () => {
    const { aktionPruefen } = await import('../src/modules/prozesse/torwaechter.ts')
    const viele = (n: number, praefix: string) =>
      Array.from({ length: n }, (_, i) => ({ name: `${praefix}${i}` }))
    assert.throws(
      () =>
        aktionPruefen('produkte.produkt_anlegen', {
          parameter: {
            name: 'Zu viel',
            attribute: [
              { name: 'A', werte: viele(20, 'a') },
              { name: 'B', werte: viele(20, 'b') },
            ],
          },
        }),
      /200 Varianten/,
    )
    // Vier Attribute sind unabhängig davon zu viel.
    assert.throws(
      () =>
        aktionPruefen('produkte.produkt_anlegen', {
          parameter: {
            name: 'Zu tief',
            attribute: [1, 2, 3, 4].map((i) => ({ name: `A${i}`, werte: [{ name: 'x' }] })),
          },
        }),
      /attribute/,
    )
  })

  test('Produkt ohne Attribute ist erlaubt (Einkaufsteil)', async () => {
    const { aktionPruefen } = await import('../src/modules/prozesse/torwaechter.ts')
    const { aktion, werte } = aktionPruefen('produkte.produkt_anlegen', {
      parameter: {
        name: 'Gateron HE 1',
        verkaufbar: false,
        einkaufbar: true,
        route: 'kaufen',
        einstandspreis: 0.55,
      },
    })
    assert.equal(werte.verkaufbar, false)
    assert.deepEqual(werte.attribute, [])
    assert.match(aktion.zusammenfassung!(werte), /ohne Varianten/)
  })

  test('Produktanlage erzeugt die volle Matrix mit Artikelnummern', async () => {
    await withRollback(async (t) => {
      const ergebnis = await produktAnlegen(
        t,
        {
          name: 'Anvil Native 1800',
          verkaufspreis: 349,
          sku: 'AN1800',
          route: 'fertigen',
          attribute: [
            {
              name: 'Farbe',
              werte: [
                { name: 'Schwarz', kuerzel: 'BK', farbe: '#1a1a1a' },
                { name: 'Blau', kuerzel: 'BL' },
                { name: 'Grün', kuerzel: 'GN', aufpreis: 10 },
              ],
            },
            {
              name: 'Switch',
              werte: [1, 2, 3, 4].map((n) => ({ name: `Gateron HE ${n}`, kuerzel: `HE${n}` })),
            },
          ],
        },
        'test',
      )

      assert.equal(ergebnis.varianten, 12, '3 Farben × 4 Switches')
      assert.equal(ergebnis.benannt, 12, 'jede Variante bekommt eine Artikelnummer')

      const skus = await t<{ sku: string }[]>`
        select sku from product_variants where template_id = ${ergebnis.templateId} order by sku`
      assert.equal(skus.length, 12)
      assert.ok(
        skus.some((s) => s.sku === 'AN1800-GN-HE3'),
        `Kürzel müssen in der Nummer landen, bekommen: ${skus.map((s) => s.sku).join(', ')}`,
      )

      // Der Aufpreis der grünen Variante muss an der Variante ankommen.
      const [gruen] = await t<{ price_extra: number }[]>`
        select price_extra from product_variants
        where template_id = ${ergebnis.templateId} and sku = 'AN1800-GN-HE1'`
      assert.equal(Number(gruen.price_extra), 10)
    })
  })

  test('vorhandene Attribute werden wiederverwendet, fehlende Werte ergänzt', async () => {
    await withRollback(async (t) => {
      // „Farbe" existiert in den Beispieldaten; wird sie doppelt angelegt,
      // stünden im Produktformular zwei gleichnamige Attribute zur Wahl.
      const [attribut] = await t<{ id: string }[]>`
        insert into product_attributes (name) values ('Farbe')
        on conflict (name) do update set name = excluded.name returning id`
      await t`
        insert into product_attribute_values (attribute_id, name) values (${attribut.id}, 'Schwarz')
        on conflict do nothing`

      const ergebnis = await produktAnlegen(
        t,
        {
          name: 'Testtastatur',
          attribute: [{ name: 'Farbe', werte: [{ name: 'Schwarz' }, { name: 'Neongelb' }] }],
        },
        'test',
      )

      const [{ anzahl }] = await t<{ anzahl: number }[]>`
        select count(*)::int as anzahl from product_attributes where name = 'Farbe'`
      assert.equal(anzahl, 1, 'kein zweites Attribut „Farbe"')
      assert.equal(ergebnis.varianten, 2)

      const werte = await t<{ name: string }[]>`
        select name from product_attribute_values where attribute_id = ${attribut.id}`
      assert.ok(werte.some((w) => w.name === 'Neongelb'), 'neuer Wert wurde ergänzt')
    })
  })

  test('der Fertigungsmitarbeiter darf über die KI keinen Kunden anlegen', async () => {
    const { registrierteAktion } = await import('../src/modules/prozesse/registry/index.ts')
    const { canWrite } = await import('../src/modules/auth/permissions.ts')
    // Die Rechte hängen am Bereich der Registry-Aktion — transportunabhängig:
    // KI-Chat, Maske und Prozesstest laufen alle durch dieselbe Prüfung.
    assert.equal(canWrite('fertigung', registrierteAktion('kontakte.partner_anlegen')!.bereich), false)
    assert.equal(canWrite('fertigung', registrierteAktion('fertigung.auftrag_anlegen')!.bereich), true)
  })
})

describe('KI: Schema-Doku wächst mit dem Schema (Wächter)', () => {
  /**
   * Handgepflegte Doku + dieser Test = die Doku KANN nicht veralten: Jede
   * neue Tabelle einer Migration muss entweder in SCHEMA_DOKU /
   * SCHEMA_DOKU_FINANZEN beschrieben werden oder hier BEWUSST mit Begründung
   * versteckt sein — sonst wird die Suite rot (Muster: Registry-Abdeckung).
   */
  const VERSTECKT = new Set([
    'schema_migrations',        // Runner-Buchhaltung, kein Fachinhalt
    'users',                    // Passworthashes — per Sperrliste blockiert
    'sessions',                 // Sitzungstokens — per Sperrliste blockiert
    'settings',                 // API-Schlüssel möglich — per Sperrliste blockiert
    'integration_jobs',         // Outbox mit Payloads — per Sperrliste blockiert
    'sprachprotokolle',         // Gesprächsmitschnitte — per Sperrliste blockiert
    'sprachprotokoll_eintraege',
    'sprach_vorgaenge',
    'nutzungs_zaehler',         // Lern-Gedächtnis des Befehlsfelds, personenbezogen
    'shopify_webhook_events',   // Shopify-Rohpayloads, nur für den Import
  ])

  test('jede Tabelle ist dokumentiert oder bewusst versteckt', async () => {
    const { SCHEMA_DOKU, SCHEMA_DOKU_FINANZEN } = await import(
      '../src/modules/ki/schema-doku.ts'
    )
    const doku = SCHEMA_DOKU + SCHEMA_DOKU_FINANZEN
    const tabellen = await db()<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
      order by table_name`
    const fehlen = tabellen
      .map((t) => t.table_name)
      .filter((name) => !VERSTECKT.has(name) && !doku.includes(name))
    assert.deepEqual(
      fehlen,
      [],
      `Nicht in der Schema-Doku und nicht bewusst versteckt:\n${fehlen.join('\n')}\n` +
        '→ in SCHEMA_DOKU(_FINANZEN) beschreiben oder mit Begründung in VERSTECKT aufnehmen.',
    )
  })
})
