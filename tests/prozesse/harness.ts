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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { spur } from './spur.ts'

export interface Harness {
  sql: Sql
  staging: boolean
}

/**
 * Die ECHTE Basis-Adresse, festgehalten beim Laden des Moduls.
 *
 * harnessStart biegt danach process.env.DATABASE_URL auf die Testdatenbank um
 * (damit der App-Client dorthin zeigt). Wer die Basis später erneut aus der
 * Umgebung liest, bekommt deshalb die Wegwerf-Datenbank zurück — und genau
 * das ist beim Aufräumen passiert: Die Verwaltungsverbindung öffnete
 * ausgerechnet die Datenbank, die sie gleich verwerfen wollte
 * („cannot drop the currently open database"). Der Fehler war durch ein
 * .catch() stumm gestellt, die Wegwerf-Datenbanken blieben liegen.
 */
const BASIS_URL = process.env.DATABASE_URL

function basisUrl(datenbank?: string): string {
  if (!BASIS_URL) throw new Error('DATABASE_URL ist nicht gesetzt')
  if (!datenbank) return BASIS_URL
  const u = new URL(BASIS_URL)
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
    try {
      // Bewusst ASYNCHRON (früher spawnSync): spawnSync blockiert die
      // Ereignisschleife des Testprozesses vollständig. node:test spricht
      // aber über eine Pipe mit dem Elternprozess — ein blockierter Kind-
      // prozess kann dort haken, ohne dass irgendetwas ausgegeben wird.
      // Ein Testharness darf die Schleife nicht anhalten.
      await promisify(execFile)(
        process.execPath,
        ['--experimental-strip-types', 'scripts/migrate.ts'],
        {
          // loadEnvFile() überschreibt gesetzte Variablen nicht — die
          // Umleitung auf die Testdatenbank gewinnt gegen die .env.
          env: { ...process.env, DATABASE_URL: ziel, DIRECT_URL: '' },
          timeout: 120_000,
        },
      )
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      throw new Error(`Migration der Testdatenbank fehlgeschlagen:\n${e.stderr ?? e.message}`)
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
    const admin = postgres(basisUrl(), { max: 1, connect_timeout: 30 })
    try {
      await admin.unsafe(`drop database if exists ${datenbank} with (force)`)
    } catch (err) {
      // Aufräumen darf einen grünen Lauf nicht rot machen — aber stumm
      // scheitern darf es auch nicht mehr.
      spur(`${datenbank}: konnte nicht verworfen werden — ${(err as Error).message}`)
    }
    await admin.end()
  }
  spur(`${datenbank}: fertig`)
}
