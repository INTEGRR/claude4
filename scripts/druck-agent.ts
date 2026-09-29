/**
 * Druckbrücken-Agent — läuft am Arbeitsplatz-PC, NICHT auf dem Server.
 *
 * Holt offene Druckaufträge der KRNL-Instanz ab (Pull über HTTPS, die App
 * erreicht den LAN-Drucker nie), druckt die PDFs still über ein
 * konfigurierbares Kommando und quittiert. Braucht nur Node ≥ 22 — keine
 * npm-Installation, keine Abhängigkeiten, kein Zugriff auf den App-Code.
 *
 * Einrichtung: das fertige Paket je Drucker unter Einstellungen →
 * Arbeitsplätze laden — es trägt alle Werte schon ein. Von Hand
 * (Windows, PowerShell):
 *   $env:KRNL_URL = "https://claude4-one.vercel.app"
 *   $env:DRUCK_AGENT_TOKEN = "<Token aus Einstellungen → Versand & Druck>"
 *   $env:DRUCK_DRUCKER_ID = "<ID des Druckers aus Einstellungen → Arbeitsplätze>"
 *   $env:DRUCKER = "Brother QL-1100"   # Name wie unter Windows
 *   node --experimental-strip-types druck-agent.ts
 *
 * EIN Agent bedient EINEN Drucker (DRUCK_DRUCKER_ID) und bekommt nur dessen
 * Aufträge; zwei Drucker am selben PC = zwei Agenten. Label-Drucker
 * drucken „auf Etikett eingepasst", A4 nur verkleinert, wenn nötig.
 *
 * Druckkommando (Standard):
 *   Windows: SumatraPDF -print-to "<DRUCKER>" -print-settings fit|shrink -silent <datei>
 *     (ohne DRUCKER: -print-to-default)
 *   Linux/macOS: lp -d "<DRUCKER>" [-o fit-to-page] <datei>
 *   Eigenes Kommando über DRUCK_KOMMANDO mit den Platzhaltern {datei},
 *   {drucker} und {skalierung} (fit bei Etiketten, sonst shrink), z. B.:
 *     DRUCK_KOMMANDO='SumatraPDF.exe -print-to "{drucker}" -print-settings {skalierung} {datei}'
 *
 * Alt-Betrieb (vor den Arbeitsplätzen): ohne DRUCK_DRUCKER_ID zieht der
 * Agent die Aufträge ohne Drucker, gefiltert über DRUCK_ZIELE
 * („labeldrucker", „zetteldrucker"; leer = alle); DRUCK_AGENT_NAME
 * benennt ihn auf der Integrationen-Seite.
 *
 * Doku: docs/module/versand.md → „Druckbrücke".
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const KRNL_URL = process.env.KRNL_URL?.replace(/\/$/, '')
const TOKEN = process.env.DRUCK_AGENT_TOKEN
const DRUCKER = process.env.DRUCKER ?? ''
const DRUCKER_ID = (process.env.DRUCK_DRUCKER_ID ?? '').trim()
const ZIELE = (process.env.DRUCK_ZIELE ?? '').trim()
const NAME = (process.env.DRUCK_AGENT_NAME ?? '').trim()
const INTERVALL_MS = Number(process.env.DRUCK_INTERVALL_MS ?? 3000)

if (!KRNL_URL || !TOKEN) {
  console.error('KRNL_URL und DRUCK_AGENT_TOKEN müssen gesetzt sein.')
  process.exit(1)
}

const EIGENES_KOMMANDO = process.env.DRUCK_KOMMANDO?.trim() || null

/** Kommandozeile in argv zerlegen — respektiert "…"-Gruppen. */
function zerlege(kommando: string): string[] {
  return (kommando.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''))
}

/** Das Druckkommando als argv — Etiketten eingepasst, A4 nur verkleinert. */
function kommandoFuer(datei: string, typ: string | null): string[] {
  const etikett = typ === 'label'
  if (EIGENES_KOMMANDO) {
    return zerlege(EIGENES_KOMMANDO).map((t) =>
      t
        .replaceAll('{datei}', datei)
        .replaceAll('{drucker}', DRUCKER)
        .replaceAll('{skalierung}', etikett ? 'fit' : 'shrink'),
    )
  }
  if (process.platform === 'win32') {
    return [
      'SumatraPDF',
      ...(DRUCKER ? ['-print-to', DRUCKER] : ['-print-to-default']),
      '-print-settings',
      etikett ? 'fit' : 'shrink',
      '-silent',
      datei,
    ]
  }
  return ['lp', ...(DRUCKER ? ['-d', DRUCKER] : []), ...(etikett ? ['-o', 'fit-to-page'] : []), datei]
}

async function drucke(datei: string, typ: string | null): Promise<void> {
  const [programm, ...argumente] = kommandoFuer(datei, typ)
  if (!programm) throw new Error('Leeres Druckkommando')
  await promisify(execFile)(programm, argumente, { timeout: 60_000 })
}

interface Auftrag {
  id: string
  art: string
  dateiname: string
  pdfBase64: string
  /** 'label' | 'a4' — null bei Alt-Aufträgen ohne Drucker. */
  druckerTyp?: string | null
}

async function runde(): Promise<number> {
  const params = new URLSearchParams()
  if (DRUCKER_ID) params.set('drucker', DRUCKER_ID)
  else {
    if (ZIELE) params.set('ziele', ZIELE)
    if (NAME) params.set('name', NAME)
  }
  const query = params.size > 0 ? `?${params}` : ''
  const res = await fetch(`${KRNL_URL}/api/druck/abholen${query}`, {
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
      await drucke(datei, job.druckerTyp ?? null)
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

console.log(
  `Druckbrücke aktiv — ${KRNL_URL}, ` +
    (DRUCKER_ID ? `Drucker-ID ${DRUCKER_ID}` : `Ziele: ${ZIELE || 'alle'}`) +
    `, Drucker: ${DRUCKER || 'Standarddrucker'}` +
    (EIGENES_KOMMANDO ? `, Kommando: ${EIGENES_KOMMANDO}` : ''),
)
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
