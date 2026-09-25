import 'server-only'
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { sql } from '@/db/client'
import { type Area, type Role, canAccess, canWrite } from './permissions'
import {
  fehlversuchMerken,
  fehlversucheLoeschen,
  kennungHash,
  loginGesperrt,
  loginVersucheAufraeumen,
} from './drossel'
import {
  GERAET_TAGE,
  SITZUNG_TAGE,
  backupCodeEinloesen,
  backupCodesErneuern,
  codePruefenUndMerken,
  einmalAbholen,
  einmalSetzen,
  entwurfLoeschen,
  entwurfSicherstellen,
  geraetBezeichnung,
  geraetVertrauen,
  geraetVertraut,
  geraeteAufraeumen,
  pflichtGilt,
  sicherheitsEinstellung,
  sitzungBestaetigen,
  sitzungErstellen,
  sitzungNutzer,
  tokenHash,
  totpAktivieren,
  wartendeSitzung,
  zweifaktorStatus,
} from './zweifaktor'
import { geheimnisErzeugen, istTotpCode, totpPruefen } from './totp'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const COOKIE = 'erp_session'
/** Vertrautes Gerät („30 Tage merken") — eigener Cookie, eigene Lebensdauer. */
const GERAET_COOKIE = 'erp_geraet'

export type { Area, Role } from './permissions'
export interface User {
  id: string
  email: string
  name: string
  role: Role
  /** Personengebundene Zusatzrechte (z. B. einkauf:freigabe), siehe permissions.ts. */
  befugnisse: string[]
  /** Zweiter Faktor eingerichtet? Das Layout-Tor schickt Pflichtige ohne ihn zur Einrichtung. */
  totpAktiv: boolean
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

/** Im Cookie steht ein Zufallswert, in der Datenbank nur dessen Hash (zweifaktor.ts). */
const hashToken = tokenHash

function cookieOptionen(maxAgeSekunden: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSekunden,
  }
}

/**
 * Ergebnis der Anmeldung: Benutzer (Sitzung steht), falsche Daten (null),
 * zeitweise gesperrt — oder der zweite Schritt: Code eingeben bzw. den
 * zweiten Faktor erst einrichten (Pflicht). In beiden Fällen liegt bereits
 * eine WARTENDE Sitzung im Cookie.
 */
export type LoginErgebnis = User | null | 'gesperrt' | { schritt: 'code' | 'einrichten' }

/** Absender-Pseudonym aus dem Proxy-Header — außerhalb einer Anfrage (Skripte) null. */
async function absenderHash(): Promise<string | null> {
  try {
    const h = await headers()
    const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')
    return ip ? kennungHash(ip) : null
  } catch {
    return null
  }
}

async function ereignis(userId: string, text: string, actor: string): Promise<void> {
  await sql`select log_event('user', ${userId}, 'state', ${text}, ${actor})`
}

