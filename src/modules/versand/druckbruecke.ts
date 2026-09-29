import { timingSafeEqual } from 'node:crypto'
import { sql } from '@/db/client'

/**
 * Druckbrücke: die App erreicht den Labeldrucker am Packtisch nie direkt
 * (Vercel ↛ LAN) — deshalb eine Warteschlange (druckauftraege, 0077) und
 * ein kleiner Agent auf dem Packtisch-PC (scripts/druck-agent.ts), der
 * offene Aufträge per HTTPS abholt, still druckt und quittiert.
 * Authentifiziert wird der Agent über ein gemeinsames Token — kein
 * Benutzer-Login auf dem Gerät.
 *
 * Ob gedruckt oder als PDF geöffnet wird, ist eine BETREIBER-Einstellung
 * (Einstellungen → Druckbrücke, settings.druckbruecke), keine Env-Variable
 * — gleiche Entscheidung wie bei den KI-Modellen: Reihenfolge Einstellung
 * → Env-Notausgang (DRUCK_AGENT_TOKEN) → Standard „pdf". So lässt sich
 * erst mit PDFs im Browser testen und später ohne Deployment auf stillen
 * Druck umschalten.
 */

export interface DruckbrueckeKonfig {
  /** 'pdf' = Labels/Zettel öffnen im Browser; 'bruecke' = stiller Druck über Agenten. */
  modus: 'pdf' | 'bruecke'
  token: string | null
}

export async function druckbrueckeKonfig(): Promise<DruckbrueckeKonfig> {
  const [zeile] = await sql<{ modus: string | null; token: string | null }[]>`
    select value ->> 'modus' as modus, value ->> 'token' as token
    from settings where key = 'druckbruecke'`
  const token = zeile?.token || process.env.DRUCK_AGENT_TOKEN || null
  const modus =
    zeile?.modus === 'bruecke' || zeile?.modus === 'pdf'
      ? zeile.modus
      : process.env.DRUCK_AGENT_TOKEN
        ? 'bruecke'
        : 'pdf'
  return { modus, token }
}

/** Sollen Aufträge eingereiht werden? Sonst gilt der PDF-Weg im Browser. */
export async function druckbrueckeAktiv(): Promise<boolean> {
  const konfig = await druckbrueckeKonfig()
  return konfig.modus === 'bruecke' && Boolean(konfig.token)
}

/** Bearer-Token des Agenten prüfen (längenkonstant, kein Timing-Orakel). */
export async function agentBerechtigt(request: Request): Promise<boolean> {
  const { token } = await druckbrueckeKonfig()
  if (!token) return false
  const kopf = request.headers.get('authorization') ?? ''
  const geliefert = kopf.replace(/^Bearer\s+/i, '')
  const a = Buffer.from(geliefert)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Die Ziele eines Agenten aus seiner Anfrage (?ziele=labeldrucker,…).
 * Ohne Angabe bedient er ALLE Ziele — so bleiben Ein-PC-Aufbauten ohne
 * weitere Konfiguration lauffähig.
 */
export function zieleAusAnfrage(param: string | null): string[] | null {
  const ziele = (param ?? '')
    .split(',')
    .map((z) => z.trim().toLowerCase())
    .filter(Boolean)
  return ziele.length > 0 ? ziele : null
}
