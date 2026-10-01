import { sql } from '@/db/client'
import { registrierteAktion } from './index.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/**
 * Ausführung Einkauf Stufe 6 (0109): Vorschläge des Agenten annehmen,
 * verwerfen, ändern. Annehmen ruft die vorgeschlagene Aktion über den
 * Torwächter auf — als der Mensch, der klickt (Name, Rollen, Befugnisse
 * aus dem Kontext). Das Audit der inneren Aktion trägt damit ihn als
 * Akteur, nicht den Agenten.
 */

interface VorschlagZeile {
  id: string
  aktion: string
  parameter: Record<string, unknown>
  record_id: string | null
  titel: string
  status: string
}

async function vorschlagLesen(id: string): Promise<VorschlagZeile> {
  const [v] = await sql<VorschlagZeile[]>`
    select id, aktion, parameter, record_id, titel, status::text as status from ki_vorschlaege where id = ${id}`
  if (!v) throw new Error('Vorschlag nicht gefunden.')
  return v
}

/** Wohin das Ergebnis führt, wenn die innere Aktion keinen Link liefert. */
function ergebnisLink(aktion: string, recordId: string | null, ergebnis: AktionsErgebnis): string | null {
  if (ergebnis.link) return ergebnis.link
  const id = ergebnis.recordId ?? recordId
  if (!id) return null
  const modell = registrierteAktion(aktion)?.modell
  if (modell === 'einkaufsprojekt') return `/einkauf/projekte/${id}`
  if (modell === 'mail_thread') return `/einkauf/posteingang/${id}`
  return null
}

export async function vorschlagAnnehmen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  // Erst beanspruchen (offen/fehler → angenommen), dann ausführen: ein
  // Doppelklick führt nicht zweimal aus.
  const [v] = await sql<VorschlagZeile[]>`
    update ki_vorschlaege set status = 'angenommen', entschieden_von = ${ctx.actor}, entschieden_am = now(), fehler = null
    where id = ${ctx.recordId!} and status in ('offen', 'fehler')
    returning id, aktion, parameter, record_id, titel, status::text as status`
  if (!v) throw new Error('Dieser Vorschlag ist schon entschieden.')

  const { aktionAusfuehrenGeprueft, RechteFehler } = await import('../torwaechter.ts')
  let ergebnis: AktionsErgebnis
  try {
    ergebnis = await aktionAusfuehrenGeprueft(
      v.aktion,
      { parameter: v.parameter, recordId: v.record_id ?? undefined },
      { name: ctx.actor, role: ctx.role, rollen: ctx.rollen, id: ctx.userId, befugnisse: ctx.befugnisse },
    )
  } catch (err) {
    const meldung = err instanceof Error ? err.message : String(err)
    if (err instanceof RechteFehler) {
      // Fehlendes Recht dieses Menschen ist kein Fehler des Vorschlags — zurück auf offen.
      await sql`update ki_vorschlaege set status = 'offen', entschieden_von = null, entschieden_am = null where id = ${v.id}`
      throw err
    }
    await sql`update ki_vorschlaege set status = 'fehler', fehler = ${meldung.slice(0, 1000)} where id = ${v.id}`
    await sql`select log_event('ki_vorschlag', ${v.id}, 'error', ${`Annehmen gescheitert: ${meldung.slice(0, 300)}`}, ${ctx.actor})`
    throw new Error(`Der Vorschlag ließ sich nicht ausführen: ${meldung} — bitte ändern oder verwerfen.`)
  }

  const link = ergebnisLink(v.aktion, v.record_id, ergebnis)
  await sql`update ki_vorschlaege set ergebnis = ${ergebnis.text ?? 'Ausgeführt.'}, ergebnis_link = ${link} where id = ${v.id}`
  // Ein angenommenes Angebot stammt vom Agenten — die Spalte gibt es dafür seit 0097.
  const angebotId = ergebnis.daten?.angebot_id
  if (v.aktion === 'einkauf.angebot_erfassen' && typeof angebotId === 'string') {
    await sql`update lieferantenangebote set quelle = 'agent' where id = ${angebotId}`
  }
  await sql`select log_event('ki_vorschlag', ${v.id}, 'state', ${`Angenommen: ${v.titel}`}, ${ctx.actor})`
  return {
    text: `Angenommen — ${ergebnis.text ?? v.titel}`,
    ...(link ? { link } : {}),
    recordId: v.id,
  }
}

export async function vorschlagVerwerfen(p: { grund?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [v] = await sql<{ id: string; titel: string }[]>`
    update ki_vorschlaege set status = 'verworfen', entschieden_von = ${ctx.actor}, entschieden_am = now(),
                              ergebnis = ${p.grund ?? null}
    where id = ${ctx.recordId!} and status in ('offen', 'fehler')
    returning id, titel`
  if (!v) throw new Error('Nur offene Vorschläge lassen sich verwerfen.')
  await sql`select log_event('ki_vorschlag', ${v.id}, 'state', ${`Verworfen: ${v.titel}${p.grund ? ` (${p.grund})` : ''}`}, ${ctx.actor})`
  return { text: 'Vorschlag verworfen — nichts ausgeführt.', recordId: v.id }
}

export async function vorschlagAendern(
  p: { parameter: Record<string, unknown>; ungueltig: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const v = await vorschlagLesen(ctx.recordId!)
  if (v.status !== 'offen' && v.status !== 'fehler') throw new Error('Nur offene Vorschläge lassen sich ändern.')
  const aktion = registrierteAktion(v.aktion)
  if (!aktion) throw new Error(`Die vorgeschlagene Aktion „${v.aktion}" gibt es nicht mehr.`)
  const geprueft = aktion.schema.safeParse(p.parameter)
  if (!geprueft.success) {
    throw new Error(geprueft.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; '))
  }
  const werte = geprueft.data as Record<string, unknown>
  const titel = (aktion.zusammenfassung?.(werte as never) ?? v.titel).slice(0, 200)
  await sql`
    update ki_vorschlaege set parameter = ${sql.json(werte as never)}, titel = ${titel}, status = 'offen', fehler = null,
                              geaendert_von = ${ctx.actor}, geaendert_am = now()
    where id = ${v.id}`
  await sql`select log_event('ki_vorschlag', ${v.id}, 'info', ${`Geändert: ${titel}`}, ${ctx.actor})`
  return { text: 'Vorschlag geändert — mit „Annehmen" wird er ausgeführt.', recordId: v.id }
}
