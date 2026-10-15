import type { Sql, TransactionSql } from 'postgres'
import { type Kontingent, kontingentLesen } from './track17'

type Db = Sql | TransactionSql

/**
 * Kontingent schonen (0113, Entscheidungslog 2026-10-15): 17TRACK zählt
 * angemeldete Sendungen — 200 im Jahr für den Betreiber. Darum:
 *
 *  - settings 'track17' { automatisch, reserve }: Standard ist „von Hand"
 *    (jede Sendungsnummer wird nur vorgemerkt, angemeldet per „Verfolgen");
 *    automatisch meldet jede Nummer an, solange mehr als `reserve` frei ist.
 *  - settings 'track17_kontingent': der zuletzt gelesene Kontingentstand
 *    (nach jeder Anmeldung und vom Wächter) — Seiten zeigen ihn, ohne
 *    17TRACK je Seitenansicht zu fragen.
 */

export const TRACK17_EINSTELLUNG = 'track17'
export const TRACK17_KONTINGENT = 'track17_kontingent'

export interface Track17Einstellung {
  /** Jede Sendungsnummer sofort anmelden (kostet je Sendung Kontingent). */
  automatisch: boolean
  /** Unter dieser Restmenge meldet KRNL nicht mehr automatisch an — nur noch von Hand. */
  reserve: number
}

export const TRACK17_VORGABE: Track17Einstellung = { automatisch: false, reserve: 20 }

export interface KontingentStand {
  total: number
  used: number
  remain: number
  today: number
  /** Zeitpunkt des Lesens (ISO). */
  am: string
}

export async function track17Einstellung(db: Db): Promise<Track17Einstellung> {
  const [row] = await db<{ value: Partial<Track17Einstellung> | null }[]>`
    select value from settings where key = ${TRACK17_EINSTELLUNG}`
  const v = row?.value ?? {}
  return {
    automatisch: v.automatisch === true,
    reserve: Number.isFinite(Number(v.reserve)) ? Math.max(0, Number(v.reserve)) : TRACK17_VORGABE.reserve,
  }
}

export async function kontingentStandLesen(db: Db): Promise<KontingentStand | null> {
  const [row] = await db<{ value: KontingentStand | null }[]>`
    select value from settings where key = ${TRACK17_KONTINGENT}`
  return row?.value && typeof row.value.remain === 'number' ? row.value : null
}

/** Kontingent bei 17TRACK lesen und merken — ein Aufruf, danach lesen alle Seiten den Stand. */
export async function kontingentMerken(db: Db): Promise<KontingentStand> {
  const k: Kontingent = await kontingentLesen()
  const stand: KontingentStand = {
    total: k.quota_total,
    used: k.quota_used,
    remain: k.quota_remain,
    today: k.today_used,
    am: new Date().toISOString(),
  }
  await db`
    insert into settings (key, value) values (${TRACK17_KONTINGENT}, ${db.json(stand as never)})
    on conflict (key) do update set value = excluded.value`
  return stand
}

/** Gemerkter Stand, höchstens eine Stunde alt — sonst frisch lesen (best effort). */
export async function kontingentStand(db: Db): Promise<KontingentStand | null> {
  const alt = await kontingentStandLesen(db)
  if (alt && Date.now() - new Date(alt.am).getTime() < 60 * 60_000) return alt
  try {
    return await kontingentMerken(db)
  } catch {
    return alt
  }
}

/**
 * Darf eine neue Sendungsnummer automatisch angemeldet werden? Nur mit
 * eingeschalteter Automatik und solange mehr als die Reserve frei ist
 * (unbekannter Stand zählt als frei — der Wächter liest ihn stündlich).
 */
export async function automatischAnmelden(db: Db): Promise<boolean> {
  const e = await track17Einstellung(db)
  if (!e.automatisch) return false
  const stand = await kontingentStandLesen(db)
  return stand === null || stand.remain > e.reserve
}

/** „noch 199 von 200 frei (Stand 12:05)" — für Panel und Knopf. */
export function kontingentText(stand: KontingentStand | null): string {
  if (!stand) return 'Kontingentstand unbekannt'
  return `noch ${stand.remain} von ${stand.total} frei`
}
