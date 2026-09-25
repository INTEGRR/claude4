import type { Sql, TransactionSql } from 'postgres'
import { einreihen, textDienst } from './benachrichtigungen.ts'

/**
 * Dienste-Wächter (Migration 0085): aktive Sonden gegen jeden konfigurierten
 * Dienst, Zustand in dienst_status, Störung/Entstörung als Meldung über die
 * Benachrichtigungs-Outbox.
 *
 * Bewusst datenbankfrei aufrufbar: Client und Sonden kommen als Parameter,
 * damit Schwelle, Flattern, Meldeschlüssel und Zeitlimit unter withRollback
 * testbar sind. Die echten Sonden (DHL, Shopify, …) stehen in
 * wache-sonden.ts, weil sie die App-Clients ziehen.
 */

type Db = Sql | TransactionSql

export type Dienst = 'dhl' | 'shopify' | 'mail' | 'ki' | 'sprache' | 'druckbruecke' | 'telegram'

export const DIENST_LABELS: Record<Dienst, string> = {
  dhl: 'DHL Parcel DE',
  shopify: 'Shopify',
  mail: 'E-Mail (Resend)',
  ki: 'KI (Anthropic)',
  sprache: 'Sprache (OpenAI)',
  druckbruecke: 'Druckbrücke',
  telegram: 'Telegram',
}

export interface Sonde {
  dienst: Dienst
  /** Nicht konfigurierte Dienste werden nicht geprüft und nie gemeldet. */
  konfiguriert: boolean
  /** Wirft bei Störung; löst auf, wenn der Dienst antwortet. */
  pruefen: () => Promise<void>
}

export const SONDEN_ZEITLIMIT_MS = 8000
/** Störung erst beim zweiten Fehlschlag in Folge — ein einzelner Aussetzer flattert nicht. */
export const STOERUNG_AB_FEHLSCHLAEGEN = 2

export type DienstZustand = 'ok' | 'gestoert' | 'unbekannt'

export interface DienstStatus {
  dienst: Dienst
  status: DienstZustand
  fehler: string | null
  seit: string | null
  geprueft_at: string | null
  fehlversuche: number
  dauer_ms: number | null
}

