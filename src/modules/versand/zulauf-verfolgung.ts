import type { Sql, TransactionSql } from 'postgres'
import { sql } from '@/db/client'
import type { AktionsErgebnis } from '@/modules/prozesse/registry/typen'
import {
  ABRUF_ABSTAND_STUNDEN,
  BEREITS_ANGEMELDET,
  type Ereignis,
  STAPEL_MAX,
  type Track17Eintrag,
  type VerfolgungStatus,
  carrierCode,
  registrierungWiederholen,
  registrierungsFehlerText,
  standText,
  trackStandLesen,
  verfolgungAktiv,
} from './track17-logik'
import { type Abgelehnt, type Angemeldet, Track17Error, nummernAnmelden, staendeAbfragen, track17Konfiguriert } from './track17'

type Db = Sql | TransactionSql

/**
 * Zulauf-Sendungsverfolgung (0112, Entscheidungslog 2026-10-15): der Ablauf
 * um die Tabelle `sendungsverfolgung`.
 *
 *  - Beleg bekommt eine Sendungsnummer (Bestellung: tracking_number,
 *    Eingangssendung: hbl_awb) → `verfolgungAnmelden` legt die Zeile an und
 *    reiht den Job `track17_registrieren` ein (Outbox: Retry, Monitor).
 *  - Der Job meldet die Nummer bei 17TRACK an und holt gleich den ersten
 *    Stand; abgelehnte Nummern stehen als „nicht verfolgbar" mit Grund.
 *  - Statuswechsel kommen per Webhook (`webhookVerarbeiten`); stündlich
 *    fragt der Cron nach (`verfolgungAbrufen`, je Sendung höchstens alle
 *    sechs Stunden) — das Sicherheitsnetz, falls ein Push ausbleibt.
 *  - „Jetzt abfragen" an Bestellung und Eingangssendung ist eine
 *    Registry-Aktion (`verfolgungJetztAbfragen`).
 *
 * Jede Änderung steht im Protokoll des Belegs; „zuletzt abgefragt" (wann,
 * wie) steht an der Zeile — die Frage „wurde das überhaupt geprüft?" hat
 * damit immer eine sichtbare Antwort.
 */

export type VerfolgungModell = 'purchase_order' | 'eingangs_sendung'

export interface Verfolgung {
  id: string
  modell: VerfolgungModell
  record_id: string
  nummer: string
  carrier_code: number | null
  carrier: string | null
  status: VerfolgungStatus
  status_quelle: string | null
  sub_status: string | null
  letztes_ereignis: Ereignis | null
  ereignisse: Ereignis[]
  registriert_am: string | null
  registrierung_fehler: string | null
  zuletzt_abgefragt_am: string | null
  zuletzt_abgefragt_via: 'registrierung' | 'abruf' | 'webhook' | 'manuell' | null
  zuletzt_geaendert_am: string | null
  zugestellt_am: string | null
  aktiv: boolean
}

// Als Funktion, nicht als Konstante: ein Fragment am Modulrand würde den
// App-Client schon beim Import binden — vor der Umleitung der Prozesstests.
const spalten = (db: Db) => db`id, modell, record_id, nummer, carrier_code, carrier, status, status_quelle, sub_status,
  letztes_ereignis, ereignisse, registriert_am, registrierung_fehler, zuletzt_abgefragt_am, zuletzt_abgefragt_via,
  zuletzt_geaendert_am, zugestellt_am, aktiv`

/** Sendungsnummern kommen mit Leerzeichen aus Mails und Belegen — gespeichert wird kompakt. */
export function nummerNormieren(nummer: string | null | undefined): string {
  return (nummer ?? '').replace(/\s+/g, '').trim()
}

/** Die Verfolgung(en) eines Belegs — aktive zuerst, jüngste zuerst. */
export async function verfolgungLesen(db: Db, modell: VerfolgungModell, recordId: string): Promise<Verfolgung[]> {
  return db<Verfolgung[]>`
    select ${spalten(db)} from sendungsverfolgung
    where modell = ${modell} and record_id = ${recordId}
    order by aktiv desc, created_at desc`
}

/**
 * Sendungsnummer am Beleg gesetzt/geändert: Zeile anlegen (oder reaktivieren),
 * ältere Nummern desselben Belegs stilllegen, Anmeldung einreihen. Ohne
 * Nummer werden alle Verfolgungen des Belegs stillgelegt. Läuft in der
 * Transaktion des Belegs — der Job startet erst nach dem Commit.
 */
