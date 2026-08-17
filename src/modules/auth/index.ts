import 'server-only'
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { type Area, type Role, canAccess, canWrite } from './permissions'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const COOKIE = 'erp_session'
const SESSION_DAYS = 30

export type { Area, Role } from './permissions'
export interface User {
  id: string
  email: string
  name: string
  role: Role
  /** Personengebundene Zusatzrechte (z. B. einkauf:freigabe), siehe permissions.ts. */
  befugnisse: string[]
}

// --- Passwörter ------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':')
  if (!saltHex || !keyHex) return false
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(keyHex, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// --- Sitzungen -------------------------------------------------------------

/** Im Cookie steht ein Zufallswert, in der Datenbank nur dessen Hash. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function login(email: string, password: string): Promise<User | null> {
  const [row] = await sql<
    { id: string; email: string; name: string; role: Role; befugnisse: string[]; password_hash: string }[]
  >`select id, email, name, role, befugnisse, password_hash from users
    where lower(email) = lower(${email}) and active`
  if (!row) {
    // Gleichbleibende Antwortzeit, damit unbekannte Konten nicht auffallen.
    await scrypt(password, randomBytes(16), 64)
    return null
  }
  if (!(await verifyPassword(password, row.password_hash))) return null

  const token = randomBytes(32).toString('hex')
  await sql`
    insert into sessions (token, user_id, expires_at)
    values (${hashToken(token)}, ${row.id}, now() + make_interval(days => ${SESSION_DAYS}))`

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })

  return { id: row.id, email: row.email, name: row.name, role: row.role, befugnisse: row.befugnisse }
}

export async function logout(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) await sql`delete from sessions where token = ${hashToken(token)}`
  jar.delete(COOKIE)
}

/** Liefert den angemeldeten Benutzer oder null. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  const [row] = await sql<
    { id: string; email: string; name: string; role: Role; befugnisse: string[] }[]
  >`
    select u.id, u.email, u.name, u.role, u.befugnisse
    from sessions s join users u on u.id = s.user_id
    where s.token = ${hashToken(token)} and s.expires_at > now() and u.active`
  return row ?? null
}

/** Wie currentUser, leitet aber unangemeldete Besucher zum Login. */
export async function requireUser(): Promise<User> {
  const user = await currentUser()
  if (!user) redirect('/login')
  return user
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser()
  if (user.role !== 'admin') {
    throw new Error('Diese Aktion ist Administratoren vorbehalten')
  }
  return user
}

/**
 * Für Seiten: Besucher ohne Zugriff auf den Bereich landen auf der Übersicht.
 * Für Server Actions besser requireWrite verwenden (wirft statt umzuleiten).
 */
export async function requireArea(area: Area): Promise<User> {
  const user = await requireUser()
  if (!canAccess(user.role, area, user.befugnisse)) redirect('/?verweigert=' + area)
  return user
}

/** Für Server Actions: wirft, wenn die Rolle im Bereich nicht arbeiten darf. */
export async function requireWrite(area: Area): Promise<User> {
  const user = await requireUser()
  if (!canWrite(user.role, area, user.befugnisse)) {
    throw new Error('Dafür fehlt Ihrer Rolle die Berechtigung')
  }
  return user
}

/** Räumt abgelaufene Sitzungen weg (vom Cron aufgerufen). */
export async function pruneSessions(): Promise<number> {
  const rows = await sql`delete from sessions where expires_at < now() returning token`
  return rows.length
}
