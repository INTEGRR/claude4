import type { Sql, TransactionSql } from 'postgres'
import { telegramSicher } from './telegram.ts'

/**
 * Benachrichtigungs-Outbox (Migration 0084): Ereignisse mit natürlichem
 * Schlüssel, gesendet vom Cron `jobs`. Bewusst datenbankfrei aufrufbar
 * (Client und Sendefunktion als Parameter, keine '@/'-Importe), damit
 * Bündelung, Schalter, Backoff und Texte unter withRollback testbar sind.
 * Die Verdrahtung mit Telegram lebt in benachrichtigungen-versand.ts.
 */

type Db = Sql | TransactionSql

export type BenachrichtigungsArt = 'login' | 'fehlversuch' | 'sperre' | 'job' | 'dienst' | 'test'

export interface Schalter {
  logins: boolean
  fehlversuche: boolean
  jobs: boolean
  dienste: boolean
}
export const SCHALTER_STANDARD: Schalter = { logins: true, fehlversuche: true, jobs: true, dienste: true }
export const SCHALTER_LABELS: Record<keyof Schalter, string> = {
  logins: 'Jede erfolgreiche Anmeldung (wer, wann, IP, Gerät, Methode)',
  fehlversuche: 'Fehlversuche und Kontosperren (gebündelt je Konto und Viertelstunde)',
  jobs: 'Endgültig fehlgeschlagene Jobs der Outbox',
  dienste: 'Störungen und Entstörungen externer Dienste (Dienste-Wächter)',
}

/** Fehlversuche desselben Kontos werden je Viertelstunde zu einer Nachricht. */
export const FEHLVERSUCH_BUCKET_MINUTEN = 15
/** … und warten zwei Minuten, damit der Schwall einen Endstand hat. */
export const FEHLVERSUCH_VERZOEGERUNG_MINUTEN = 2
export const MAX_VERSUCHE = 5
const BACKOFF_MINUTEN = [1, 5, 15, 60, 180]
export const AUFBEWAHRUNG_TAGE = 30

// --- Einstellung ------------------------------------------------------------

/** settings.benachrichtigungen — fehlende Schalter gelten als an. */
export async function schalter(db: Db): Promise<Schalter> {
  const [row] = await db<{ value: Partial<Record<keyof Schalter, unknown>> | null }[]>`
    select value from settings where key = 'benachrichtigungen'`
  const v = row?.value ?? {}
  return {
    logins: v.logins !== false,
    fehlversuche: v.fehlversuche !== false,
    jobs: v.jobs !== false,
    dienste: v.dienste !== false,
  }
}

export function artErlaubt(art: BenachrichtigungsArt, s: Schalter): boolean {
  switch (art) {
    case 'login':
      return s.logins
    case 'fehlversuch':
    case 'sperre':
      return s.fehlversuche
    case 'job':
      return s.jobs
    case 'dienst':
      return s.dienste
    default:
      return true
  }
}

// --- Einreihen --------------------------------------------------------------

/** Zeitfenster-Nummer für Schlüssel: gleiche Viertelstunde = gleicher Bucket. */
export function zeitBucket(ms = Date.now(), minuten = FEHLVERSUCH_BUCKET_MINUTEN): string {
  return String(Math.floor(ms / (minuten * 60_000)))
}

/**
 * Reiht ein Ereignis ein. Gleicher Schlüssel und noch offen → Text und Frist
 * erneuert (liefert die Zeilen-ID); schon gesendet → null, nichts passiert.
 */
export async function einreihen(
  db: Db,
  art: BenachrichtigungsArt,
  schluessel: string,
  text: string,
  nichtVor: Date | null = null,
): Promise<string | null> {
  // Ohne Frist entscheidet die Datenbankuhr (now()), nicht die des Aufrufers —
  // in einer Transaktion ist now() der Transaktionsbeginn, und ein späterer
  // JS-Zeitstempel wäre dort „noch nicht fällig".
  const [row] = await db<{ id: string | null }[]>`
    select benachrichtigung_einreihen(${art}, ${schluessel}, ${text},
                                      coalesce(${nichtVor}::timestamptz, now())) as id`
  return row?.id ?? null
}

// --- Texte (HTML-Parse-Modus, Nutzertext maskiert) --------------------------