export async function verfolgungAnmelden(
  db: Db,
  modell: VerfolgungModell,
  recordId: string,
  nummerRoh: string | null | undefined,
  carrierText: string | null | undefined,
  actor: string,
): Promise<Verfolgung | null> {
  const nummer = nummerNormieren(nummerRoh)
  await db`update sendungsverfolgung set aktiv = false
           where modell = ${modell} and record_id = ${recordId} and aktiv and nummer <> ${nummer}`
  if (!nummer) return null

  const konfiguriert = track17Konfiguriert()
  const [row] = await db<Verfolgung[]>`
    insert into sendungsverfolgung (modell, record_id, nummer, carrier_code, carrier, status, registrierung_fehler, aktiv, erstellt_von)
    values (${modell}, ${recordId}, ${nummer}, ${carrierCode(carrierText)}, ${carrierText?.trim() || null},
            ${konfiguriert ? 'registriert' : 'nicht_verfolgbar'},
            ${konfiguriert ? null : '17TRACK nicht angebunden (TRACK17_API_KEY) — Einstellungen → Schnittstellen'},
            ${konfiguriert}, ${actor})
    on conflict (modell, record_id, nummer) do update set
      carrier_code = coalesce(sendungsverfolgung.carrier_code, excluded.carrier_code),
      carrier = coalesce(sendungsverfolgung.carrier, excluded.carrier),
      -- Eine früher nicht verfolgbare Nummer (Dienst war nicht angebunden,
      -- Carrier fehlte) bekommt mit der erneuten Pflege eine neue Chance.
      status = case when sendungsverfolgung.status = 'nicht_verfolgbar' and ${konfiguriert}
                    then 'registriert' else sendungsverfolgung.status end,
      registrierung_fehler = case when sendungsverfolgung.status = 'nicht_verfolgbar' and ${konfiguriert}
                                  then null else sendungsverfolgung.registrierung_fehler end,
      aktiv = sendungsverfolgung.status not in ('zugestellt', 'abgelaufen')
              and (sendungsverfolgung.status <> 'nicht_verfolgbar' or ${konfiguriert})
    returning ${spalten(db)}`

  if (row.aktiv && !row.registriert_am) {
    await db`select enqueue_job('track17_registrieren', ${db.json({ verfolgung_id: row.id })}, ${`track17:${row.id}`})`
  }
  return row
}

function protokollArt(status: VerfolgungStatus): 'state' | 'info' | 'error' {
  if (status === 'zugestellt') return 'state'
  if (status === 'problem' || status === 'zustellung_fehlgeschlagen' || status === 'abgelaufen') return 'error'
  return 'info'
}

function bezeichnung(v: Pick<Verfolgung, 'carrier' | 'nummer'>): string {
  return [v.carrier, v.nummer].filter(Boolean).join(' ')
}

/** Übernimmt eine 17TRACK-Antwort in die Zeile; protokolliert Änderungen am Beleg. */
export async function standUebernehmen(
  db: Db,
  v: Verfolgung,
  eintrag: Track17Eintrag,
  via: Verfolgung['zuletzt_abgefragt_via'],
): Promise<{ geaendert: boolean; text: string }> {
  const stand = trackStandLesen(eintrag)
  const alt = v.letztes_ereignis
  const neu = stand.letztesEreignis
  const geaendert =
    stand.status !== v.status ||
    (stand.subStatus ?? null) !== (v.sub_status ?? null) ||
    (alt?.zeit ?? null) !== (neu?.zeit ?? null) ||
    (alt?.text ?? null) !== (neu?.text ?? null)
  const aktiv = verfolgungAktiv(stand.status)

  await db`
    update sendungsverfolgung set
      status = ${stand.status},
      status_quelle = ${stand.statusQuelle},
      sub_status = ${stand.subStatus},
      carrier_code = coalesce(${stand.carrierCode}, carrier_code),
      carrier = coalesce(${stand.carrierName}, carrier),
      letztes_ereignis = ${neu ? db.json(neu as never) : null},
      ereignisse = ${db.json(stand.ereignisse as never)},
      zuletzt_abgefragt_am = now(),
      zuletzt_abgefragt_via = ${via},
      zuletzt_geaendert_am = case when ${geaendert} then now() else zuletzt_geaendert_am end,
      zugestellt_am = case when ${stand.status === 'zugestellt'}
                           then coalesce(zugestellt_am, ${neu?.zeit ?? null}::timestamptz, now())
                           else zugestellt_am end,
      aktiv = ${aktiv}
    where id = ${v.id}`

  const text = standText(stand)
  if (geaendert) {
    const name = bezeichnung({ carrier: stand.carrierName ?? v.carrier, nummer: v.nummer })
    await db`select log_event(${v.modell}, ${v.record_id}, ${protokollArt(stand.status)},
      ${`Sendung ${name}: ${text}`}, 'track17')`
  }
  return { geaendert, text }
}

