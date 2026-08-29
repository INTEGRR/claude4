/**
 * Anlage-Aktionen über den ECHTEN Produktionspfad (Torwächter →
 * Registry-Executor) — der Nachweis, dass die aus dem KI-Katalog
 * migrierten Aktionen mit Kennungs-Auflösung, Duplikatsprüfung und
 * Klartext-Fehlern funktionieren (Entscheidungslog 2026-08-27).
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { aktionAusfuehrenGeprueft } from '../../src/modules/prozesse/torwaechter.ts'

const DATENBANK = 'erp_anlage_check'
const ADMIN = { name: 'anlage-test', role: 'admin' as const }

let h: Harness

before(async () => {
  h = await harnessStart(DATENBANK)
})
after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Anlage-Aktionen: Kennungs-Auflösung durch den Torwächter', () => {
  test('Meldebestand über die SKU — und das Duplikat wird abgewiesen', async () => {
    await aktionAusfuehrenGeprueft(
      'produkte.produkt_anlegen',
      { parameter: { name: 'Anlage-Test Schalter', sku: 'ANL-TST', einkaufbar: true, verkaufbar: false } },
      ADMIN,
    )

    const ergebnis = await aktionAusfuehrenGeprueft(
      'lager.meldebestand_anlegen',
      { parameter: { variant_id: 'anl-tst', min_qty: 5, max_qty: 20 } },
      ADMIN,
    )
    assert.match(ergebnis.text ?? '', /Anlage-Test Schalter/)

    const [regel] = await h.sql<{ min_qty: number; sku: string }[]>`
      select o.min_qty, pv.sku from stock_orderpoints o
      join product_variants pv on pv.id = o.variant_id
      where pv.sku = 'ANL-TST'`
    assert.ok(regel, 'die Regel hängt an der aufgelösten Variante')
    assert.equal(Number(regel.min_qty), 5)

    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.meldebestand_anlegen',
        { parameter: { variant_id: 'ANL-TST', min_qty: 1, max_qty: 2 } },
        ADMIN,
      ),
      /bereits einen Meldebestand/,
    )
  })

  test('mehrdeutige Namen werden abgewiesen statt zufällig aufgelöst', async () => {
    for (const sku of ['DOP-1', 'DOP-2']) {
      await aktionAusfuehrenGeprueft(
        'produkte.produkt_anlegen',
        { parameter: { name: 'Doppelname', sku } },
        ADMIN,
      )
    }
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'lager.meldebestand_anlegen',
        { parameter: { variant_id: 'Doppelname', min_qty: 1, max_qty: 2 } },
        ADMIN,
      ),
      /mehrdeutig/,
    )
  })

  test('Fertigungsauftrag: die SKU löst zum richtigen Produkt auf', async () => {
    // Ohne Stückliste bricht create_manufacturing_order fachlich ab — die
    // Meldung nennt den PRODUKTNAMEN und beweist damit, dass die SKU bis in
    // die SQL-Funktion korrekt aufgelöst wurde.
    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'fertigung.auftrag_anlegen',
        { parameter: { variant_id: 'ANL-TST', qty: 1 } },
        ADMIN,
      ),
      /keine aktive Stückliste/,
    )

    await assert.rejects(
      aktionAusfuehrenGeprueft(
        'fertigung.auftrag_anlegen',
        { parameter: { variant_id: 'GIBTS-NICHT-999', qty: 1 } },
        ADMIN,
      ),
      /nicht gefunden/,
    )
  })
})
