import { sql, tx } from '@/db/client'
import { ERGEBNIS_STATUS, type MusterErgebnis, naechsteRevision, rundeText } from '@/modules/einkauf/bemusterung'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 4 (0107): Bemusterung — Muster-Runden mit Prozess `bemusterung`. */

interface Runde {
  id: string
  projekt_id: string
  projekt_nummer: string
  partner_id: string
  lieferant: string
  angebot_id: string | null
  runde: number
  revision: string | null
  bezeichnung: string | null
  menge: string | null
  waehrung: string
  status: 'offen' | 'freigegeben' | 'abgelehnt' | 'nachbessern'
  erhalten_am: string | null
}

const STATUS_TEXT: Record<Runde['status'], string> = {
  offen: 'offen',
  freigegeben: 'freigegeben',
  abgelehnt: 'abgelehnt',
  nachbessern: 'zum Nachbessern zurück',
}

async function rundeLesen(id: string): Promise<Runde> {
  const [r] = await sql<Runde[]>`
    select b.id, b.projekt_id, ep.nummer as projekt_nummer, b.partner_id, pa.name as lieferant, b.angebot_id,
           b.runde, b.revision, b.bezeichnung, b.menge::text as menge, b.waehrung, b.status::text as status,
           b.erhalten_am::text as erhalten_am
    from bemusterungen b
    join einkaufsprojekte ep on ep.id = b.projekt_id
    join partners pa on pa.id = b.partner_id
    where b.id = ${id}`
  if (!r) throw new Error('Muster-Runde nicht gefunden.')
  return r
}

async function waehrungPruefen(code: string) {
  const [w] = await sql<{ code: string }[]>`select code from currencies where code = ${code}`
  if (!w) throw new Error(`Währung ${code} ist in KRNL nicht angelegt.`)
}

interface MusterFelder {
  bezeichnung?: string
  revision?: string
  menge?: number
  kosten?: number
  waehrung?: string
  bestellt_am?: string
  tracking?: string
  notiz?: string
}