const ZEIT = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function zeitFormat(wert: Date | string | number = new Date()): string {
  return ZEIT.format(wert instanceof Date ? wert : new Date(wert)).replace(', ', ' ')
}

export function textLogin(p: {
  name: string
  rolle: string
  ip: string | null
  geraet: string
  methode: string
  zeit?: Date
}): string {
  return (
    `🔓 <b>Anmeldung</b> ${telegramSicher(p.name)} (${telegramSicher(p.rolle)})\n` +
    `${zeitFormat(p.zeit)} · IP ${telegramSicher(p.ip ?? 'unbekannt')} · ${telegramSicher(p.geraet)}\n` +
    `${telegramSicher(p.methode)}`
  )
}

export function textFehlversuche(p: {
  konto: string
  anzahl: number
  ip: string | null
  art: 'Passwort' | 'Code'
  zeit?: Date
}): string {
  return (
    `⚠️ <b>${p.anzahl} Fehlversuch${p.anzahl === 1 ? '' : 'e'}</b> für ${telegramSicher(p.konto)} ` +
    `(letzte ${FEHLVERSUCH_BUCKET_MINUTEN} min)\n` +
    `zuletzt ${zeitFormat(p.zeit)} · IP ${telegramSicher(p.ip ?? 'unbekannt')} · ${p.art} falsch`
  )
}

export function textSperre(p: { konto: string; ip: string | null; minuten: number; zeit?: Date }): string {
  return (
    `⛔ <b>Konto gesperrt</b> ${telegramSicher(p.konto)} — ${p.minuten} Minuten nach zu vielen Fehlversuchen\n` +
    `${zeitFormat(p.zeit)} · IP ${telegramSicher(p.ip ?? 'unbekannt')}`
  )
}

export function textJob(p: { kind: string; versuche: number; max: number; fehler: string | null }): string {
  return (
    `❌ <b>Job endgültig fehlgeschlagen</b> ${telegramSicher(p.kind)} (Versuch ${p.versuche}/${p.max})\n` +
    `${telegramSicher((p.fehler ?? 'ohne Fehlertext').slice(0, 500))}\n` +
    'Neu einreihen: Integrationen → Jobs'
  )
}

export function textDienst(p: {
  dienst: string
  label: string
  zustand: 'gestoert' | 'ok'
  seit: Date | string
  fehler?: string | null
  dauerMinuten?: number
}): string {
  if (p.zustand === 'gestoert') {
    return (
      `🔴 <b>${telegramSicher(p.label)} nicht erreichbar</b> seit ${zeitFormat(p.seit)}\n` +
      `${telegramSicher((p.fehler ?? 'ohne Fehlertext').slice(0, 400))}`
    )
  }
  return `🟢 <b>${telegramSicher(p.label)} wieder erreichbar</b> — Störung ${p.dauerMinuten ?? 0} min (seit ${zeitFormat(p.seit)})`
}

export function textTest(): string {
  return `✅ <b>Testnachricht</b> — Telegram ist verbunden. ${zeitFormat()}`
}

// --- Versand ----------------------------------------------------------------

export interface SendeErgebnis {
  ok: boolean
  status: number | null
  fehler: string | null
  fake: boolean
  dauerMs: number
}

export interface VersandBilanz {
  gesendet: number
  uebersprungen: number
  fehlgeschlagen: number
  /** Nach diesem Lauf noch offen (inkl. wartender Fristen). */
  offen: number
}

/**
 * Sendet fällige Zeilen. Schalter und Konfiguration gelten BEIM SENDEN
 * (eine Stelle, rückwirkend): abgeschaltete Arten und ein unkonfigurierter
 * Kanal enden als „übersprungen", Sendefehler mit Backoff bis MAX_VERSUCHE.
 */
