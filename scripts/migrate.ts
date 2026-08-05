/**
 * Migrations-Runner: spielt alle SQL-Dateien aus src/db/migrations in
 * alphabetischer Reihenfolge ein und merkt sich angewandte Dateien in
 * `schema_migrations`. Jede Datei läuft in einer eigenen Transaktion.
 *
 *   node --experimental-strip-types scripts/migrate.ts
 */
import './env.ts'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'src', 'db', 'migrations')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  const sql = postgres(url, { max: 1 })

  try {
    await sql`
      create table if not exists schema_migrations (
        filename   text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`

    const applied = new Map<string, string>(
      (await sql<{ filename: string; checksum: string }[]>`
        select filename, checksum from schema_migrations`).map((r) => [r.filename, r.checksum]),
    )

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    let count = 0

    for (const file of files) {
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16)
      const previous = applied.get(file)

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} wurde nach dem Einspielen geändert. ` +
              `Migrationen sind unveränderlich — bitte eine neue Datei anlegen.`,
          )
        }
        continue
      }

      await sql.begin(async (t) => {
        await t.unsafe(body)
        await t`insert into schema_migrations (filename, checksum) values (${file}, ${checksum})`
      })
      console.log(`  ✓ ${file}`)
      count++
    }

    console.log(count === 0 ? 'Datenbank ist aktuell.' : `${count} Migration(en) eingespielt.`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
