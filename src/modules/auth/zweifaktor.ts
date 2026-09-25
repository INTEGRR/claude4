import { createHash, randomBytes } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { entschluesseln, verschluesseln } from './geheimnis.ts'
import { backupCodesErzeugen, codeNormalisieren, geheimnisErzeugen, totpPruefen } from './totp.ts'

/**
 * Zweiter Faktor als ZUSTAND DER SITZUNG (Migration 0083, Entscheidungslog
 * 2026-09-25): eine neue Sitzung ist „wartend" (zweiter_faktor_ok = false),
 * bis der Code sie bestätigt. Vertraute Geräte überspringen den Code, Backup-
 * Codes ersetzen ihn im Notfall.
 *
 * Wie drossel.ts bewusst datenbankfrei aufrufbar (Client als Parameter,
 * keine '@/'-Importe), damit alle Regeln unter withRollback testbar sind.
 * Die Anmeldung selbst (auth/index.ts) verdrahtet nur Cookie ↔ Sitzung.
 */

type Db = Sql | TransactionSql

export type ZweiFaktorPflicht = 'alle' | 'admins' | 'freiwillig'
export const PFLICHT_LABELS: Record<ZweiFaktorPflicht, string> = {
  alle: 'Pflicht für alle Benutzer',
  admins: 'Pflicht für Administratoren, freiwillig für alle anderen',
  freiwillig: 'Freiwillig für alle',
}

/** Wartende Sitzung: Passwort geprüft, Code fehlt — läuft schnell ab. */
export const WARTEND_MINUTEN = 10
export const SITZUNG_TAGE = 30
export const GERAET_TAGE = 30
export const BACKUP_CODES = 10

// --- Einstellung ------------------------------------------------------------

/** settings.sicherheit.zwei_faktor — ohne Eintrag gilt „alle" (Betreiber-Entscheidung). */
export async function sicherheitsEinstellung(db: Db): Promise<{ zwei_faktor: ZweiFaktorPflicht }> {
  const [row] = await db<{ zwei_faktor: string | null }[]>`
    select value ->> 'zwei_faktor' as zwei_faktor from settings where key = 'sicherheit'`
  const wert = row?.zwei_faktor
  return { zwei_faktor: wert === 'admins' || wert === 'freiwillig' ? wert : 'alle' }
}

export function pflichtGilt(role: string, einstellung: ZweiFaktorPflicht): boolean {
  return einstellung === 'alle' || (einstellung === 'admins' && role === 'admin')
}

// --- Token ------------------------------------------------------------------

/** Im Cookie steht ein Zufallswert, in der Datenbank nur dessen Hash. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function tokenErzeugen(): string {
  return randomBytes(32).toString('hex')
}

// --- Sitzungen --------------------------------------------------------------

/**
 * Legt eine Sitzung an und liefert den Cookie-Wert. Bestätigt = 30 Tage;
 * wartend = zehn Minuten, mit optionalem Einrichtungs-Entwurf (verschlüsselt).
 */
export async function sitzungErstellen(
  db: Db,
  userId: string,
  opts: { bestaetigt: boolean; entwurf?: string | null },
): Promise<string> {
  const token = tokenErzeugen()
  if (opts.bestaetigt) {
    await db`
      insert into sessions (token, user_id, expires_at, zweiter_faktor_ok)
      values (${tokenHash(token)}, ${userId}, now() + make_interval(days => ${SITZUNG_TAGE}), true)`
  } else {
    await db`
      insert into sessions (token, user_id, expires_at, zweiter_faktor_ok, entwurf)
      values (${tokenHash(token)}, ${userId}, now() + make_interval(mins => ${WARTEND_MINUTEN}), false,
              ${opts.entwurf ? verschluesseln(opts.entwurf) : null})`
  }
  return token
}

export interface SitzungsNutzer {
  id: string
  email: string
  name: string
  role: string
  befugnisse: string[]
  totp_aktiv: boolean
}

/** Der Benutzer einer BESTÄTIGTEN, gültigen Sitzung — was currentUser() liefert. */
export async function sitzungNutzer(db: Db, hash: string): Promise<SitzungsNutzer | null> {
  const [row] = await db<SitzungsNutzer[]>`
    select u.id, u.email, u.name, u.role, u.befugnisse, u.totp_aktiviert_at is not null as totp_aktiv
    from sessions s join users u on u.id = s.user_id
    where s.token = ${hash} and s.expires_at > now() and s.zweiter_faktor_ok and u.active`
  return row ?? null
}

export interface WartendeSitzung {
  user_id: string
  email: string
  name: string
  role: string
  totp_aktiv: boolean
  /** Einrichtungs-Geheimnis (Klartext, entschlüsselt) — nur während der Einrichtung. */
  entwurf: string | null
}

