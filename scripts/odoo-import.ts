/**
 * Datenübernahme aus Odoo 18 — das Wartungsskript (docs/migration-odoo.md).
 *
 *   ODOO_QUELLE_URL=postgres://erp:erp@127.0.0.1:5433/odoo_quelle \
 *   npm run odoo:import -- [--dry-run] [--nur-phase=<name>] [--bis-phase=<name>] [--lauf=<label>]
 *
 * Quelle ist die Staging-DB mit dem eingespielten Odoo.sh-Dump, Ziel die
 * KRNL-DB über wartungsUrl() (DIRECT_URL vor DATABASE_URL — für Supabase
 * zwingend der Session-Port). --dry-run fährt alles in einer Transaktion
 * und rollt am Ende zurück; ein echter Lauf committet je Phase (die
 * Phasen sind über odoo_verweise idempotent, Wiederholen ist gefahrlos).
 */
import './env.ts'
import postgres from 'postgres'
import type { Sql, TransactionSql } from 'postgres'
import { wartungsUrl } from './db-url.ts'
import { datenTuev } from '../src/modules/lager/daten-tuev.ts'
import {
  type Lauf,
  phaseAbschluss,
  phaseBelege,
  phaseBestand,
  phaseBewertung,
  phaseKosten,
  phaseProdukte,
  phaseRechnungen,
  phaseStammdaten,
  phaseVorbedingung,
} from '../src/modules/migration/odoo/import.ts'
import { zaehlAbgleich } from '../src/modules/migration/odoo/verifikation.ts'

const PHASEN: { name: string; fn: (lauf: Lauf) => Promise<void> }[] = [
  { name: 'vorbedingung', fn: phaseVorbedingung },
  { name: 'stammdaten', fn: phaseStammdaten },
  { name: 'produkte', fn: phaseProdukte },
  { name: 'belege', fn: phaseBelege },
  { name: 'rechnungen', fn: phaseRechnungen },
  // Kosten ZWINGEND vor dem Bestand: move_done bewertet den Zugang sofort
  // mit dem dann gültigen standard_cost.
  { name: 'kosten', fn: phaseKosten },
  { name: 'bestand', fn: phaseBestand },
  { name: 'bewertung', fn: phaseBewertung },
  { name: 'abschluss', fn: phaseAbschluss },
]

function argument(name: string): string | null {
  const treffer = process.argv.find((a) => a.startsWith(`--${name}=`))
  return treffer ? treffer.slice(name.length + 3) : null
}

// postgres.js-Optionen wie in src/db/client.ts — der Import soll mit
// derselben Treibersemantik fahren wie der Betrieb (numeric als Number,
// keine Prepared Statements wegen Supavisor).
function verbinden(url: string): Sql {
  return postgres(url, {
    max: 1,
    prepare: false,
    types: { numeric: { to: 1700, from: [1700], parse: Number, serialize: String } },
    transform: { undefined: null },
  })
}

async function main() {
  const quellUrl = process.env.ODOO_QUELLE_URL
  if (!quellUrl) {
    throw new Error(
      'ODOO_QUELLE_URL fehlt — die Staging-DB mit dem Odoo-Dump, z. B. ' +
        'postgres://erp:erp@127.0.0.1:5433/odoo_quelle (Anleitung: docs/migration-odoo.md).',
    )
  }
  const dryRun = process.argv.includes('--dry-run')
  const nurPhase = argument('nur-phase')
  const bisPhase = argument('bis-phase')
  const label = argument('lauf') ?? `lauf-${new Date().toISOString().slice(0, 10)}`

  const geplant = PHASEN.filter((p) => {
    if (nurPhase) return p.name === nurPhase || p.name === 'vorbedingung'
    return true
  }).filter((_, index, alle) => {
    if (!bisPhase) return true
    const grenze = alle.findIndex((p) => p.name === bisPhase)
    return grenze === -1 || index <= grenze
  })
  if (nurPhase && !PHASEN.some((p) => p.name === nurPhase)) {
    throw new Error(`Unbekannte Phase „${nurPhase}" — bekannt: ${PHASEN.map((p) => p.name).join(', ')}`)
  }

  const quelle = verbinden(quellUrl)
  const ziel = verbinden(wartungsUrl())
  const warnungen: string[] = []

  const phasenAusfuehren = async (zielClient: Sql | TransactionSql) => {
    const lauf: Lauf = {
      quelle,
      ziel: zielClient,
      label,
      warnungen,
      meldung: (text) => console.log(`  ${text}`),
    }
    for (const phase of geplant) {
      console.log(`\n== Phase: ${phase.name}`)
      await phase.fn(lauf)
    }
  }

  try {
    console.log(`Odoo-Übernahme — Lauf „${label}"${dryRun ? ' (DRY-RUN, wird zurückgerollt)' : ''}`)
    if (dryRun) {
      const ROLLBACK = Symbol('dry-run')
      try {
        await ziel.begin(async (t) => {
          await phasenAusfuehren(t)
          console.log('\n== Zählabgleich (Dry-Run, vor dem Rollback)')
          console.log(await zaehlAbgleich(quelle, t))
          throw ROLLBACK
        })
      } catch (fehler) {
        if (fehler !== ROLLBACK) throw fehler
        console.log('\nDry-Run beendet — alle Änderungen zurückgerollt.')
      }
    } else {
      // Je Phase eine eigene Transaktion: bricht Phase n ab, sind 1..n−1
      // committed und dank Idempotenz gefahrlos wiederholbar.
      for (const phase of geplant) {
        await ziel.begin(async (t) => {
          const lauf: Lauf = {
            quelle,
            ziel: t,
            label,
            warnungen,
            meldung: (text) => console.log(`  ${text}`),
          }
          console.log(`\n== Phase: ${phase.name}`)
          await phase.fn(lauf)
        })
      }
      console.log('\n== Zählabgleich')
      console.log(await zaehlAbgleich(quelle, ziel))

      // Harte Abnahme: die Ledger-Invarianten des Systems. Ein Befund heißt
      // Korruption — der Lauf gilt als gescheitert (Exit ≠ 0).
      console.log('\n== Daten-TÜV')
      const tuev = await datenTuev(ziel)
      for (const warnung of tuev.warnungen) console.log(`  ~ ${warnung}`)
      if (tuev.befunde.length > 0) {
        for (const befund of tuev.befunde) console.error(`  ✗ ${befund}`)
        throw new Error(`Daten-TÜV: ${tuev.befunde.length} Befund(e) — Import nicht abnehmbar.`)
      }
      console.log(`  ${tuev.pruefungen} Prüfungen, keine Befunde.`)
    }

    if (warnungen.length > 0) {
      console.log(`\n== Warnungen (${warnungen.length})`)
      for (const warnung of warnungen) console.log(`  ! ${warnung}`)
    }
  } finally {
    await quelle.end()
    await ziel.end()
  }
}

main().catch((fehler) => {
  console.error(fehler instanceof Error ? fehler.message : fehler)
  process.exit(1)
})