export function mitZeitlimit<T>(p: Promise<T>, ms = SONDEN_ZEITLIMIT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`keine Antwort in ${ms / 1000} s`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export interface WacheErgebnis {
  dienst: Dienst
  status: DienstZustand
  fehler: string | null
  dauerMs: number
}

/** Ein Lauf: alle Sonden parallel, dann je Dienst Zustand fortschreiben und melden. */
export async function wacheLaufen(
  db: Db,
  sonden: Sonde[],
  opts: { zeitlimitMs?: number } = {},
): Promise<{ ergebnisse: WacheErgebnis[]; gemeldet: number }> {
  const zeitlimit = opts.zeitlimitMs ?? SONDEN_ZEITLIMIT_MS
  const laeufe = await Promise.allSettled(
    sonden.map(async (s) => {
      const start = Date.now()
      if (!s.konfiguriert) return { sonde: s, ok: true, fehler: null, dauerMs: 0, unbekannt: true }
      try {
        await mitZeitlimit(s.pruefen(), zeitlimit)
        return { sonde: s, ok: true, fehler: null, dauerMs: Date.now() - start, unbekannt: false }
      } catch (err) {
        const fehler = (err instanceof Error ? err.message : String(err)).slice(0, 500)
        return { sonde: s, ok: false, fehler, dauerMs: Date.now() - start, unbekannt: false }
      }
    }),
  )

  const ergebnisse: WacheErgebnis[] = []
  let gemeldet = 0
  for (const lauf of laeufe) {
    if (lauf.status !== 'fulfilled') continue
    const { sonde, ok, fehler, dauerMs, unbekannt } = lauf.value
    const [vorher] = await db<DienstStatus[]>`
      select dienst, status, fehler, seit, geprueft_at, fehlversuche, dauer_ms
      from dienst_status where dienst = ${sonde.dienst}`

    if (unbekannt) {
      await db`
        insert into dienst_status (dienst, status, fehler, seit, geprueft_at, fehlversuche, dauer_ms)
        values (${sonde.dienst}, 'unbekannt', null, null, now(), 0, null)
        on conflict (dienst) do update
          set status = 'unbekannt', fehler = null, seit = null, geprueft_at = now(),
              fehlversuche = 0, dauer_ms = null`
      ergebnisse.push({ dienst: sonde.dienst, status: 'unbekannt', fehler: null, dauerMs: 0 })
      continue
    }

    if (ok) {
      if (vorher?.status === 'gestoert' && vorher.seit) {
        const dauerMinuten = Math.max(0, Math.round((Date.now() - new Date(vorher.seit).getTime()) / 60_000))
        const id = await einreihen(
          db,
          'dienst',
          `dienst:${sonde.dienst}:ok:${new Date(vorher.seit).toISOString()}`,
          textDienst({
            dienst: sonde.dienst,
            label: DIENST_LABELS[sonde.dienst],
            zustand: 'ok',
            seit: vorher.seit,
            dauerMinuten,
          }),
        )
        if (id) gemeldet++
      }
      // „seit" bleibt stehen, solange der Zustand ok bleibt.
      await db`
        insert into dienst_status (dienst, status, fehler, seit, geprueft_at, fehlversuche, dauer_ms)
        values (${sonde.dienst}, 'ok', null, now(), now(), 0, ${dauerMs})
        on conflict (dienst) do update
          set status = 'ok', fehler = null,
              seit = case when dienst_status.status = 'ok' then dienst_status.seit else now() end,
              geprueft_at = now(), fehlversuche = 0, dauer_ms = excluded.dauer_ms`
      ergebnisse.push({ dienst: sonde.dienst, status: 'ok', fehler: null, dauerMs })
      continue
    }

    const fehlversuche = (vorher?.fehlversuche ?? 0) + 1
    const schonGestoert = vorher?.status === 'gestoert'
    const wirdGestoert = !schonGestoert && fehlversuche >= STOERUNG_AB_FEHLSCHLAEGEN
    const status: DienstZustand = schonGestoert || wirdGestoert ? 'gestoert' : (vorher?.status ?? 'unbekannt')
    await db`
      insert into dienst_status (dienst, status, fehler, seit, geprueft_at, fehlversuche, dauer_ms)
      values (${sonde.dienst}, ${status}, ${fehler}, ${wirdGestoert ? db`now()` : (vorher?.seit ?? null)},
              now(), ${fehlversuche}, ${dauerMs})
      on conflict (dienst) do update
        set status = excluded.status, fehler = excluded.fehler,
            seit = case when ${wirdGestoert} then now() else dienst_status.seit end,
            geprueft_at = now(), fehlversuche = excluded.fehlversuche, dauer_ms = excluded.dauer_ms`
    if (wirdGestoert) {
      const [neu] = await db<{ seit: string }[]>`select seit from dienst_status where dienst = ${sonde.dienst}`
      const id = await einreihen(
        db,
        'dienst',
        `dienst:${sonde.dienst}:gestoert:${new Date(neu.seit).toISOString()}`,
        textDienst({
          dienst: sonde.dienst,
          label: DIENST_LABELS[sonde.dienst],
          zustand: 'gestoert',
          seit: neu.seit,
          fehler,
        }),
      )
      if (id) gemeldet++
    }
    ergebnisse.push({ dienst: sonde.dienst, status, fehler, dauerMs })
  }
  return { ergebnisse, gemeldet }
}

export async function dienstStatusLesen(db: Db): Promise<DienstStatus[]> {
  return db<DienstStatus[]>`
    select dienst, status, fehler, seit, geprueft_at, fehlversuche, dauer_ms
    from dienst_status order by dienst`
}

export async function gestoerteDienste(db: Db): Promise<Dienst[]> {
  const rows = await db<{ dienst: Dienst }[]>`
    select dienst from dienst_status where status = 'gestoert' order by dienst`
  return rows.map((r) => r.dienst)
}

/**
 * Datenbank selbst nicht erreichbar: dann gibt es keine Outbox und keinen
 * Zustand — Direktversand, aber nur im ersten Fünf-Minuten-Fenster jeder
 * Viertelstunde (≤ 4 Meldungen je Stunde, erste nach spätestens 15 Minuten).
 */
export function datenbankAusfallFaellig(jetzt = new Date()): boolean {
  return jetzt.getMinutes() % 15 < 5
}
