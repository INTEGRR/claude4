import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Vorgangs-Aktionen. */

export async function anlegen(
  p: { prozess_code: string; titel?: string; partner_id?: string; zusatz: Record<string, unknown> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [prozess] = await sql<{ code: string }[]>`
    select code from prozesse
    where code = ${p.prozess_code} and aktiv and modell = 'vorgang'`
  if (!prozess) {
    throw new Error(`„${p.prozess_code}" ist kein aktiver Vorgangs-Prozess.`)
  }

  // Der Startzustand kommt aus der Prozessdefinition: der Zustand des
  // Anlage-Schritts der aktiven Version (Fallback 'neu').
  const [schritt] = await sql<{ zustand: string | null }[]>`
    select s.zustand from prozess_schritte s
    where s.version_id = prozess_aktive_version(${p.prozess_code})
      and s.aktion = 'vorgang.anlegen'
    limit 1`

  const [vorgang] = await sql<{ id: string; number: string }[]>`
    insert into vorgaenge (number, prozess_code, titel, state, partner_id, zusatz)
    values (next_sequence('vorgang'), ${p.prozess_code}, ${p.titel ?? null},
            ${schritt?.zustand ?? 'neu'}, ${p.partner_id ?? null},
            ${sql.json(p.zusatz as never)})
    returning id, number`

  await sql`select log_event('vorgang', ${vorgang.id}::uuid, 'state',
    ${`Vorgang gestartet (${p.prozess_code})`}, ${ctx.actor})`

  return {
    text: `Vorgang ${vorgang.number} gestartet.`,
    link: `/vorgaenge/${vorgang.id}`,
    recordId: vorgang.id,
  }
}

export async function statusSetzen(
  p: { state: string; vermerk?: string; zusatz?: Record<string, unknown> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`
    update vorgaenge set
      state = ${p.state},
      zusatz = zusatz || ${sql.json((p.zusatz ?? {}) as never)}
    where id = ${id}`
  await sql`select log_event('vorgang', ${id}::uuid, 'state',
    ${`Zustand: ${p.state}${p.vermerk ? ` — ${p.vermerk.slice(0, 300)}` : ''}`}, ${ctx.actor})`
  return { recordId: id }
}
