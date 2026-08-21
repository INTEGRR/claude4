import './env.ts'
import postgres from 'postgres'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { wartungsUrl } from './db-url.ts'

/**
 * Wo steht die AKTUELLE Fassung einer SQL-Funktion?
 *
 *   npm run funktion confirm_sales_order
 *   npm run funktion              # Index aller mehrfach definierten Funktionen
 *
 * Hintergrund: Migrationen sind unveränderlich, also ist jede Weiterentwicklung
 * einer Funktion ein vollständiges `create or replace` in einer NEUEN Datei —
 * die alte Fassung bleibt für immer im Repo stehen und sieht genauso gültig
 * aus. 30 Funktionen liegen in 2 bis 5 Fassungen vor; `grep confirm_sales_order`
 * liefert vier Treffer, drei davon tot. Ohne dieses Skript ist die einzige
 * verlässliche Quelle `psql \sf` gegen eine migrierte Datenbank.
 */

const MIGRATIONS = new URL('../src/db/migrations', import.meta.url).pathname

interface Fundstelle {
  datei: string
  zeile: number
}

/** Alle Definitionen je Funktionsname, in Migrationsreihenfolge. */
export function definitionen(): Map<string, Fundstelle[]> {
  const treffer = new Map<string, Fundstelle[]>()
  for (const datei of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const zeilen = readFileSync(join(MIGRATIONS, datei), 'utf8').split('\n')
    zeilen.forEach((text, i) => {
      const m = text.match(/create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*)/i)
      if (!m) return
      const name = m[1].toLowerCase()
      if (!treffer.has(name)) treffer.set(name, [])
      treffer.get(name)!.push({ datei, zeile: i + 1 })
    })
  }
  return treffer
}

async function zeigeDefinition(name: string): Promise<void> {
  const alle = definitionen().get(name.toLowerCase())
  if (!alle) {
    console.error(`Keine Migration definiert „${name}".`)
    process.exitCode = 1
    return
  }

  const aktuell = alle[alle.length - 1]
  console.log(`\n  ${name} — aktuelle Fassung: ${aktuell.datei}:${aktuell.zeile}`)
  if (alle.length > 1) {
    const alt = alle.slice(0, -1).map((f) => `${f.datei}:${f.zeile}`).join(', ')
    console.log(`  ÜBERHOLT (nicht ändern!): ${alt}`)
  }

  // Der Beweis kommt aus der Datenbank, nicht aus dem Dateisystem.
  const sql = postgres(wartungsUrl(), { max: 1 })
  try {
    const [zeile] = await sql<{ def: string }[]>`
      select pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = ${name.toLowerCase()} and n.nspname not in ('pg_catalog', 'information_schema')
      limit 1`
    console.log(zeile ? `\n${zeile.def}\n` : '\n  (in dieser Datenbank nicht vorhanden)\n')
  } catch (err) {
    console.log(`\n  (Datenbank nicht erreichbar: ${err instanceof Error ? err.message : err})\n`)
  } finally {
    await sql.end()
  }
}

function zeigeIndex(): void {
  const mehrfach = [...definitionen()].filter(([, f]) => f.length > 1)
  console.log(`\n  ${mehrfach.length} Funktionen liegen in mehreren Fassungen vor.`)
  console.log('  Die LETZTE gilt — alle davor sind tot und dürfen nicht geändert werden.\n')
  for (const [name, f] of mehrfach.sort((a, b) => b[1].length - a[1].length)) {
    const aktuell = f[f.length - 1]
    console.log(`  ${name.padEnd(34)} ${f.length}×  aktuell: ${aktuell.datei}:${aktuell.zeile}`)
  }
  console.log('\n  Einzelne Funktion samt DB-Definition: npm run funktion <name>\n')
}

const gesucht = process.argv[2]
if (gesucht) await zeigeDefinition(gesucht)
else zeigeIndex()