/** Die wartende Sitzung hinter einem Cookie — für die Code- und Einrichtungsseite. */
export async function wartendeSitzung(db: Db, hash: string): Promise<WartendeSitzung | null> {
  const [row] = await db<(Omit<WartendeSitzung, 'entwurf'> & { entwurf: string | null })[]>`
    select s.user_id, u.email, u.name, u.role,
           u.totp_aktiviert_at is not null as totp_aktiv, s.entwurf
    from sessions s join users u on u.id = s.user_id
    where s.token = ${hash} and s.expires_at > now() and not s.zweiter_faktor_ok and u.active`
  if (!row) return null
  return { ...row, entwurf: row.entwurf ? entschluesseln(row.entwurf) : null }
}

/** Code war richtig: die Sitzung wird voll (30 Tage), der Entwurf fällt weg. */
export async function sitzungBestaetigen(db: Db, hash: string): Promise<boolean> {
  const rows = await db`
    update sessions
       set zweiter_faktor_ok = true, entwurf = null,
           expires_at = now() + make_interval(days => ${SITZUNG_TAGE})
     where token = ${hash} and not zweiter_faktor_ok and expires_at > now()
    returning token`
  return rows.length > 0
}

/**
 * Einrichtungs-Geheimnis der Sitzung — für Pflicht-Nachzügler mit voller
 * Altsitzung wird eines angelegt, sonst das vorhandene geliefert (die Seite
 * darf neu laden, ohne dass der QR-Code wechselt).
 */
export async function entwurfSicherstellen(db: Db, hash: string): Promise<string> {
  const [row] = await db<{ entwurf: string | null }[]>`
    select entwurf from sessions where token = ${hash}`
  if (row?.entwurf) return entschluesseln(row.entwurf)
  const secret = geheimnisErzeugen()
  await db`update sessions set entwurf = ${verschluesseln(secret)} where token = ${hash}`
  return secret
}

export async function entwurfLoeschen(db: Db, hash: string): Promise<void> {
  await db`update sessions set entwurf = null where token = ${hash}`
}

/** Einmal-Anzeige (z. B. frische Backup-Codes) an der Sitzung ablegen … */
export async function einmalSetzen(db: Db, hash: string, inhalt: unknown): Promise<void> {
  await db`update sessions set einmal = ${verschluesseln(JSON.stringify(inhalt))} where token = ${hash}`
}

/** … und beim Lesen löschen: sie erscheint genau einmal. */
export async function einmalAbholen<T>(db: Db, hash: string): Promise<T | null> {
  // RETURNING liefert die NEUE Zeile (einmal = null) — der alte Wert kommt
  // aus dem CTE; Lesen und Löschen bleiben eine Anweisung.
  const [row] = await db<{ einmal: string }[]>`
    with alt as (select token, einmal from sessions where token = ${hash} and einmal is not null)
    update sessions s set einmal = null from alt where s.token = alt.token
    returning alt.einmal`
  return row ? (JSON.parse(entschluesseln(row.einmal)) as T) : null
}

// --- TOTP am Konto ----------------------------------------------------------

export async function totpAktivieren(
  db: Db,
  userId: string,
  secretBase32: string,
  ersterSchritt: number | null = null,
): Promise<void> {
  await db`
    update users
       set totp_secret = ${verschluesseln(secretBase32)}, totp_aktiviert_at = now(),
           totp_letzter_schritt = ${ersterSchritt}
     where id = ${userId}`
}

/**
 * Prüft den App-Code und merkt den Schritt — atomar, damit derselbe Code
 * nicht zweimal durchgeht (auch nicht aus zwei Browsern gleichzeitig).
 */
export async function codePruefenUndMerken(
  db: Db,
  userId: string,
  code: string,
  zeitMs = Date.now(),
): Promise<boolean> {
  const [row] = await db<{ totp_secret: string | null; totp_letzter_schritt: string | null }[]>`
    select totp_secret, totp_letzter_schritt from users where id = ${userId}`
  if (!row?.totp_secret) return false
  const schritt = totpPruefen(entschluesseln(row.totp_secret), code, {
    zeitMs,
    letzterSchritt: row.totp_letzter_schritt == null ? null : Number(row.totp_letzter_schritt),
  })
  if (schritt === null) return false
  const rows = await db`
    update users set totp_letzter_schritt = ${schritt}
     where id = ${userId} and coalesce(totp_letzter_schritt, -1) < ${schritt}
    returning id`
  return rows.length > 0
}

