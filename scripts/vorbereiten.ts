/**
 * Vorbereitung vor dem Build auf Vercel: Schema einspielen, Grunddaten
 * anlegen. Beides ist wiederholbar — angewandte Migrationen stehen in
 * schema_migrations, und der Seed überspringt Beispieldaten, sobald Produkte
 * vorhanden sind.
 *
 * Ohne Datenbankadresse läuft der Build trotzdem durch. Das ist Absicht: die
 * allererste Bereitstellung passiert, bevor jemand die Umgebungsvariablen
 * gesetzt hat, und ein Build, der daran scheitert, hilft niemandem.
 */
import './env.ts'
import { spawnSync } from 'node:child_process'

const url = process.env.DIRECT_URL || process.env.DATABASE_URL
if (!url) {
  console.log(
    'Keine DATABASE_URL gesetzt — Migration und Grunddaten werden übersprungen.\n' +
      'Die Anwendung braucht sie zur Laufzeit; in den Projekteinstellungen nachtragen.',
  )
  process.exit(0)
}

for (const skript of ['scripts/migrate.ts', 'scripts/seed.ts']) {
  const argumente = skript.endsWith('seed.ts') ? ['--demo'] : []
  console.log(`\n→ ${skript} ${argumente.join(' ')}`)
  const lauf = spawnSync(
    process.execPath,
    ['--experimental-strip-types', skript, ...argumente],
    { stdio: 'inherit' },
  )
  if (lauf.status !== 0) {
    console.error(`${skript} ist fehlgeschlagen.`)
    process.exit(lauf.status ?? 1)
  }
}