interface Anmeldung {
  text: string
  /** angemeldet = jetzt angemeldet (mit erstem Stand); schon = ein anderer war schneller. */
  ergebnis: 'angemeldet' | 'schon' | 'inaktiv' | 'nicht_verfolgbar' | 'weg'
}

/**
 * Anmeldung mit Beanspruchung: `registriert_am` wird ZUERST gesetzt (nur
 * wenn noch leer) — Outbox-Job und „Jetzt abfragen" können parallel laufen,
 * angemeldet wird trotzdem nur einmal. Scheitert der Aufruf, fällt die
 * Beanspruchung zurück.
 */
async function anmelden(v: Verfolgung): Promise<Anmeldung> {
  if (!v.aktiv) return { text: `${v.nummer}: nicht mehr aktiv`, ergebnis: 'inaktiv' }
  if (!track17Konfiguriert()) {
    await sql`update sendungsverfolgung set status = 'nicht_verfolgbar', aktiv = false,
      registrierung_fehler = '17TRACK nicht angebunden (TRACK17_API_KEY) — Einstellungen → Schnittstellen'
      where id = ${v.id}`
    return { text: `${v.nummer}: 17TRACK nicht angebunden`, ergebnis: 'nicht_verfolgbar' }
  }
  const [beansprucht] = await sql<{ id: string }[]>`
    update sendungsverfolgung set registriert_am = now()
    where id = ${v.id} and registriert_am is null returning id`
  if (!beansprucht) return { text: `${v.nummer}: bereits angemeldet`, ergebnis: 'schon' }

  let angemeldet: Angemeldet[]
  let abgelehnt: Abgelehnt[]
  try {
    ;({ angemeldet, abgelehnt } = await nummernAnmelden([
      { nummer: v.nummer, carrier: v.carrier_code, tag: `${v.modell}:${v.record_id}` },
    ]))
  } catch (err) {
    await sql`update sendungsverfolgung set registriert_am = null where id = ${v.id}`
    throw err
  }
  const ok = angemeldet.find((a) => a.number === v.nummer)
  const nein = abgelehnt.find((a) => a.number === v.nummer)
  if (!ok && nein && nein.code !== BEREITS_ANGEMELDET) {
    const grund = registrierungsFehlerText(nein.code, nein.message)
    if (registrierungWiederholen(nein.code)) {
      await sql`update sendungsverfolgung set registriert_am = null where id = ${v.id}`
      throw new Error(`${v.nummer}: ${grund}`)
    }
    await sql`update sendungsverfolgung set status = 'nicht_verfolgbar', aktiv = false, registriert_am = null,
      registrierung_fehler = ${grund}, zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'registrierung'
      where id = ${v.id}`
    await sql`select log_event(${v.modell}, ${v.record_id}, 'error',
      ${`Sendung ${bezeichnung(v)} bei 17TRACK nicht verfolgbar: ${grund}`}, 'track17')`
    return { text: `${v.nummer}: nicht verfolgbar — ${grund}`, ergebnis: 'nicht_verfolgbar' }
  }

  const carrier = ok?.carrier ?? nein?.carrier ?? v.carrier_code
  await sql`update sendungsverfolgung set registrierung_fehler = null,
    carrier_code = coalesce(${carrier}, carrier_code),
    zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'registrierung'
    where id = ${v.id}`
  const [frisch] = await sql<Verfolgung[]>`select ${spalten(sql)} from sendungsverfolgung where id = ${v.id}`
  const staende = await staendeAbfragen([{ nummer: v.nummer, carrier: frisch.carrier_code }])
  const eintrag = staende.get(v.nummer)
  const stand = eintrag ? await standUebernehmen(sql, frisch, eintrag, 'registrierung') : null
  await sql`select log_event(${v.modell}, ${v.record_id}, 'info',
    ${`Sendung ${bezeichnung(frisch)} bei 17TRACK angemeldet${stand ? ` — ${stand.text}` : ''}`}, 'track17')`
  return { text: `${v.nummer} angemeldet${stand ? ` — ${stand.text}` : ''}`, ergebnis: 'angemeldet' }
}

