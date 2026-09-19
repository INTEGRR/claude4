import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'

/**
 * Login-Drossel: Fehlversuche je Konto und Absender, pseudonym gespeichert.
 *
 * Bewusst datenbankfrei aufrufbar (Client als Parameter, keine '@/'-Importe),
 * damit die Regeln unter withRollback testbar sind und die Anmeldung selbst
 * (auth/index.ts) nur noch drei Aufrufe braucht: gesperrt? → merken → löschen.
 *
 * Es wird weder E-Mail noch IP im Klartext gespeichert — nur ein Hash mit
 * SESSION_SECRET als Salz. Der Hash dient allein dem Zählen; zurückrechnen
 * lässt er sich nicht. Entscheidungslog 2026-09-18.
 */

type Db = Sql | TransactionSql

export const FENSTER_MINUTEN = 15
/** Fehlversuche je Konto im Fenster, ab denen die Anmeldung gesperrt ist. */
export const MAX_JE_KONTO = 5
/** Fehlversuche je Absender im Fenster — fängt das Durchprobieren vieler Konten. */
export const MAX_JE_ABSENDER = 30

/** Pseudonym für Konto oder Absender — nur zum Zählen, nicht rückrechenbar. */
export function kennungHash(wert: string, salz = process.env.SESSION_SECRET ?? 'krnl'): string {
  return createHash('sha256').update(`${salz}:${wert.trim().toLowerCase()}`).digest('hex').slice(0, 32)
}

/**
 * Absender-Pseudonym eines HTTP-Aufrufs (x-forwarded-for / x-real-ip) — für
 * Eingänge ohne Sitzung (Registrierung, Reparaturanfrage). Null, wenn keine
 * Adresse bekannt ist; dann wird nicht gedrosselt, aber auch nichts
 * Falsches gezählt.
 */
export function absenderHashAusRequest(request: Request): string | null {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')
  return ip ? kennungHash(ip) : null
}

export async function loginGesperrt(
  db: Db,
  kontoHash: string,
  absenderHash: string | null,
): Promise<boolean> {
  const [zaehler] = await db<{ konto: number; absender: number }[]>`
    select
      count(*) filter (where konto_hash = ${kontoHash})::int as konto,
      count(*) filter (where absender_hash = ${absenderHash})::int as absender
    from login_versuche
    where created_at > now() - (${FENSTER_MINUTEN} || ' minutes')::interval`
  return zaehler.konto >= MAX_JE_KONTO || (absenderHash !== null && zaehler.absender >= MAX_JE_ABSENDER)
}

export async function fehlversuchMerken(
  db: Db,
  kontoHash: string,
  absenderHash: string | null,
): Promise<void> {
  await db`insert into login_versuche (konto_hash, absender_hash) values (${kontoHash}, ${absenderHash})`
}

/** Nach erfolgreicher Anmeldung: das Konto beginnt wieder bei null. */
export async function fehlversucheLoeschen(db: Db, kontoHash: string): Promise<void> {
  await db`delete from login_versuche where konto_hash = ${kontoHash}`
}

/** Housekeeping: Einträge außerhalb des Fensters interessieren niemanden mehr. */
export async function loginVersucheAufraeumen(db: Db): Promise<number> {
  const rows = await db`
    delete from login_versuche where created_at < now() - interval '1 day' returning id`
  return rows.length
}
