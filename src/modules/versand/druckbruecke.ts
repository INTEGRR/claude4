import { timingSafeEqual } from 'node:crypto'
import { sql } from '@/db/client'

/**
 * Druckbrücke: die App erreicht den Labeldrucker am Packtisch nie direkt
 * (Vercel ↛ LAN) — deshalb eine Warteschlange (druckauftraege, 0077) und
 * ein kleiner Agent auf dem Packtisch-PC (scripts/druck-agent.ts), der
 * offene Aufträge per HTTPS abholt, still druckt und quittiert.
 * Authentifiziert wird der Agent über das DRUCK_AGENT_TOKEN aus der Env —
 * kein Benutzer-Login auf dem Gerät.
 */

/** Ist die Druckbrücke konfiguriert? Ohne Token gilt der Tab-Fallback. */
export function druckbrueckeKonfiguriert(): boolean {
  return Boolean(process.env.DRUCK_AGENT_TOKEN)
}

/** Bearer-Token des Agenten prüfen (längenkonstant, kein Timing-Orakel). */
export function agentBerechtigt(request: Request): boolean {
  const token = process.env.DRUCK_AGENT_TOKEN
  if (!token) return false
  const kopf = request.headers.get('authorization') ?? ''
  const geliefert = kopf.replace(/^Bearer\s+/i, '')
  const a = Buffer.from(geliefert)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Label-Druckauftrag einreihen — idempotent: solange für die Sendung schon
 * ein OFFENER Auftrag wartet, entsteht kein zweiter (Doppelscan am Tisch
 * soll nicht zwei Ausdrucke erzeugen; ein quittierter Auftrag darf dagegen
 * bewusst neu eingereiht werden, etwa nach Papierstau).
 */
export async function labelDruckEinreihen(shipmentId: string): Promise<void> {
  await sql`
    insert into druckauftraege (art, shipment_id)
    select 'label', ${shipmentId}
    where not exists (
      select 1 from druckauftraege
      where shipment_id = ${shipmentId} and status = 'offen')`
}