/**
 * Job `track17_registrieren`: Nummer anmelden und den ersten Stand holen.
 * Wiederholbare Ablehnungen (Tageslimit, Kontingent) werfen — die Outbox
 * versucht es mit Backoff erneut; endgültige werden „nicht verfolgbar".
 */
export async function verfolgungRegistrieren(verfolgungId: string): Promise<string> {
  const [v] = await sql<Verfolgung[]>`select ${spalten(sql)} from sendungsverfolgung where id = ${verfolgungId}`
  if (!v) return 'Verfolgung nicht mehr vorhanden'
  return (await anmelden(v)).text
}

/**
 * Cron (stündlich, Aufgabe „tracking"): aktive, angemeldete Sendungen, die
 * länger als sechs Stunden nicht abgefragt wurden — älteste zuerst, ein
 * Stapel je Lauf. Dazu: liegengebliebene Anmeldungen (Job gescheitert)
 * nach einer Stunde erneut einreihen.
 */
export async function verfolgungAbrufen(
  limit = STAPEL_MAX,
): Promise<{ checked: number; updated: number; nachgemeldet: number; fehler?: string }> {
  const nachzumelden = await sql<{ id: string }[]>`
    select v.id from sendungsverfolgung v
    where v.aktiv and v.registriert_am is null and v.created_at < now() - interval '1 hour'
      and not exists (select 1 from integration_jobs j
                      where j.kind = 'track17_registrieren' and j.payload ->> 'verfolgung_id' = v.id::text
                        and j.status in ('pending', 'running'))
    limit ${limit}`
  const stunde = new Date().toISOString().slice(0, 13)
  for (const r of nachzumelden) {
    await sql`select enqueue_job('track17_registrieren', ${sql.json({ verfolgung_id: r.id })}, ${`track17:${r.id}:${stunde}`})`
  }

  const rows = await sql<Verfolgung[]>`
    select ${spalten(sql)} from sendungsverfolgung
    where aktiv and registriert_am is not null
      and (zuletzt_abgefragt_am is null or zuletzt_abgefragt_am < now() - make_interval(hours => ${ABRUF_ABSTAND_STUNDEN}))
    order by zuletzt_abgefragt_am nulls first
    limit ${Math.min(limit, STAPEL_MAX)}`
  if (rows.length === 0) return { checked: 0, updated: 0, nachgemeldet: nachzumelden.length }

  let staende: Map<string, Track17Eintrag>
  try {
    staende = await staendeAbfragen(rows.map((r) => ({ nummer: r.nummer, carrier: r.carrier_code })))
  } catch (err) {
    // Der Stapel gilt als abgefragt — sonst erzeugt jede Stunde derselbe
    // Stapel dieselbe Fehlermeldung (Muster syncTracking).
    await sql`update sendungsverfolgung set zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'abruf'
              where id in ${sql(rows.map((r) => r.id))}`
    const fehler = err instanceof Track17Error ? err.message : 'Abfrage bei 17TRACK fehlgeschlagen'
    return { checked: rows.length, updated: 0, nachgemeldet: nachzumelden.length, fehler }
  }

  let updated = 0
  for (const r of rows) {
    const eintrag = staende.get(r.nummer)
    if (!eintrag) {
      await sql`update sendungsverfolgung set zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'abruf' where id = ${r.id}`
      continue
    }
    const { geaendert } = await standUebernehmen(sql, r, eintrag, 'abruf')
    if (geaendert) updated++
  }
  return { checked: rows.length, updated, nachgemeldet: nachzumelden.length }
}

interface WebhookDaten {
  event?: string
  data?: ({ number?: string; accepted?: Track17Eintrag[] } & Partial<Track17Eintrag>) | null
}

