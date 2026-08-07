'use server'
import { revalidatePath } from 'next/cache'
import { sql } from '@/db/client'
import { hashPassword, requireAdmin } from '@/modules/auth'
import { ALL_ROLES, type Role } from '@/modules/auth/permissions'
import { actionError } from '@/modules/shared/action'

function parseRole(value: unknown): Role | null {
  const role = String(value ?? '')
  return (ALL_ROLES as string[]).includes(role) ? (role as Role) : null
}

/** Liefert eine Meldung, wenn nach der Änderung kein Administrator übrig bliebe. */
async function guardLastAdmin(userId: string) {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from users
    where role = 'admin' and active and id <> ${userId}`
  if (row.count === 0) {
    return actionError('Der letzte aktive Administrator kann nicht entfernt werden')
  }
}

export async function createUser(formData: FormData) {
  const admin = await requireAdmin()
  const email = String(formData.get('email') ?? '').trim()
  const name = String(formData.get('name') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const role = parseRole(formData.get('role'))

  if (!role) return actionError('Unbekannte Rolle')
  if (!email.includes('@')) return actionError('Bitte eine gültige E-Mail-Adresse angeben')
  if (!name) return actionError('Bitte einen Namen angeben')
  if (password.length < 8) return actionError('Das Passwort braucht mindestens 8 Zeichen')

  const [row] = await sql<{ id: string }[]>`
    insert into users (email, name, password_hash, role)
    values (${email}, ${name}, ${await hashPassword(password)}, ${role})
    on conflict (email) do nothing
    returning id`
  if (!row) return actionError('Diese E-Mail-Adresse ist bereits vergeben')

  await sql`select log_event('user', ${row.id}, 'state', ${'Benutzer angelegt (' + role + ')'}, ${admin.name})`
  revalidatePath('/einstellungen/benutzer')
}

export async function setRole(userId: string, formData: FormData) {
  const admin = await requireAdmin()
  const role = parseRole(formData.get('role'))
  if (!role) return actionError('Unbekannte Rolle')
  if (role !== 'admin') {
    const problem = await guardLastAdmin(userId)
    if (problem) return problem
  }

  await sql`update users set role = ${role} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state', ${'Rolle geändert auf ' + role}, ${admin.name})`
  revalidatePath('/einstellungen/benutzer')
}

export async function setActive(userId: string, active: boolean) {
  const admin = await requireAdmin()
  if (!active) {
    const problem = await guardLastAdmin(userId)
    if (problem) return problem
    // Laufende Sitzungen des deaktivierten Kontos sofort beenden.
    await sql`delete from sessions where user_id = ${userId}`
  }
  await sql`update users set active = ${active} where id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state',
    ${active ? 'Benutzer aktiviert' : 'Benutzer deaktiviert'}, ${admin.name})`
  revalidatePath('/einstellungen/benutzer')
}

export async function resetPassword(userId: string, formData: FormData) {
  const admin = await requireAdmin()
  const password = String(formData.get('password') ?? '')
  if (password.length < 8) return actionError('Das Passwort braucht mindestens 8 Zeichen')

  await sql`update users set password_hash = ${await hashPassword(password)} where id = ${userId}`
  await sql`delete from sessions where user_id = ${userId}`
  await sql`select log_event('user', ${userId}, 'state', 'Passwort zurückgesetzt', ${admin.name})`
  revalidatePath('/einstellungen/benutzer')
}
