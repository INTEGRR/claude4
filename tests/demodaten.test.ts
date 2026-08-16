/**
 * Der Neustart-Knopf (demodaten_loeschen) räumt ALLE Tabellen ab — in der
 * geteilten Test-Datenbank würde das parallel laufende Tests unter sich
 * begraben. Deshalb bekommt diese Datei eine eigene Wegwerf-Datenbank:
 * Migrationen rein, kleine Fixture, Funktion ausführen, prüfen, Datenbank weg.
 *
 * Nebeneffekt: hier läuft auch der echte Seed so, wie ihn jeder Vercel-Build
 * und jeder Container-Start aufruft (ohne --demo) — und muss dabei die Finger
 * von den gerade gelöschten Beispieldaten lassen.
 */
import '../scripts/env.ts'
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import type { Sql } from 'postgres'

const TESTDB = 'erp_demodaten_test'

function url(datenbank?: string): string {
  const basis = process.env.DATABASE_URL
  if (!basis) throw new Error('DATABASE_URL ist nicht gesetzt')
  if (!datenbank) return basis
  const u = new URL(basis)
  u.pathname = `/${datenbank}`
  return u.toString()
}

/** Wartungsskript gegen die Wegwerf-Datenbank ausführen. */
function skript(name: string, ...argumente: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', name, ...argumente],
    {
      encoding: 'utf8',
      // loadEnvFile() überschreibt gesetzte Variablen nicht — die Umleitung
      // auf die Testdatenbank gewinnt also gegen die .env.
      env: { ...process.env, DATABASE_URL: url(TESTDB), DIRECT_URL: '' },
    },
  )
}

let sql: Sql