/**
 * Webhook von 17TRACK: TRACKING_UPDATED trägt den Stand einer Nummer
 * (bei älteren Pushes als data.accepted[]), TRACKING_STOPPED beendet die
 * Verfolgung. Unbekannte Nummern werden ignoriert — der Push kann zu einer
 * Nummer gehören, die am Beleg schon ersetzt wurde.
 */
export async function webhookVerarbeiten(payload: WebhookDaten): Promise<string> {
  const data = payload.data ?? null
  const eintraege: Track17Eintrag[] = Array.isArray(data?.accepted)
    ? data.accepted
    : data?.number
      ? [data as Track17Eintrag]
      : []
  if (eintraege.length === 0) return 'ohne Sendungsnummer — ignoriert'

  const ereignis = payload.event ?? 'TRACKING_UPDATED'
  let betroffen = 0
  for (const eintrag of eintraege) {
    const nummer = nummerNormieren(eintrag.number)
    const rows = await sql<Verfolgung[]>`select ${spalten(sql)} from sendungsverfolgung where nummer = ${nummer}`
    for (const r of rows) {
      betroffen++
      if (ereignis === 'TRACKING_STOPPED') {
        await sql`update sendungsverfolgung set aktiv = false, zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'webhook'
                  where id = ${r.id}`
        await sql`select log_event(${r.modell}, ${r.record_id}, 'info',
          ${`Sendung ${bezeichnung(r)}: 17TRACK hat die Verfolgung beendet (keine Updates mehr)`}, 'track17')`
        continue
      }
      await standUebernehmen(sql, r, eintrag, 'webhook')
    }
  }
  return betroffen === 0 ? `${eintraege.length} Nummer(n) unbekannt — ignoriert` : `${betroffen} Sendung(en) aktualisiert`
}

/**
 * „Jetzt abfragen" (Registry-Aktionen einkauf.zulauf_verfolgen und
 * einkauf.sendung_verfolgen): sorgt für die Zeile, meldet notfalls sofort
 * an und holt den Stand — synchron, mit dem Ergebnis als Text.
 */
export async function verfolgungJetztAbfragen(
  modell: VerfolgungModell,
  recordId: string,
  actor: string,
): Promise<AktionsErgebnis> {
  const [beleg] =
    modell === 'purchase_order'
      ? await sql<{ nummer: string | null; carrier: string | null }[]>`
          select tracking_number as nummer, carrier from purchase_orders where id = ${recordId}`
      : await sql<{ nummer: string | null; carrier: string | null }[]>`
          select hbl_awb as nummer, traeger as carrier from eingangs_sendungen where id = ${recordId}`
  if (!beleg) throw new Error('Beleg nicht gefunden.')
  if (!nummerNormieren(beleg.nummer)) throw new Error('Keine Sendungsnummer am Beleg — erst Carrier und Nummer eintragen.')
  if (!track17Konfiguriert()) {
    throw new Error('17TRACK ist nicht angebunden (TRACK17_API_KEY fehlt) — Einstellungen → Schnittstellen.')
  }

  const row = await verfolgungAnmelden(sql, modell, recordId, beleg.nummer, beleg.carrier, actor)
  if (!row) throw new Error('Keine Sendungsnummer am Beleg.')
  let text: string | null = null
  if (!row.registriert_am) {
    const a = await anmelden(row)
    // „schon": der Outbox-Job war schneller — dann wie angemeldet nur abfragen.
    if (a.ergebnis !== 'schon') text = a.text
  }
  if (text === null) {
    const [aktuell] = await sql<Verfolgung[]>`select ${spalten(sql)} from sendungsverfolgung where id = ${row.id}`
    const staende = await staendeAbfragen([{ nummer: aktuell.nummer, carrier: aktuell.carrier_code }])
    const eintrag = staende.get(aktuell.nummer)
    if (!eintrag) {
      await sql`update sendungsverfolgung set zuletzt_abgefragt_am = now(), zuletzt_abgefragt_via = 'manuell' where id = ${aktuell.id}`
      text = `${bezeichnung(aktuell)}: 17TRACK kennt die Nummer (noch) nicht`
    } else {
      const stand = await standUebernehmen(sql, aktuell, eintrag, 'manuell')
      text = `${bezeichnung(aktuell)}: ${stand.text}`
    }
  }
  return { text: `${text} (gerade abgefragt).`, recordId }
}
