/**
 * Audit-Stand für den Produktivgang (Entscheidungslog 2026-10-18): führt
 * `npm audit` aus und schreibt das Ergebnis als JSON neben die Prüfpunkte,
 * damit die Seite /einstellungen/produktivgang zeigt, ob die ausgelieferte
 * Fassung bekannte Lücken in Abhängigkeiten hat. Läuft im Vercel-Build
 * (vercel-build) und in der CI vor dem Build.
 *
 * Scheitert nie: ohne Netz oder bei kaputter Ausgabe bleibt der alte Stand
 * stehen und der Fehler wird festgehalten — ein Deployment darf nicht am
 * Audit hängen, das Rotwerden übernimmt der CI-Schritt `npm audit
 * --audit-level=high`. Lokal nur auf Wunsch (`npm run audit:stand`); die
 * geänderte JSON gehört dann NICHT in den Commit.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ZIEL = new URL('../src/modules/einstellungen/audit-stand.json', import.meta.url)

interface Stand {
  geprueftAm: string | null
  kritisch: number
  hoch: number
  mittel: number
  niedrig: number
  pakete: string[]
  fehler: string | null
}

function alterStand(): Stand {
  try {
    return JSON.parse(readFileSync(ZIEL, 'utf8')) as Stand
  } catch {
    return { geprueftAm: null, kritisch: 0, hoch: 0, mittel: 0, niedrig: 0, pakete: [], fehler: null }
  }
}

const lauf = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], {
  encoding: 'utf8',
  timeout: 180_000,
  maxBuffer: 64 * 1024 * 1024,
})

let stand: Stand
try {
  // npm audit endet mit Status 1, sobald es Befunde gibt — die Ausgabe ist trotzdem gültig.
  const bericht = JSON.parse(lauf.stdout || '{}') as {
    error?: { summary?: string; code?: string }
    metadata?: { vulnerabilities?: Record<string, number> }
    vulnerabilities?: Record<string, { severity: string }>
  }
  if (bericht.error) throw new Error(bericht.error.summary ?? bericht.error.code ?? 'npm audit fehlgeschlagen')
  const z = bericht.metadata?.vulnerabilities ?? {}
  const pakete = Object.entries(bericht.vulnerabilities ?? {})
    .filter(([, v]) => v.severity === 'high' || v.severity === 'critical')
    .map(([name]) => name)
    .sort()
  stand = {
    geprueftAm: new Date().toISOString(),
    kritisch: z.critical ?? 0,
    hoch: z.high ?? 0,
    mittel: z.moderate ?? 0,
    niedrig: (z.low ?? 0) + (z.info ?? 0),
    pakete,
    fehler: null,
  }
} catch (e) {
  const alt = alterStand()
  stand = { ...alt, fehler: `${(e as Error).message}${lauf.stderr ? ` — ${lauf.stderr.trim().split('\n')[0]}` : ''}`.slice(0, 300) }
}

writeFileSync(ZIEL, `${JSON.stringify(stand, null, 2)}\n`)
console.log(
  stand.fehler
    ? `Audit-Stand: Prüfung fehlgeschlagen (${stand.fehler}), alter Stand bleibt`
    : `Audit-Stand: ${stand.kritisch} kritisch, ${stand.hoch} hoch, ${stand.mittel} mittel, ${stand.niedrig} niedrig${stand.pakete.length ? ` — ${stand.pakete.join(', ')}` : ''}`,
)
