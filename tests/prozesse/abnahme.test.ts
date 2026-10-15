/**
 * Abnahmetest, Teil 2 — das feste Drei-Monats-Szenario live gegen das
 * Modell (Entscheidungslog 2026-10-15). Der Interpreter steht in
 * tests/abnahme/live.ts, der Plan in tests/abnahme/szenario.ts; die
 * Zufallsvariante in beliebigem Umfang ist abnahme-zufall.test.ts.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { simulieren } from '../abnahme/modell.ts'
import { type AbnahmeLauf, abnahmeLauf } from '../abnahme/live.ts'
import { szenarioErzeugen } from '../abnahme/szenario.ts'

const DATENBANK = 'erp_abnahme_check'
let h: Harness
let lauf: AbnahmeLauf

before(async () => {
  h = await harnessStart(DATENBANK)
  const [{ heute }] = await h.sql<{ heute: string }[]>`select current_date::text as heute`
  const szenario = szenarioErzeugen(heute)
  lauf = abnahmeLauf(h.sql, szenario, simulieren(szenario))
  await lauf.stammdatenAnlegen()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe('Abnahmetest: drei Monate live gegen das Modell', () => {
  test('Monat 1 — Einrichtung, Einkauf in EUR und USD, erste Shop-Bestellungen', async () => {
    await lauf.monatLaufen(1)
  })
  test('Monat 2 — Rückstand, Nebenkosten, Fertigung, Storno im Shop, B2B-Auftrag', async () => {
    await lauf.monatLaufen(2)
  })
  test('Monat 3 — Demontage, Fertigung auf Lager, Inventur, Kündigung, Abschluss', async () => {
    await lauf.monatLaufen(3)
  })
})
