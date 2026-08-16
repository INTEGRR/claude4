/**
 * Prozess-Testdatensatz für Staging (und lokal): baut den Grundbestand aller
 * Fixtures auf — dieselben Daten, mit denen der Prozesstest-Harness die
 * Prozesse durchspielt. Ziel über DATABASE_URL/DIRECT_URL (wie migrate/seed).
 *
 *   node --experimental-strip-types scripts/prozessdaten.ts [--reset] [--nur <fixture>]
 *
 * --reset räumt vorher mit demodaten_loeschen() ab — und verweigert das,
 * wenn die Zieldatenbank sich nicht ausdrücklich als Staging ausweist:
 *
 *   insert into settings (key, value) values ('umgebung', '{"name":"staging"}')
 *   on conflict (key) do update set value = excluded.value;
 *
 * Dieser Riegel ist Absicht. Ohne ihn würde ein vertipptes DATABASE_URL
 * irgendwann die Produktion leeren.
 */
import './env.ts'
import { wartungsUrl } from './db-url.ts'
import postgres from 'postgres'
import {
  FIXTURES,
  fixtureReihenfolge,
} from '../src/modules/prozesse/fixtures/index.ts'
import type { FixtureKontext, ProzessFixture } from '../src/modules/prozesse/fixtures/typen.ts'

async function main() {
  const argumente = process.argv.slice(2)
  const reset = argumente.includes('--reset')
  const nurIndex = argumente.indexOf('--nur')
  const nur = nurIndex >= 0 ? argumente[nurIndex + 1] : undefined
  if (nurIndex >= 0 && !nur) {
    console.error('--nur braucht einen Fixture-Namen, z. B. --nur reparatur')
    process.exit(1)
  }

  const sql = postgres(wartungsUrl(), {
    max: 1,
    prepare: false,
    types: {
      numeric: {
        to: 0,
        from: [1700],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  })

  try {
    if (reset) {
      const [umgebung] = await sql<{ name: string | null }[]>`
        select value ->> 'name' as name from settings where key = 'umgebung'`
      if (umgebung?.name !== 'staging') {
        console.error(
          '--reset verweigert: die Zieldatenbank weist sich nicht als Staging aus.\n' +
            `Gefunden: settings.umgebung = ${JSON.stringify(umgebung?.name ?? null)}.\n` +
            'Nur eine Datenbank mit settings.umgebung = {"name":"staging"} darf ' +
            'zurückgesetzt werden — Produktion trägt diesen Merker nie.',
        )
        process.exit(1)
      }
      console.log('Setze Staging zurück (demodaten_loeschen) …')
      await sql`select demodaten_loeschen()`
    }

    const namen = fixtureReihenfolge(nur ? [nur] : Object.keys(FIXTURES))
    const ctx: FixtureKontext = {}
    for (const name of namen) {
      const fixture = (FIXTURES as Record<string, ProzessFixture>)[name]
      if (!fixture.aufbauen) {
        console.log(`- ${name}: kein Aufbau nötig`)
        continue
      }
      await fixture.aufbauen(sql, ctx)
      console.log(`- ${name}: aufgebaut`)
    }

    console.log(
      `Fertig. ${namen.length} Fixture(s) aufgebaut — Kontext: ${
        Object.keys(ctx).join(', ') || 'leer'
      }`,
    )
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