describe('Neustart: demodaten_loeschen', () => {
  before(async () => {
    const admin = postgres(url(), { max: 1 })
    await admin.unsafe(`drop database if exists ${TESTDB} with (force)`)
    await admin.unsafe(`create database ${TESTDB}`)
    await admin.end()

    const migration = skript('scripts/migrate.ts')
    assert.equal(migration.status, 0, `Migration fehlgeschlagen:\n${migration.stderr}`)

    sql = postgres(url(TESTDB), { max: 1 })

    // Kleine, aber echte Fixture: Benutzer, Partner, Produkt mit Bestand
    // (über die Buchungsfunktionen, damit Moves/Quants/Bewertung entstehen)
    // und ein Auftrag mit gezogener Belegnummer.
    await sql`
      insert into users (email, name, password_hash, role) values
        ('admin@example.com', 'Administrator', 'x:y', 'admin'),
        ('lager@example.com', 'Lena Lager', 'x:y', 'lager')`
    const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (name, uom_id) values ('Testprodukt', ${stueck.id}) returning id`
    await sql`select generate_variants(${tpl.id})`
    const [variante] = await sql<{ id: string }[]>`
      select id from product_variants where template_id = ${tpl.id}`
    const [ort] = await sql<{ id: string }[]>`
      select id from stock_locations where full_path = 'WH/Stock'`
    const [zaehlung] = await sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${ort.id}, ${variante.id}, 5, 0) returning id`
    await sql`select inventory_apply(${zaehlung.id}, 'test')`
    const [partner] = await sql<{ id: string }[]>`
      insert into partners (name, is_customer) values ('Kunde', true) returning id`
    await sql`
      insert into sales_orders (number, partner_id) values (next_sequence('sale'), ${partner.id})`
    // Ein Ticket ist Bewegung — es muss beim Neustart verschwinden, während
    // die Prozessdefinitionen (Struktur) stehen bleiben.
    await sql`
      insert into bug_reports (number, titel, gemeldet_von)
      values (next_sequence('bug'), 'Testfehler', 'admin@example.com')`
  })

  after(async () => {
    await sql?.end()
    const admin = postgres(url(), { max: 1 })
    await admin.unsafe(`drop database if exists ${TESTDB} with (force)`)
    await admin.end()
  })

  test('löscht Bewegungs- und Stammdaten, behält Struktur und Konten', async () => {
    await sql`select demodaten_loeschen()`

    for (const tabelle of ['product_templates', 'partners', 'sales_orders',
                           'stock_moves', 'stock_quants', 'stock_valuation_layers',
                           'bug_reports', 'prozess_instanzen']) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from ${sql(tabelle)}`
      assert.equal(n, 0, `${tabelle} sollte leer sein`)
    }

    const benutzer = await sql<{ email: string }[]>`select email from users order by email`
    assert.deepEqual(benutzer.map((b) => b.email), ['admin@example.com'])

    const [{ orte }] = await sql<{ orte: number }[]>`
      select count(*)::int as orte from stock_locations`
    assert.ok(orte > 0, 'Lagerorte müssen erhalten bleiben')
    const [firma] = await sql<{ value: { name?: string } }[]>`
      select value from settings where key = 'company'`
    assert.ok(firma.value.name, 'Firmendaten müssen erhalten bleiben')
  })

  test('Prozessdefinitionen überleben den Neustart', async () => {
    // Prozesse sind Struktur wie Lagerorte oder Konten — ein Neustart der
    // Daten darf die Ablauf-Definitionen nicht mitreißen.
    const [{ modelle }] = await sql<{ modelle: number }[]>`
      select count(*)::int as modelle from prozess_modelle`
    assert.ok(modelle > 0, 'Modell-Whitelist muss erhalten bleiben')
    const prozesse = await sql<{ code: string }[]>`
      select code from prozesse order by code`
    assert.deepEqual(prozesse.map((p) => p.code),
      ['artikel_anlegen', 'bug_ticket', 'reparatur', 'shopify_bestellung_versand'])
    const [{ schritte }] = await sql<{ schritte: number }[]>`
      select count(*)::int as schritte
      from prozess_schritte s
      join prozess_versionen v on v.id = s.version_id
      where v.status = 'aktiv'`
    assert.ok(schritte > 0, 'Schritte der aktiven Versionen müssen erhalten bleiben')
  })

  test('Belegnummern starten wieder bei 1', async () => {
    const [{ nummer }] = await sql<{ nummer: string }[]>`
      select next_sequence('sale') as nummer`
    assert.match(nummer, /0*1$/)
  })

  test('der Build-Seed (ohne --demo) legt keinerlei Beispieldaten an', async () => {
    const [merker] = await sql<{ value: { geloescht?: boolean } }[]>`
      select value from settings where key = 'demo'`
    assert.equal(merker.value.geloescht, true)

    // Exakt der Aufruf aus scripts/vorbereiten.ts (Vercel) und dem
    // Docker-Entrypoint ohne SEED_DEMO: nur der Administrator, sonst nichts.
    const seed = skript('scripts/seed.ts')
    assert.equal(seed.status, 0, `Seed fehlgeschlagen:\n${seed.stderr}`)

    const [{ produkte }] = await sql<{ produkte: number }[]>`
      select count(*)::int as produkte from product_templates`
    assert.equal(produkte, 0, 'Seed darf keine Beispieldaten anlegen')
    const demoKonten = await sql<{ email: string }[]>`
      select email from users where email like '%@example.com' and email <> 'admin@example.com'`
    assert.equal(demoKonten.length, 0, 'Seed darf die Demo-Konten nicht neu anlegen')
  })

  test('die Automatik ist wirklich tot: kein Startpfad reicht --demo weiter', async () => {
    // Absichtlich als Text geprüft: wer --demo je wieder in den Build oder
    // den Container-Standard schreibt, soll hier auflaufen.
    const { readFile } = await import('node:fs/promises')
    const vorbereiten = await readFile('scripts/vorbereiten.ts', 'utf8')
    assert.ok(!vorbereiten.includes("'--demo'"), 'vercel-build darf --demo nicht setzen')
    const compose = await readFile('docker-compose.yml', 'utf8')
    assert.match(compose, /SEED_DEMO: \$\{SEED_DEMO:-false\}/,
      'Docker-Beispieldaten müssen ein Opt-in bleiben')
  })
})
