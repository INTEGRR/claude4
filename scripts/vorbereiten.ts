/**
 * Vorbereitung vor dem Build auf Vercel: Schema einspielen, Administrator
 * anlegen. Beides ist wiederholbar — angewandte Migrationen stehen in
 * schema_migrations, ein vorhandener Administrator wird übersprungen.
 *
 * Beispieldaten spielt der Build grundsätzlich NICHT ein. Sie kommen nur auf
 * ausdrücklichen Befehl (`npm run db:seed -- --demo`) — ein Deployment, das
 * sich ungefragt Beispieldaten in die Produktionsdatenbank legt, ist genau
 * die Sorte Überraschung, die irgendwann teuer wird.
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
  console.log(`\n→ ${skript}`)
  const lauf = spawnSync(
    process.execPath,
    ['--experimental-strip-types', skript],
    { stdio: 'inherit' },
  )
  if (lauf.status !== 0) {
    console.error(`${skript} ist fehlgeschlagen.`)
    process.exit(lauf.status ?? 1)
  }
}
