import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Ticket-Aktionen — Fachlogik unverändert aus tickets/actions.ts übernommen. */

export async function ticketMelden(
  p: { titel: string; beschreibung?: string; seite?: string; schwere: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string; number: string }[]>`
    insert into bug_reports (number, titel, beschreibung, seite, schwere, gemeldet_von)
    values (next_sequence('bug'), ${p.titel}, ${p.beschreibung ?? null}, ${p.seite ?? null},
            ${p.schwere}::bug_schwere, ${ctx.actor})
    returning id, number`
  return {
    text: `Ticket ${row.number} angelegt — danke!`,
    link: `/tickets/${row.id}`,
    recordId: row.id,
  }
}

export async function ticketStatus(
  p: { status: string; aufloesung?: string; commit_sha?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`
    update bug_reports set
      status = ${p.status}::bug_status,
      aufloesung = coalesce(${p.aufloesung ?? null}, aufloesung),
      commit_sha = coalesce(${p.commit_sha ?? null}, commit_sha),
      behoben_am = case when ${p.status} in ('behoben', 'verworfen') then now() else null end
    where id = ${id}`
  await sql`select log_event('bug_report', ${id}::uuid, 'state',
    ${`Status: ${p.status}${p.aufloesung ? ` — ${p.aufloesung.slice(0, 300)}` : ''}${p.commit_sha ? ` (Commit ${p.commit_sha.slice(0, 12)})` : ''}`},
    ${ctx.actor})`
  return { recordId: id }
}
