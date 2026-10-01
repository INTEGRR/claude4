import { sql } from '@/db/client'
import {
  TEAMS,
  type Team,
  datumAufloesen,
  heuteInBerlin,
  istSelbst,
  teamAusText,
  uhrzeitAufloesen,
} from '@/modules/aufgaben/termin'
import { darfAbhaken, darfVerwerfen } from '@/modules/aufgaben/rechte'
import { type AktionsErgebnis, type AktionsKontext, UUID_MUSTER } from './typen.ts'

/** Ausführung der Aufgaben (0104): anlegen, abhaken, verwerfen. */

const datumDeutsch = (iso: string) => iso.split('-').reverse().join('.')

const nutzerSicht = (ctx: AktionsKontext) => ({ id: ctx.userId, rollen: ctx.rollen ?? [ctx.role] })

const likeMuster = (text: string) => text.toLowerCase().replace(/[\\%_]/g, (z) => `\\${z}`)

interface Zustaendig {
  id: string | null
  rolle: Team | null
  anzeige: string
}

/**
 * „Tino", „Tino Müller", „tino.m", „das Lager", „mich" → Person oder Team.
 * Exakte Kennungen (ID, Name, Benutzername, E-Mail) vor Vor-/Nachnamen;
 * mehrdeutig wird abgewiesen statt geraten.
 */
async function zustaendigAufloesen(text: string | undefined, ctx: AktionsKontext): Promise<Zustaendig> {
  if (!text || istSelbst(text)) {
    if (!ctx.userId) throw new Error('Für wen ist die Aufgabe? Bitte eine Person oder ein Team angeben.')
    return { id: ctx.userId, rolle: null, anzeige: 'dich' }
  }
  const team = teamAusText(text)
  if (team) return { id: null, rolle: team, anzeige: `Team ${TEAMS[team]}` }

  const alsUuid = UUID_MUSTER.test(text) ? text : null
  const exakt = await sql<{ id: string; name: string }[]>`
    select id, name from users
    where active and (id = ${alsUuid}::uuid or lower(name) = lower(${text})
                      or lower(benutzername) = lower(${text}) or lower(email) = lower(${text}))
    limit 2`
  if (exakt.length === 1) return { id: exakt[0].id, rolle: null, anzeige: exakt[0].name }

  const muster = likeMuster(text)
  const treffer = await sql<{ id: string; name: string }[]>`
    select id, name from users
    where active and (lower(name) like ${`${muster} %`} or lower(name) like ${`% ${muster}`})
    order by name limit 5`
  if (treffer.length === 1) return { id: treffer[0].id, rolle: null, anzeige: treffer[0].name }
  if (treffer.length > 1) {
    throw new Error(`„${text}" ist mehrdeutig: ${treffer.map((t) => t.name).join(', ')} — bitte den ganzen Namen.`)
  }

  // Mitarbeiter ohne Benutzerkonto haben keine Übersicht, in der die Aufgabe erscheinen könnte.
  const [ohneKonto] = await sql<{ name: string }[]>`
    select name from employees
    where active and user_id is null
      and (lower(name) = lower(${text}) or lower(name) like ${`${muster} %`} or lower(name) like ${`% ${muster}`})
    limit 1`
  if (ohneKonto) {
    throw new Error(
      `${ohneKonto.name} hat kein Benutzerkonto — ohne Anmeldung gibt es keine Übersicht, in der die Aufgabe ` +
        'erscheinen könnte. Konto anlegen oder die Aufgabe ans Team geben (Lager, Fertigung, Büro).',
    )
  }
  throw new Error(`Niemanden namens „${text}" gefunden — Name, Benutzername oder ein Team (Lager, Fertigung, Büro).`)
}

