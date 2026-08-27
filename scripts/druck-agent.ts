/**
 * Druckbrücken-Agent — läuft auf dem Packtisch-PC, NICHT auf dem Server.
 *
 * Holt offene Druckaufträge der KRNL-Instanz ab (Pull über HTTPS, die App
 * erreicht den LAN-Drucker nie), druckt die Label-PDFs still über ein
 * konfigurierbares Kommando und quittiert. Braucht nur Node ≥ 22 — keine
 * npm-Installation, keine Abhängigkeiten, kein Zugriff auf den App-Code.
 *
 * Start (Windows, PowerShell):
 *   $env:KRNL_URL = "https://claude4-one.vercel.app"
 *   $env:DRUCK_AGENT_TOKEN = "<Token aus der Vercel-Env>"
 *   node scripts/druck-agent.ts
 *
 * Druckkommando (Platzhalter {datei} = Pfad zum PDF, {drucker} = DRUCKER):
 *   Windows-Standard: SumatraPDF -print-to-default -silent {datei}
 *     (mit DRUCKER gesetzt: -print-to "{drucker}")
 *   Linux/macOS-Standard: lp {datei}  (mit DRUCKER: lp -d "{drucker}")
 *   Eigenes Kommando über DRUCK_KOMMANDO, z. B.:
 *     DRUCK_KOMMANDO='SumatraPDF.exe -print-to "Zebra GK420d" {datei}'
 *
 * Einrichtung Schritt für Schritt: docs/module/versand.md → „Druckbrücke".
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const KRNL_URL = process.env.KRNL_URL?.replace(/\/$/, '')
const TOKEN = process.env.DRUCK_AGENT_TOKEN
const DRUCKER = process.env.DRUCKER ?? ''
const INTERVALL_MS = Number(process.env.DRUCK_INTERVALL_MS ?? 3000)

if (!KRNL_URL || !TOKEN) {
  console.error('KRNL_URL und DRUCK_AGENT_TOKEN müssen gesetzt sein.')
  process.exit(1)
}

function standardKommando(): string {
  if (process.platform === 'win32') {
    return DRUCKER
      ? 'SumatraPDF -print-to "{drucker}" -silent {datei}'
      : 'SumatraPDF -print-to-default -silent {datei}'
  }
  return DRUCKER ? 'lp -d "{drucker}" {datei}' : 'lp {datei}'
}

const KOMMANDO = process.env.DRUCK_KOMMANDO ?? standardKommando()

/** Kommandozeile in argv zerlegen — respektiert "…"-Gruppen. */
function zerlege(kommando: string): string[] {
  return (kommando.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''))
}

async function drucke(datei: string): Promise<void> {
  const teile = zerlege(
    KOMMANDO.replaceAll('{datei}', datei).replaceAll('{drucker}', DRUCKER),
  )
  const [programm, ...argumente] = teile
  if (!programm) throw new Error('Leeres Druckkommando')
  await promisify(execFile)(programm, argumente, { timeout: 60_000 })
}

interface Auftrag {
  id: string
  art: string
  dateiname: string
  pdfBase64: string
}

async function runde(): Promise<number> {
  const res = await fetch(`${KRNL_URL}/api/druck/abholen`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  if (!res.ok) {
    throw new Error(`Abholen fehlgeschlagen (${res.status}): ${await res.text()}`)
  }
  const { jobs } = (await res.json()) as { jobs: Auftrag[] }

  for (const job of jobs) {
    const verzeichnis = await mkdtemp(path.join(tmpdir(), 'krnl-druck-'))
    const datei = path.join(verzeichnis, job.dateiname)
    let ok = true
    let fehler = ''
    try {
      await writeFile(datei, Buffer.from(job.pdfBase64, 'base64'))
      await drucke(datei)
      console.log(`[${new Date().toISOString()}] gedruckt: ${job.dateiname}`)
    } catch (err) {
      ok = false
      fehler = err instanceof Error ? err.message : String(err)
      console.error(`[${new Date().toISOString()}] FEHLER ${job.dateiname}: ${fehler}`)
    } finally {
      await rm(verzeichnis, { recursive: true, force: true }).catch(() => undefined)
    }
    await fetch(`${KRNL_URL}/api/druck/quittieren`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok, fehler: fehler || undefined }),
    })
  }
  return jobs.length
}

console.log(`Druckbrücke aktiv — ${KRNL_URL}, Kommando: ${KOMMANDO}`)
let stoerungGemeldet = false
for (;;) {
  try {
    // Solange Aufträge kamen, sofort weiterfragen (Fließband); erst bei
    // leerer Warteschlange in den Takt zurückfallen.
    const anzahl = await runde()
    stoerungGemeldet = false
    if (anzahl > 0) continue
  } catch (err) {
    // Netzstörungen nur einmal je Episode melden, nicht alle 3 Sekunden.
    if (!stoerungGemeldet) {
      console.error(`Störung: ${err instanceof Error ? err.message : String(err)} — versuche weiter`)
      stoerungGemeldet = true
    }
  }
  await new Promise((f) => setTimeout(f, INTERVALL_MS))
}
