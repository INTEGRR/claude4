import { sql } from '@/db/client'

/**
 * Offene Vorgänge je Prozess (Entscheidungslog 2026-10-01, „Heute und
 * Zähler"): ein Vorgang ist offen, solange sein Prozess vom aktuellen
 * Zustand aus noch eine AKTION anbietet — „neu" und „Rückfrage" einer
 * Reparaturanfrage ja, „angenommen" (läuft als Reparatur weiter) und
 * „abgelehnt" nicht. Abgeleitet aus dem Prozessgraphen statt aus einer
 * Zustandsliste im Code: ein neuer Prozess zählt ohne Codeänderung mit
 * (Chamäleon).
 */
export async function offeneVorgaenge(): Promise<Map<string, number>> {
  const zeilen = await sql<{ prozess_code: string; n: number }[]>`
    select v.prozess_code, count(*)::int as n
    from vorgaenge v
    where exists (
      select 1
      from prozesse p
      join prozess_versionen pv on pv.prozess_id = p.id and pv.status = 'aktiv'
      join prozess_schritte s on s.version_id = pv.id and s.zustand = v.state
      join prozess_uebergaenge u on u.version_id = pv.id and u.von_code = s.code
      join prozess_schritte n on n.version_id = pv.id and n.code = u.nach_code
      where p.code = v.prozess_code and n.art::text = 'aktion')
    group by v.prozess_code`
  return new Map(zeilen.map((z) => [z.prozess_code, Number(z.n)]))
}
