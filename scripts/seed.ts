/**
 * Legt den Administrator an — und mit --demo die kompletten Beispieldaten
 * (Tastatur mit Farbvarianten, Stückliste, Historie, Finanzen).
 *
 *   node --experimental-strip-types scripts/seed.ts [--demo]
 *
 * Beispieldaten kommen ausschließlich über dieses Flag oder die bewusste
 * Admin-Aktion im Onboarding (einstellungen.demodaten_einspielen) — kein
 * Build und kein Container-Start darf sie automatisch setzen (Vercel:
 * scripts/vorbereiten.ts, Docker: SEED_DEMO ist bewusst nur ein Opt-in).
 * Die Demodaten selbst leben in src/modules/demo/daten.ts.
 */
import './env.ts'
import { wartungsUrl } from './db-url.ts'
import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { demodatenEinspielen, demodatenMoeglich } from '../src/modules/demo/daten.ts'

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com'
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'erp-admin'

async function main() {
  const url = wartungsUrl()
  const sql = postgres(url, { max: 1 })
  const demo = process.argv.includes('--demo')

  try {
    // --- Administrator ------------------------------------------------------
    const [existing] = await sql<{ id: string }[]>`
      select id from users where lower(email) = lower(${ADMIN_EMAIL})`
    if (existing) {
      console.log(`Benutzer ${ADMIN_EMAIL} existiert bereits.`)
    } else {
      await sql`
        insert into users (email, name, password_hash, role)
        values (${ADMIN_EMAIL}, 'Administrator', ${await hashPassword(ADMIN_PASSWORD)}, 'admin')`
      console.log(`Administrator angelegt: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`)
    }

    if (!demo) {
      console.log('Fertig. Für Beispieldaten: npm run db:seed -- --demo')
      return
    }

    if (!(await demodatenMoeglich(sql))) {
      console.log('Es existieren bereits Produkte — Beispieldaten werden übersprungen.')
      return
    }

    const zeilen = await demodatenEinspielen(sql)
    console.log(`Beispieldaten angelegt:\n  - ${zeilen.join('\n  - ')}`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