export async function login(email: string, password: string): Promise<LoginErgebnis> {
  // Drossel VOR der Prüfung: ein gesperrtes Konto bekommt keine Antwort
  // darauf, ob das Passwort gestimmt hätte (Entscheidungslog 2026-09-18).
  const konto = kennungHash(email)
  const absender = await absenderHash()
  if (await loginGesperrt(sql, konto, absender)) return 'gesperrt'

  const [row] = await sql<
    {
      id: string
      email: string
      name: string
      role: Role
      befugnisse: string[]
      password_hash: string
      totp_aktiv: boolean
    }[]
  >`select id, email, name, role, befugnisse, password_hash,
           totp_aktiviert_at is not null as totp_aktiv
    from users where lower(email) = lower(${email}) and active`
  if (!row) {
    // Gleichbleibende Antwortzeit, damit unbekannte Konten nicht auffallen.
    await scrypt(password, randomBytes(16), 64)
    await fehlversuchMerken(sql, konto, absender)
    return null
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    await fehlversuchMerken(sql, konto, absender)
    return null
  }
  await fehlversucheLoeschen(sql, konto)

  const user: User = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    befugnisse: row.befugnisse,
    totpAktiv: row.totp_aktiv,
  }
  const jar = await cookies()
  const sitzung = async (opts: { bestaetigt: boolean; entwurf?: string | null }) => {
    const token = await sitzungErstellen(sql, row.id, opts)
    jar.set(COOKIE, token, cookieOptionen(SITZUNG_TAGE * 24 * 60 * 60))
  }

  // Zweiter Faktor eingerichtet: vertrautes Gerät kommt durch, sonst Code.
  if (user.totpAktiv) {
    const geraet = jar.get(GERAET_COOKIE)?.value
    if (geraet && (await geraetVertraut(sql, row.id, geraet))) {
      await sitzung({ bestaetigt: true })
      await ereignis(row.id, 'Anmeldung (Passwort, vertrautes Gerät)', row.name)
      return user
    }
    await sitzung({ bestaetigt: false })
    return { schritt: 'code' }
  }

  // Nicht eingerichtet: Pflicht → erst einrichten, sonst normale Sitzung.
  const { zwei_faktor } = await sicherheitsEinstellung(sql)
  if (pflichtGilt(row.role, zwei_faktor)) {
    await sitzung({ bestaetigt: false, entwurf: geheimnisErzeugen() })
    return { schritt: 'einrichten' }
  }
  await sitzung({ bestaetigt: true })
  await ereignis(row.id, 'Anmeldung (Passwort, ohne zweiten Faktor)', row.name)
  return user
}

export async function logout(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (token) await sql`delete from sessions where token = ${hashToken(token)}`
  jar.delete(COOKIE)
}

/** Liefert den angemeldeten Benutzer oder null — nur BESTÄTIGTE Sitzungen. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  const row = await sitzungNutzer(sql, hashToken(token))
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    befugnisse: row.befugnisse,
    totpAktiv: row.totp_aktiv,
  }
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

// --- Zweiter Faktor ---------------------------------------------------------

/** Die wartende Sitzung hinter dem Cookie — für /login/code und /login/einrichten. */
export async function wartenderNutzer(): Promise<{
  email: string
  name: string
  totpAktiv: boolean
} | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  const w = await wartendeSitzung(sql, hashToken(token))
  return w ? { email: w.email, name: w.name, totpAktiv: w.totp_aktiv } : null
}

export type FaktorErgebnis = 'ok' | 'falsch' | 'gesperrt' | 'keine_sitzung' | 'nicht_eingerichtet'

/**
 * Zweiter Schritt der Anmeldung: App-Code oder Backup-Code gegen die wartende
 * Sitzung. Falsche Codes zählen in derselben Drossel wie falsche Passwörter
 * (fünf je Konto in 15 Minuten) — sechs Ziffern lassen sich sonst raten.
 */
export async function zweitenFaktorPruefen(
  code: string,
  geraetMerken: boolean,
): Promise<FaktorErgebnis> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return 'keine_sitzung'
  const hash = hashToken(token)
  const wartend = await wartendeSitzung(sql, hash)
  if (!wartend) return 'keine_sitzung'
  if (!wartend.totp_aktiv) return 'nicht_eingerichtet'

  const konto = kennungHash(wartend.email)
  const absender = await absenderHash()
  if (await loginGesperrt(sql, konto, absender)) return 'gesperrt'

  let methode: 'TOTP' | 'Backup-Code' | null = null
  if (istTotpCode(code)) {
    if (await codePruefenUndMerken(sql, wartend.user_id, code)) methode = 'TOTP'
  } else if (code.trim() && (await backupCodeEinloesen(sql, wartend.user_id, code))) {
    methode = 'Backup-Code'
  }
  if (!methode) {
    await fehlversuchMerken(sql, konto, absender)
    return 'falsch'
  }

  await sitzungBestaetigen(sql, hash)
  await fehlversucheLoeschen(sql, konto)
  if (geraetMerken) {
    const h = await headers()
    const geraet = await geraetVertrauen(sql, wartend.user_id, geraetBezeichnung(h.get('user-agent')))
    jar.set(GERAET_COOKIE, geraet, cookieOptionen(GERAET_TAGE * 24 * 60 * 60))
  }
  await ereignis(
    wartend.user_id,
    `Anmeldung (${methode}${geraetMerken ? ', Gerät 30 Tage vertraut' : ''})`,
    wartend.name,
  )
  if (methode === 'Backup-Code') {
    const status = await zweifaktorStatus(sql, wartend.user_id)
    await ereignis(
      wartend.user_id,
      `Backup-Code verwendet — ${status.backup_offen} verbleiben`,
      wartend.name,
    )
  }
  return 'ok'
}

