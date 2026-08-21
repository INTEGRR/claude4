/**
 * Harness der Prozesstests.
 *
 * Zwei Betriebsarten:
 *
 *  - Lokal (Standard): eigene Wegwerf-Datenbank je Testdatei — Migrationen
 *    rein, Läufe mit ECHTEN Commits (die Outbox arbeitet mit `for update
 *    skip locked`, das funktioniert nicht unter withRollback), Datenbank weg.
 *  - Staging (`PROZESS_DB_URL` gesetzt): läuft gegen die benannte Datenbank.
 *    Migrationsstand und Reset verantwortet dort scripts/prozessdaten.ts —
 *    der Harness fügt nur Daten hinzu und löscht nichts.
 *
 * Wichtig: Der Harness biegt DATABASE_URL um, BEVOR der App-Client
 * ('@/db/client', vom Torwächter dynamisch importiert) seine erste Verbindung
 * aufbaut — dadurch laufen die Aktionen exakt über den Produktionspfad, nur
 * eben gegen die Testdatenbank. Diese Datei läuft deshalb nur über
 * `npm run test:prozesse` (Loader für '@/' und server-only, eigener Prozess
 * je Testdatei).
 */
import '../../scripts/env.ts'
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import postgres from 'postgres'
import type { Sql } from 'postgres'

export interface Harness {
  sql: Sql
  staging: boolean
}

/**
 * Fortschrittsspur auf stderr. Klingt nach Kleinkram, ist aber der
 * Unterschied zwischen „hängt" und „hängt HIER": der Aufbau (Datenbank
 * wegwerfen, anlegen, migrieren) passiert VOR dem ersten Test, also bevor
 * der Test-Reporter irgendetwas ausgibt. Bleibt er stecken, sieht man ohne
 * diese Zeilen nur einen stummen Prozess — genau das ist in der CI passiert.
 */
function spur(text: string): void {
  const zeile = `[harness] ${text}\n`
  process.stderr.write(zeile)
  // In der CI zusätzlich in eine Datei: node:test sammelt die Ausgabe der
  // Kindprozesse und gibt sie erst aus, wenn eine Testdatei FERTIG ist —
  // bei einem Hänger also nie. Die Datei überlebt auch einen Abbruch und
  // wird vom Workflow ausgegeben.
  if (process.env.CI) appendFileSync('prozess-harness.log', zeile)
}

function basisUrl(datenbank?: string): string {
  const basis = process.env.DATABASE_URL
  if (!basis) throw new Error('DATABASE_URL ist nicht gesetzt')
  if (!datenbank) return basis
  const u = new URL(basis)
  u.pathname = `/${datenbank}`
  return u.toString()
}

const NUMERIC_ALS_ZAHL = {
  numeric: {
    to: 0,
    from: [1700],
    serialize: (x: number | string) => String(x),
    parse: (x: string) => Number(x),
  },
}

export async function harnessStart(datenbank: string): Promise<Harness> {
  // Tests sprechen NIE echte Dienste an — die Fake-Adapter sind Pflicht
  // (deterministische Antworten für Shopify/DHL an den Fetch-Kapselungen).
  process.env.SHOPIFY_FAKE ??= '1'
  process.env.DHL_FAKE ??= '1'

  const stagingUrl = process.env.PROZESS_DB_URL
  let ziel: string

  if (stagingUrl) {
    ziel = stagingUrl
  } else {
    spur(`${datenbank}: verbinde zur Verwaltungsdatenbank`)
    // connect_timeout: eine hängende Verbindung soll auffallen, nicht warten.
    const admin = postgres(basisUrl(), { max: 1, connect_timeout: 30 })
    spur(`${datenbank}: alte Wegwerf-Datenbank entfernen`)
    await admin.unsafe(`drop database if exists ${datenbank} with (force)`)
    spur(`${datenbank}: anlegen`)
    await admin.unsafe(`create database ${datenbank}`)
    await admin.end()

    ziel = basisUrl(datenbank)
    spur(`${datenbank}: migrieren`)
    const migration = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/migrate.ts'],
      // loadEnvFile() überschreibt gesetzte Variablen nicht — die Umleitung
      // auf die Testdatenbank gewinnt gegen die .env.
      { encoding: 'utf8', env: { ...process.env, DATABASE_URL: ziel, DIRECT_URL: '' } },
    )
    if (migration.status !== 0) {
      throw new Error(`Migration der Testdatenbank fehlgeschlagen:\n${migration.stderr}`)
    }
    spur(`${datenbank}: bereit`)
  }

  // Ab jetzt zeigt auch der App-Client auf die Zieldatenbank.
  process.env.DATABASE_URL = ziel
  process.env.DIRECT_URL = ''

  const sql = postgres(ziel, {
    max: 4,
    prepare: false,
    connect_timeout: 30,
    types: NUMERIC_ALS_ZAHL,
  })
  return { sql, staging: Boolean(stagingUrl) }
}

export async function harnessEnde(h: Harness, datenbank: string): Promise<void> {
  spur(`${datenbank}: aufräumen`)
  await h.sql.end()

  // Auch den Pool des App-Clients schließen, sonst hält er den Prozess offen.
  const app = await import('@/db/client')
  await app.sql.end({ timeout: 5 }).catch(() => undefined)

  if (!h.staging) {
    const admin = postgres(basisUrl(), { max: 1 })
    await admin.unsafe(`drop database if exists ${datenbank} with (force)`).catch(() => undefined)
    await admin.end()
  }
  spur(`${datenbank}: fertig`)
}