export async function zweifaktorStatus(
  db: Db,
  userId: string,
): Promise<{ aktiv: boolean; aktiviert_at: string | null; backup_offen: number }> {
  const [row] = await db<{ aktiviert_at: string | null; backup_offen: number }[]>`
    select totp_aktiviert_at as aktiviert_at,
           (select count(*) from backup_codes b
             where b.user_id = u.id and b.verwendet_at is null)::int as backup_offen
    from users u where u.id = ${userId}`
  return {
    aktiv: row?.aktiviert_at != null,
    aktiviert_at: row?.aktiviert_at ?? null,
    backup_offen: Number(row?.backup_offen ?? 0),
  }
}

/** Alles weg: Geheimnis, Codes, Geräte, Sitzungen — der nächste Login richtet neu ein. */
export async function zweifaktorZuruecksetzen(db: Db, userId: string): Promise<void> {
  await db`
    update users set totp_secret = null, totp_aktiviert_at = null, totp_letzter_schritt = null
     where id = ${userId}`
  await db`delete from backup_codes where user_id = ${userId}`
  await db`delete from vertraute_geraete where user_id = ${userId}`
  await db`delete from sessions where user_id = ${userId}`
}

// --- Backup-Codes -----------------------------------------------------------

/** Nur der Hash liegt in der Datenbank — mit Salz aus SESSION_SECRET, wie kennungHash. */
export function backupCodeHash(code: string, salz = process.env.SESSION_SECRET ?? 'krnl'): string {
  return createHash('sha256').update(`${salz}:${codeNormalisieren(code)}`).digest('hex')
}

/** Neue Codes (die alten gelten nicht mehr); liefert den Klartext zur Einmal-Anzeige. */
export async function backupCodesErneuern(db: Db, userId: string): Promise<string[]> {
  const codes = backupCodesErzeugen(BACKUP_CODES)
  await db`delete from backup_codes where user_id = ${userId}`
  for (const code of codes) {
    await db`insert into backup_codes (user_id, code_hash) values (${userId}, ${backupCodeHash(code)})`
  }
  return codes
}

export async function backupCodeEinloesen(db: Db, userId: string, code: string): Promise<boolean> {
  const rows = await db`
    update backup_codes set verwendet_at = now()
     where user_id = ${userId} and code_hash = ${backupCodeHash(code)} and verwendet_at is null
    returning id`
  return rows.length > 0
}

// --- Vertraute Geräte -------------------------------------------------------

/** Merkt den Browser 30 Tage; liefert den Cookie-Wert (erp_geraet). */
export async function geraetVertrauen(db: Db, userId: string, bezeichnung: string): Promise<string> {
  const token = tokenErzeugen()
  await db`
    insert into vertraute_geraete (user_id, token_hash, bezeichnung, laeuft_ab_at, zuletzt_at)
    values (${userId}, ${tokenHash(token)}, ${bezeichnung},
            now() + make_interval(days => ${GERAET_TAGE}), now())`
  return token
}

/** Gilt das Gerät noch für DIESEN Benutzer? Aktualisiert „zuletzt". */
export async function geraetVertraut(db: Db, userId: string, token: string): Promise<boolean> {
  const rows = await db`
    update vertraute_geraete set zuletzt_at = now()
     where user_id = ${userId} and token_hash = ${tokenHash(token)} and laeuft_ab_at > now()
    returning id`
  return rows.length > 0
}

export interface VertrautesGeraet {
  id: string
  bezeichnung: string
  erstellt_at: string
  laeuft_ab_at: string
  zuletzt_at: string | null
}

export async function geraeteAuflisten(db: Db, userId: string): Promise<VertrautesGeraet[]> {
  return db<VertrautesGeraet[]>`
    select id, bezeichnung, erstellt_at, laeuft_ab_at, zuletzt_at
    from vertraute_geraete
    where user_id = ${userId} and laeuft_ab_at > now()
    order by coalesce(zuletzt_at, erstellt_at) desc`
}

export async function geraetWiderrufen(db: Db, userId: string, geraetId: string): Promise<boolean> {
  const rows = await db`
    delete from vertraute_geraete where user_id = ${userId} and id = ${geraetId} returning id`
  return rows.length > 0
}

/** Housekeeping: abgelaufene Geräte interessieren niemanden mehr. */
export async function geraeteAufraeumen(db: Db): Promise<number> {
  const rows = await db`delete from vertraute_geraete where laeuft_ab_at < now() returning id`
  return rows.length
}

/**
 * „Chrome · Windows" aus dem User-Agent — grob, aber genug, damit der
 * Benutzer sein Gerät in der Liste wiedererkennt. Kein Fingerabdruck.
 */
export function geraetBezeichnung(userAgent: string | null | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unbekanntes System'
  return `${browser} · ${system}`
}