export async function aufgabeAnlegen(
  p: { titel: string; beschreibung?: string; zustaendig?: string; faellig_am: string; uhrzeit?: string; dauer_min?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const heute = heuteInBerlin()
  const datum = datumAufloesen(p.faellig_am, heute)
  if (datum < heute) throw new Error(`Der Termin ${datumDeutsch(datum)} liegt in der Vergangenheit.`)
  const uhrzeit = uhrzeitAufloesen(p.uhrzeit)
  const wer = await zustaendigAufloesen(p.zustaendig, ctx)

  const [a] = await sql<{ id: string }[]>`
    insert into aufgaben (titel, beschreibung, zustaendig_id, rolle, faellig_am, uhrzeit, dauer_min,
                          erstellt_von, erstellt_von_id)
    values (${p.titel}, ${p.beschreibung ?? null}, ${wer.id}, ${wer.rolle}, ${datum}, ${uhrzeit},
            ${p.dauer_min ?? null}, ${ctx.actor}, ${ctx.userId ?? null})
    returning id`
  const termin = `${datum === heute ? 'heute' : datumDeutsch(datum)}${uhrzeit ? `, ${uhrzeit} Uhr` : ''}`
  await sql`select log_event('aufgabe', ${a.id}, 'info',
    ${`Aufgabe für ${wer.anzeige === 'dich' ? ctx.actor : wer.anzeige}: ${p.titel} (${termin})`}, ${ctx.actor})`
  return {
    text: `Aufgabe für ${wer.anzeige} angelegt — fällig ${termin}.`,
    recordId: a.id,
    link: '/aufgaben',
  }
}

interface OffeneAufgabe {
  id: string
  titel: string
  zustaendig_id: string | null
  rolle: string | null
  erstellt_von_id: string | null
}

/** Die offene Aufgabe zur ID oder zum Stichwort — Stichworte nur unter den eigenen. */
async function offeneAufgabeFinden(kennung: string, ctx: AktionsKontext): Promise<OffeneAufgabe> {
  if (UUID_MUSTER.test(kennung)) {
    const [a] = await sql<(OffeneAufgabe & { status: string })[]>`
      select id, titel, zustaendig_id, rolle::text as rolle, erstellt_von_id, status::text as status
      from aufgaben where id = ${kennung}`
    if (!a) throw new Error('Aufgabe nicht gefunden.')
    if (a.status !== 'offen') throw new Error(`„${a.titel}" ist schon ${a.status}.`)
    return a
  }
  const rollen = ctx.rollen ?? [ctx.role]
  const treffer = await sql<OffeneAufgabe[]>`
    select id, titel, zustaendig_id, rolle::text as rolle, erstellt_von_id
    from aufgaben
    where status = 'offen'
      and (zustaendig_id = ${ctx.userId ?? null}::uuid
           or (zustaendig_id is null and rolle::text = any(${rollen}::text[])))
      and lower(titel) like ${`%${likeMuster(kennung)}%`}
    order by faellig_um
    limit 5`
  if (treffer.length === 0) throw new Error(`Keine offene Aufgabe zu „${kennung}" bei dir.`)
  if (treffer.length > 1) {
    throw new Error(`Mehrere passen: ${treffer.map((t) => `„${t.titel}"`).join(', ')} — welche genau?`)
  }
  return treffer[0]
}

export async function aufgabeErledigen(p: { aufgabe: string; notiz?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const a = await offeneAufgabeFinden(p.aufgabe, ctx)
  if (!darfAbhaken(a, nutzerSicht(ctx))) {
    throw new Error(`„${a.titel}" ist nicht deine Aufgabe — abhaken dürfen der Zuständige, wer sie angelegt hat, und das Büro.`)
  }
  const [fertig] = await sql<{ id: string }[]>`
    update aufgaben set status = 'erledigt', erledigt_am = now(), erledigt_von = ${ctx.actor},
                        notiz = ${p.notiz ?? null}
    where id = ${a.id} and status = 'offen'
    returning id`
  if (!fertig) throw new Error(`„${a.titel}" wurde gerade schon abgeschlossen.`)
  await sql`select log_event('aufgabe', ${a.id}, 'info',
    ${`Erledigt: ${a.titel}${p.notiz ? ` — ${p.notiz}` : ''}`}, ${ctx.actor})`
  return { text: `Erledigt: ${a.titel}.`, recordId: a.id }
}

export async function aufgabeVerwerfen(p: { aufgabe_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const a = await offeneAufgabeFinden(p.aufgabe_id, ctx)
  if (!darfVerwerfen(a, nutzerSicht(ctx))) {
    throw new Error('Verwerfen darf, wer die Aufgabe angelegt hat, und das Büro.')
  }
  await sql`
    update aufgaben set status = 'verworfen', erledigt_am = now(), erledigt_von = ${ctx.actor}
    where id = ${a.id} and status = 'offen'`
  await sql`select log_event('aufgabe', ${a.id}, 'info', ${`Verworfen: ${a.titel}`}, ${ctx.actor})`
  return { text: `Verworfen: ${a.titel}.`, recordId: a.id }
}