export async function musterAnfordern(
  p: MusterFelder & { projekt_id: string; partner_id: string; angebot_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [projekt] = await sql<{ id: string; nummer: string; status: string }[]>`
    select id, nummer, status::text as status from einkaufsprojekte where id = ${p.projekt_id}`
  if (!projekt) throw new Error('Einkaufsprojekt nicht gefunden.')
  if (projekt.status === 'abgeschlossen' || projekt.status === 'abgebrochen') {
    throw new Error(`${projekt.nummer} ist ${projekt.status} — Muster gehören zu einem laufenden Projekt.`)
  }
  const [lieferant] = await sql<{ name: string; standard_waehrung: string | null }[]>`
    select name, standard_waehrung from partners where id = ${p.partner_id}`
  if (!lieferant) throw new Error('Lieferant nicht gefunden.')

  // Angebot: das genannte (muss passen) oder das jüngste des Lieferanten im Projekt.
  const [angebot] = p.angebot_id
    ? await sql<{ id: string; projekt_id: string; partner_id: string; waehrung: string; musterkosten: number }[]>`
        select id, projekt_id, partner_id, waehrung, musterkosten::float as musterkosten
        from lieferantenangebote where id = ${p.angebot_id}`
    : await sql<{ id: string; projekt_id: string; partner_id: string; waehrung: string; musterkosten: number }[]>`
        select id, projekt_id, partner_id, waehrung, musterkosten::float as musterkosten
        from lieferantenangebote
        where projekt_id = ${projekt.id} and partner_id = ${p.partner_id} and not verworfen
        order by version desc limit 1`
  if (p.angebot_id && (!angebot || angebot.projekt_id !== projekt.id || angebot.partner_id !== p.partner_id)) {
    throw new Error('Das Angebot gehört nicht zu diesem Projekt und Lieferanten.')
  }
  // Ohne eigene Angabe: Musterkosten aus dem Angebot (in dessen Währung).
  const ausAngebot = p.kosten === undefined && angebot && angebot.musterkosten > 0
  const kosten = p.kosten ?? (ausAngebot ? angebot.musterkosten : null)
  const waehrung = p.waehrung ?? (angebot?.waehrung || lieferant.standard_waehrung || 'EUR')
  await waehrungPruefen(waehrung)

  const neu = await tx(async (t) => {
    const [vorher] = await t<{ runde: number; revision: string | null }[]>`
      select runde, revision from bemusterungen
      where projekt_id = ${projekt.id} and partner_id = ${p.partner_id}
      order by runde desc limit 1 for update`
    const runde = (vorher?.runde ?? 0) + 1
    const revision = p.revision ?? (vorher ? naechsteRevision(vorher.revision) : null)
    const [b] = await t<{ id: string }[]>`
      insert into bemusterungen (projekt_id, partner_id, angebot_id, runde, revision, bezeichnung, menge, kosten,
                                 waehrung, bestellt_am, tracking, notiz, erstellt_von)
      values (${projekt.id}, ${p.partner_id}, ${angebot?.id ?? null}, ${runde}, ${revision}, ${p.bezeichnung ?? null},
              ${p.menge ?? null}, ${kosten}, ${waehrung}, coalesce(${p.bestellt_am ?? null}::date, current_date),
              ${p.tracking ?? null}, ${p.notiz ?? null}, ${ctx.actor})
      returning id`
    const text = rundeText({ runde, revision, bezeichnung: p.bezeichnung })
    await t`select log_event('bemusterung', ${b.id}, 'state', ${`Muster angefordert (${text})`}, ${ctx.actor})`
    await t`select log_event('einkaufsprojekt', ${projekt.id}, 'info', ${`Muster bei ${lieferant.name} angefordert (${text})`}, ${ctx.actor})`
    return { id: b.id, runde }
  })
  return {
    text: `Muster bei ${lieferant.name} angefordert — Runde ${neu.runde}.`,
    recordId: neu.id,
    link: `/einkauf/muster/${neu.id}`,
  }
}

export async function musterErhalten(
  p: { erhalten_am?: string; tracking?: string; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const r = await rundeLesen(ctx.recordId!)
  if (r.status !== 'offen') throw new Error(`Runde ${r.runde} ist schon ${STATUS_TEXT[r.status]}.`)
  const [neu] = await sql<{ erhalten_am: string }[]>`
    update bemusterungen set
      erhalten_am = coalesce(${p.erhalten_am ?? null}::date, current_date),
      tracking = coalesce(${p.tracking ?? null}, tracking),
      notiz = coalesce(${p.notiz ?? null}, notiz)
    where id = ${r.id}
    returning erhalten_am::text as erhalten_am`
  const am = neu.erhalten_am.split('-').reverse().join('.')
  await sql`select log_event('bemusterung', ${r.id}, 'info', ${`Muster eingegangen am ${am}`}, ${ctx.actor})`
  return { text: `Eingang am ${am} erfasst — jetzt bewerten.`, recordId: r.id }
}

export async function musterBewerten(
  p: { ergebnis: MusterErgebnis; golden: boolean; note?: number; bewertung?: string; naechste_revision?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const r = await rundeLesen(ctx.recordId!)
  if (r.status !== 'offen') throw new Error(`Runde ${r.runde} ist schon ${STATUS_TEXT[r.status]}.`)
  const status = ERGEBNIS_STATUS[p.ergebnis]
  const golden = p.ergebnis === 'freigeben' && p.golden

  const ergebnis = await tx(async (t) => {
    if (golden) {
      // Ein neues Golden Sample ersetzt das alte desselben Lieferanten im Projekt.
      const alt = await t<{ id: string; runde: number }[]>`
        update bemusterungen set golden = false
        where projekt_id = ${r.projekt_id} and partner_id = ${r.partner_id} and golden and id <> ${r.id}
        returning id, runde`
      for (const a of alt) {
        await t`select log_event('bemusterung', ${a.id}, 'info', ${`Golden Sample ersetzt durch Runde ${r.runde}`}, ${ctx.actor})`
      }
    }
    await t`
      update bemusterungen set
        status = ${status}::bemusterung_status,
        golden = ${golden},
        bewertung_note = ${p.note ?? null},
        bewertung = ${p.bewertung ?? null},
        bewertet_von = ${ctx.actor},
        bewertet_am = now(),
        -- Wer freigibt oder nachbessern lässt, hat das Muster in der Hand.
        erhalten_am = case when ${p.ergebnis !== 'ablehnen'} then coalesce(erhalten_am, current_date) else erhalten_am end
      where id = ${r.id}`

    const wort =
      p.ergebnis === 'freigeben' ? (golden ? 'als Golden Sample freigegeben' : 'freigegeben') : p.ergebnis === 'ablehnen' ? 'abgelehnt' : 'zum Nachbessern zurück'
    const befund = p.bewertung ? `: ${p.bewertung}` : ''
    await t`select log_event('bemusterung', ${r.id}, 'state', ${`Runde ${r.runde} ${wort}${befund}`}, ${ctx.actor})`
    await t`select log_event('einkaufsprojekt', ${r.projekt_id}, ${golden ? 'state' : 'info'},
                             ${`Muster von ${r.lieferant} (Runde ${r.runde}) ${wort}${befund}`}, ${ctx.actor})`

    if (p.ergebnis !== 'nachbessern') return { wort, naechste: null as { id: string; runde: number } | null }

    // Nachbessern: die nächste Runde beginnt sofort (gleicher Lieferant, gleiches Muster).
    const revision = p.naechste_revision ?? naechsteRevision(r.revision)
    const [n] = await t<{ id: string; runde: number }[]>`
      insert into bemusterungen (projekt_id, partner_id, angebot_id, runde, revision, bezeichnung, menge, waehrung,
                                 bestellt_am, vorgaenger_id, notiz, erstellt_von)
      values (${r.projekt_id}, ${r.partner_id}, ${r.angebot_id}, ${r.runde + 1}, ${revision}, ${r.bezeichnung},
              ${r.menge}, ${r.waehrung}, current_date, ${r.id},
              ${`Nachbesserung zu Runde ${r.runde}${befund}`}, ${ctx.actor})
      returning id, runde`
    await t`select log_event('bemusterung', ${n.id}, 'state', ${`Runde ${n.runde} angelegt (Nachbesserung zu Runde ${r.runde})`}, ${ctx.actor})`
    return { wort, naechste: n }
  })

  if (ergebnis.naechste) {
    return {
      text: `Runde ${r.runde} zum Nachbessern zurück — Runde ${ergebnis.naechste.runde} ist angelegt.`,
      recordId: r.id,
      link: `/einkauf/muster/${ergebnis.naechste.id}`,
      daten: { naechste_runde_id: ergebnis.naechste.id },
    }
  }
  return { text: `Runde ${r.runde} ${ergebnis.wort}.`, recordId: r.id }
}

export async function musterAendern(p: MusterFelder & { erhalten_am?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const r = await rundeLesen(ctx.recordId!)
  if (p.waehrung) await waehrungPruefen(p.waehrung)
  await sql`
    update bemusterungen set
      bezeichnung = coalesce(${p.bezeichnung ?? null}, bezeichnung),
      revision = coalesce(${p.revision ?? null}, revision),
      menge = coalesce(${p.menge ?? null}, menge),
      kosten = coalesce(${p.kosten ?? null}, kosten),
      waehrung = coalesce(${p.waehrung ?? null}, waehrung),
      bestellt_am = coalesce(${p.bestellt_am ?? null}::date, bestellt_am),
      erhalten_am = coalesce(${p.erhalten_am ?? null}::date, erhalten_am),
      tracking = coalesce(${p.tracking ?? null}, tracking),
      notiz = coalesce(${p.notiz ?? null}, notiz)
    where id = ${r.id}`
  await sql`select log_event('bemusterung', ${r.id}, 'info', 'Daten der Runde geändert', ${ctx.actor})`
  return { text: `Runde ${r.runde} gespeichert.`, recordId: r.id }
}
