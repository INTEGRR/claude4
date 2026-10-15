/**
 * Abnahmetest, Teil 3 — Zufallsszenario in zehnfachem Umfang live gegen
 * das Modell (Entscheidungslog 2026-10-15, „Abnahmetest ×10").
 *
 * Umfang und Seed sind einstellbar, ein roter Lauf nennt beide:
 *
 *     ABNAHME_FAKTOR=10 ABNAHME_SEED=20261015 npm run test:prozesse
 *
 * Der Generator (tests/abnahme/zufall.ts) erzeugt nur, was das Modell als
 * machbar bestätigt; der Live-Lauf prüft das Modell an jedem Monatsende.
 */
import './spur.ts'
import test, { after, before, describe } from 'node:test'
import { type Harness, harnessEnde, harnessStart } from './harness.ts'
import { spur } from './spur.ts'
import { simulieren } from '../abnahme/modell.ts'
import { type AbnahmeLauf, abnahmeLauf } from '../abnahme/live.ts'
import { szenarioStatistik, szenarioZufaellig } from '../abnahme/zufall.ts'

const DATENBANK = 'erp_abnahme_zufall_check'
const FAKTOR = Number(process.env.ABNAHME_FAKTOR ?? 10)
const SEED = Number(process.env.ABNAHME_SEED ?? 20261015)
let h: Harness
let lauf: AbnahmeLauf

before(async () => {
  h = await harnessStart(DATENBANK)
  const [{ heute }] = await h.sql<{ heute: string }[]>`select current_date::text as heute`
  const szenario = szenarioZufaellig({ heute, seed: SEED, faktor: FAKTOR })
  spur(`Zufallsszenario Seed ${SEED}, Faktor ${FAKTOR}: ${szenario.schritte.length} Schritte ${JSON.stringify(szenarioStatistik(szenario))}`)
  lauf = abnahmeLauf(h.sql, szenario, simulieren(szenario))
  await lauf.stammdatenAnlegen()
})

after(async () => {
  await harnessEnde(h, DATENBANK)
})

describe(`Abnahmetest ×${FAKTOR} (Seed ${SEED}): Zufallsszenario live gegen das Modell`, () => {
  test('Monat 1', async () => {
    await lauf.monatLaufen(1)
  })
  test('Monat 2', async () => {
    await lauf.monatLaufen(2)
  })
  test('Monat 3', async () => {
    await lauf.monatLaufen(3)
  })
})
