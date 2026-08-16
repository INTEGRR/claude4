/**
 * Schreibt das Ergebnis eines automatisierten Prozesstest-Laufs ans Ticket —
 * der letzte Schritt des Bug-Loops (Ticket → Fix → Prozesstest im Staging →
 * Beleg am Ticket). Aufgerufen von der GitHub-Action prozesse-staging.yml.
 *
 *   node --experimental-strip-types scripts/ticket-abschliessen.ts BUG/00042 <commit-sha>
 *     [--rot] [--befund "…"]
 *
 * Setzt NUR die Testfelder (test_ok, test_commit_sha, test_gelaufen_am,
 * test_befund). Den Status „behoben" setzt weiterhin ein Mensch oder Claude
 * auf Zuruf — der Test beweist, er entscheidet nicht.
 */
import './env.ts'
import { wartungsUrl } from './db-url.ts'
import postgres from 'postgres'

async function main() {
  const argumente = process.argv.slice(2)
  const rot = argumente.includes('--rot')
  const befundIndex = argumente.indexOf('--befund')
  const befund = befundIndex >= 0 ? argumente[befundIndex + 1] : undefined
  const positional = argumente.filter(
    (a, i) => !a.startsWith('--') && (befundIndex < 0 || i !== befundIndex + 1),
  )
  const [nummer, commit] = positional

  if (!nummer || !commit) {
    console.error(
      'Aufruf: ticket-abschliessen.ts <BUG/…> <commit-sha> [--rot] [--befund "…"]',
    )
    process.exit(1)
  }

  const sql = postgres(wartungsUrl(), { max: 1, prepare: false })
  try {
    const treffer = await sql<{ id: string; number: string; titel: string }[]>`
      update bug_reports set
        test_ok = ${!rot},
        test_commit_sha = ${commit},
        test_gelaufen_am = now(),
        test_befund = coalesce(${befund ?? null}, test_befund)
      where number = ${nummer}
      returning id, number, titel`

    if (treffer.length === 0) {
      console.error(`Ticket ${nummer} nicht gefunden.`)
      process.exit(1)
    }

    await sql`select log_event('bug_report', ${treffer[0].id}::uuid, 'state',
      ${`Prozesstest ${rot ? 'ROT' : 'GRÜN'} am Commit ${commit.slice(0, 12)}${befund ? ` — ${befund.slice(0, 200)}` : ''}`},
      'prozesstest')`

    console.log(
      `${treffer[0].number} („${treffer[0].titel}"): Prozesstest ${rot ? 'rot' : 'grün'} ` +
        `am Commit ${commit.slice(0, 12)} vermerkt.`,
    )
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