export async function benachrichtigungenSenden(
  db: Db,
  opts: {
    senden: (text: string) => Promise<SendeErgebnis>
    konfiguriert: boolean
    /** Kopfzeile jeder Nachricht, z. B. „KRNL · Firma". */
    prefix?: string
    limit?: number
  },
): Promise<VersandBilanz> {
  const rows = await db<{ id: string; art: BenachrichtigungsArt; text: string; versuche: number }[]>`
    update benachrichtigungen set versuche = versuche + 1
    where id in (
      select id from benachrichtigungen
      where status = 'offen' and nicht_vor <= now()
      order by erstellt_at
      limit ${opts.limit ?? 20}
      for update skip locked)
    returning id, art, text, versuche`
  const s = await schalter(db)
  const bilanz: VersandBilanz = { gesendet: 0, uebersprungen: 0, fehlgeschlagen: 0, offen: 0 }

  for (const row of rows) {
    if (!artErlaubt(row.art, s)) {
      await db`update benachrichtigungen set status = 'uebersprungen',
               fehler = 'abgeschaltet (Einstellungen → Benachrichtigungen)' where id = ${row.id}`
      bilanz.uebersprungen++
      continue
    }
    if (!opts.konfiguriert) {
      await db`update benachrichtigungen set status = 'uebersprungen',
               fehler = 'Telegram nicht konfiguriert (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)' where id = ${row.id}`
      bilanz.uebersprungen++
      continue
    }
    const r = await opts.senden(`${opts.prefix ?? ''}${row.text}`)
    await db`
      insert into api_transactions (system, kind, reference, request, ok, status_code, error, duration_ms)
      values ('telegram', ${r.fake ? 'fake:send' : 'send'}, ${row.art},
              ${db.json({ schluessel_id: row.id, zeichen: row.text.length })},
              ${r.ok}, ${r.status}, ${r.fehler}, ${r.dauerMs})`
    if (r.ok) {
      await db`update benachrichtigungen set status = 'gesendet', gesendet_at = now(), fehler = null
               where id = ${row.id}`
      bilanz.gesendet++
      continue
    }
    if (row.versuche >= MAX_VERSUCHE) {
      await db`update benachrichtigungen set status = 'fehlgeschlagen', fehler = ${r.fehler} where id = ${row.id}`
      bilanz.fehlgeschlagen++
    } else {
      const minuten = BACKOFF_MINUTEN[Math.min(row.versuche - 1, BACKOFF_MINUTEN.length - 1)]
      await db`update benachrichtigungen
               set fehler = ${r.fehler}, nicht_vor = now() + make_interval(mins => ${minuten})
               where id = ${row.id}`
    }
  }

  const [rest] = await db<{ n: number }[]>`
    select count(*)::int as n from benachrichtigungen where status = 'offen'`
  bilanz.offen = Number(rest?.n ?? 0)
  return bilanz
}

/** Endgültig fehlgeschlagene Jobs der letzten Minuten melden — jeder genau einmal. */
export async function fehlgeschlageneJobsMelden(db: Db): Promise<number> {
  const jobs = await db<{ id: string; kind: string; attempts: number; max_attempts: number; last_error: string | null }[]>`
    select j.id, j.kind, j.attempts, j.max_attempts, j.last_error
    from integration_jobs j
    where j.status = 'failed'
      and coalesce(j.updated_at, j.created_at) > now() - interval '30 minutes'
      and not exists (
        select 1 from benachrichtigungen b
        where b.schluessel = 'job:' || j.id || ':' || j.attempts)`
  for (const j of jobs) {
    await einreihen(db, 'job', `job:${j.id}:${j.attempts}`,
      textJob({ kind: j.kind, versuche: j.attempts, max: j.max_attempts, fehler: j.last_error }))
  }
  return jobs.length
}

export interface Benachrichtigung {
  id: string
  art: BenachrichtigungsArt
  text: string
  status: string
  versuche: number
  fehler: string | null
  erstellt_at: string
  gesendet_at: string | null
}

export async function letzteBenachrichtigungen(db: Db, limit = 10): Promise<Benachrichtigung[]> {
  return db<Benachrichtigung[]>`
    select id, art, text, status, versuche, fehler, erstellt_at, gesendet_at
    from benachrichtigungen order by erstellt_at desc limit ${limit}`
}

/** Housekeeping: nach 30 Tagen interessiert keine Meldung mehr. */
export async function benachrichtigungenAufraeumen(db: Db): Promise<number> {
  const rows = await db`
    delete from benachrichtigungen
    where erstellt_at < now() - make_interval(days => ${AUFBEWAHRUNG_TAGE}) returning id`
  return rows.length
}
