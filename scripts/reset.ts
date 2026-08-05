/**
 * Setzt das Schema komplett zurück (nur für Entwicklung/Tests!) und spielt
 * anschließend alle Migrationen neu ein.
 *
 *   node --experimental-strip-types scripts/reset.ts
 */
import './env.ts'
import { execFileSync } from 'node:child_process'
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  if (/supabase\.(co|com)/.test(url) && process.env.ALLOW_REMOTE_RESET !== 'yes') {
    throw new Error(
      'DATABASE_URL zeigt auf Supabase. Reset würde alle Daten löschen. ' +
        'Falls wirklich gewollt: ALLOW_REMOTE_RESET=yes setzen.',
    )
  }

  const sql = postgres(url, { max: 1 })
  try {
    await sql.unsafe('drop schema if exists public cascade; create schema public;')
    console.log('Schema zurückgesetzt.')
  } finally {
    await sql.end()
  }

  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.ts'], {
    stdio: 'inherit',
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
