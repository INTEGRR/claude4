import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Prozess-Verwaltungsaktionen. */

export async function prozessschrittSchalten(
  p: { prozess_code: string; schritt_code: string; aktiv: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [schritt] = await sql<{ optional: boolean; name: string }[]>`
    select s.optional, s.name from prozess_schritte s
    where s.version_id = prozess_aktive_version(${p.prozess_code})
      and s.code = ${p.schritt_code}`
  if (!schritt) {
    throw new Error(
      `Schritt „${p.schritt_code}" existiert nicht in der aktiven Version von ${p.prozess_code}.`,
    )
  }
  if (!p.aktiv && !schritt.optional) {
    throw new Error('Nur optionale Schritte lassen sich abschalten.')
  }

  await sql`
    insert into prozess_overrides (prozess_code, schritt_code, aktiv, geaendert_von)
    values (${p.prozess_code}, ${p.schritt_code}, ${p.aktiv}, ${ctx.actor})
    on conflict (prozess_code, schritt_code)
    do update set aktiv = excluded.aktiv, geaendert_von = excluded.geaendert_von`

  return {
    text: `„${schritt.name}" ist jetzt ${p.aktiv ? 'aktiv' : 'abgeschaltet'}.`,
    recordId: p.prozess_code,
  }
}

// --- Eigene Felder (Chamäleon) -----------------------------------------------

export async function feldAnlegen(
  p: {
    modell: string
    name: string
    label: string
    typ: string
    pflicht: boolean
    auswahl?: string[]
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into feld_definitionen (modell, name, label, typ, pflicht, auswahl)
    values (${p.modell}, ${p.name}, ${p.label}, ${p.typ}, ${p.pflicht},
            ${p.auswahl && p.auswahl.length ? p.auswahl : null})
    on conflict (modell, name) do update
      set label = excluded.label, typ = excluded.typ,
          pflicht = excluded.pflicht, auswahl = excluded.auswahl`
  await sql`select log_event('feld_definition', gen_random_uuid(), 'state',
    ${`Eigenes Feld: ${p.modell}.${p.name} (${p.typ})`}, ${ctx.actor})`
  return { text: `Feld ${p.modell}.${p.name} angelegt.` }
}

export async function feldLoeschen(p: {
  modell: string
  name: string
}): Promise<AktionsErgebnis> {
  await sql`delete from feld_definitionen where modell = ${p.modell} and name = ${p.name}`
  return { text: `Feld ${p.modell}.${p.name} entfernt — erfasste Werte bleiben im zusatz stehen.` }
}

// --- Benutzerverwaltung ------------------------------------------------------

/** Wirft, wenn nach der Änderung kein aktiver Administrator übrig bliebe. */
async function guardLetzterAdmin(userId: string): Promise<void> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from users
    where role = 'admin' and active and id <> ${userId}`
  if (Number(row.count) === 0) {
    throw new Error('Der letzte aktive Administrator kann nicht entfernt werden')
  }
}

/**
 * hashPassword kommt aus dem Auth-Modul, das next/headers zieht — deshalb
 * dynamisch importiert: der Katalog bleibt unter blankem Node ladbar, nur
 * die tatsächliche Ausführung braucht die Next-Umgebung.
 */
async function passwortHashen(password: string): Promise<string> {
  const { hashPassword } = await import('@/modules/auth')
  return hashPassword(password)
}

export async function benutzerAnlegen(
  p: { email: string; name: string; password: string; role: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, name, password_hash, role)
    values (${p.email}, ${p.name}, ${await passwortHashen(p.password)}, ${p.role})
    on conflict (email) do nothing
    returning id`
  if (!row) throw new Error('Diese E-Mail-Adresse ist bereits vergeben')

  await sql`select log_event('user', ${row.id}, 'state',
    ${'Benutzer angelegt (' + p.role + ')'}, ${ctx.actor})`
  return { text: `Benutzer ${p.email} angelegt.`, recordId: row.id }
}

export async function benutzerRolle(
  p: { role: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  if (p.role !== 'admin') await guardLetzterAdmin(userId)

  await sql`update users set role = ${p.role} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${'Rolle geändert auf ' + p.role}, ${ctx.actor})`
  return { recordId: userId }
}

export async function benutzerAktiv(
  p: { active: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  if (!p.active) {
    await guardLetzterAdmin(userId)
    // Laufende Sitzungen des deaktivierten Kontos sofort beenden.
    await sql`delete from sessions where user_id = ${userId}`
  }
  await sql`update users set active = ${p.active} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${p.active ? 'Benutzer aktiviert' : 'Benutzer deaktiviert'}, ${ctx.actor})`
  return { recordId: userId }
}

export async function benutzerPasswort(
  p: { password: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const userId = ctx.recordId!
  await sql`update users set password_hash = ${await passwortHashen(p.password)}
            where id = ${userId}`
  await sql`delete from sessions where user_id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state', 'Passwort zurückgesetzt', ${ctx.actor})`
  return { recordId: userId }
}