export type EinrichtungsKontext =
  | { art: 'einrichten'; email: string; name: string; secret: string }
  | { art: 'code' }
  | { art: 'fertig' }

/**
 * Wer richtet gerade ein? Entweder eine wartende Sitzung (frischer Login
 * unter Pflicht) oder eine volle Altsitzung (Pflicht-Nachzügler, vom
 * Layout-Tor geschickt). Das Geheimnis hängt an der Sitzung, damit die Seite
 * neu laden darf, ohne dass der QR-Code wechselt.
 */
export async function einrichtungKontext(): Promise<EinrichtungsKontext | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  const hash = hashToken(token)
  const wartend = await wartendeSitzung(sql, hash)
  if (wartend) {
    if (wartend.totp_aktiv) return { art: 'code' }
    const secret = wartend.entwurf ?? (await entwurfSicherstellen(sql, hash))
    return { art: 'einrichten', email: wartend.email, name: wartend.name, secret }
  }
  const user = await currentUser()
  if (!user) return null
  if (user.totpAktiv) return { art: 'fertig' }
  return { art: 'einrichten', email: user.email, name: user.name, secret: await entwurfSicherstellen(sql, hash) }
}

/**
 * Einrichtung abschließen: der erste Code aus der App beweist, dass das
 * Geheimnis angekommen ist. Dann: Geheimnis am Konto, zehn Backup-Codes
 * (Klartext einmalig an der Sitzung für /konto?neu=1), Sitzung bestätigt.
 */
export async function einrichtungAbschliessen(code: string): Promise<FaktorErgebnis> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return 'keine_sitzung'
  const hash = hashToken(token)

  const wartend = await wartendeSitzung(sql, hash)
  const voll = wartend ? null : await currentUser()
  const userId = wartend?.user_id ?? voll?.id
  const email = wartend?.email ?? voll?.email
  const name = wartend?.name ?? voll?.name
  if (!userId || !email || !name) return 'keine_sitzung'
  if (wartend?.totp_aktiv || voll?.totpAktiv) return 'nicht_eingerichtet'

  const konto = kennungHash(email)
  const absender = await absenderHash()
  if (await loginGesperrt(sql, konto, absender)) return 'gesperrt'

  const secret = wartend?.entwurf ?? (await entwurfSicherstellen(sql, hash))
  const schritt = totpPruefen(secret, code)
  if (schritt === null) {
    await fehlversuchMerken(sql, konto, absender)
    return 'falsch'
  }

  await totpAktivieren(sql, userId, secret, schritt)
  const codes = await backupCodesErneuern(sql, userId)
  await sitzungBestaetigen(sql, hash)
  await entwurfLoeschen(sql, hash)
  await einmalSetzen(sql, hash, { backup_codes: codes })
  await fehlversucheLoeschen(sql, konto)
  await ereignis(userId, `Zweiter Faktor eingerichtet (TOTP), ${codes.length} Backup-Codes erzeugt`, name)
  await ereignis(userId, 'Anmeldung (TOTP, Einrichtung)', name)
  return 'ok'
}

/** Einmal-Anzeige der aktuellen Sitzung (frische Backup-Codes) — beim Lesen gelöscht. */
export async function einmalAnzeigeAbholen<T>(): Promise<T | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  return einmalAbholen<T>(sql, hashToken(token))
}

// --- Housekeeping ----------------------------------------------------------

/** Räumt abgelaufene Sitzungen weg — auch wartende, die nie bestätigt wurden. */
export async function pruneSessions(): Promise<number> {
  const rows = await sql`delete from sessions where expires_at < now() returning token`
  return rows.length
}

export async function pruneLoginVersuche(): Promise<number> {
  return loginVersucheAufraeumen(sql)
}

export async function pruneGeraete(): Promise<number> {
  return geraeteAufraeumen(sql)
}
