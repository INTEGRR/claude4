import { sql, tx } from '@/db/client'
import { type GmailApi, type GmailNachricht, VerlaufAbgelaufen, gmail } from '@/modules/google/gmail'
import { betreffKern, kopfDatumLesen, mailZerlegen, weiterleitungZerlegen } from './mail-zerlegen.ts'
import { domainVon } from './mail-regeln.ts'

/**
 * Abgleich des Einkaufspostfachs (0093) — jede Minute über
 * /api/cron?task=mail. Der Cursor (Gmails historyId) steht in
 * settings['einkauf_postfach']; beim ersten Lauf gibt es keinen, dann holt
 * KRNL die letzten 30 Tage. Kennt Google den Cursor nicht mehr (nach
 * ~einer Woche Stillstand), fällt der Abgleich auf die letzten 7 Tage
 * zurück. Doppelt übernommen wird nie: die Gmail-Nachrichten-ID ist
 * eindeutig, bekannte werden vor dem Abruf aussortiert.
 *
 * Zeitbudget: Vercel beendet nach 60 s. Reicht das Budget nicht, bleibt der
 * Cursor stehen — der nächste Lauf überspringt das schon Übernommene und
 * macht weiter.
 *
 * Anhänge wandern nicht hier, sondern je Anhang als Outbox-Job
 * `gmail_anhang_ablegen` in die Drive-Ablage (Retry, Zeitbudget der Jobs).
 */

export const POSTFACH_SCHLUESSEL = 'einkauf_postfach'
export const ABGLEICH_BUDGET_MS = 40_000
const ERSTLAUF_ABFRAGE = 'newer_than:30d'
const RUECKFALL_ABFRAGE = 'newer_than:7d'
const MAX_SEITEN = 5
/** Kleine Bilder sind fast immer Signatur-Logos — sie landen nicht in der Ablage. */
const SIGNATUR_BYTES = 20_000
const UEBERSPRINGEN = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT'])

export interface PostfachStand {
  history_id?: string
  adresse?: string
  letzter_lauf?: string
  letzte_neue?: number
}

export interface AbgleichErgebnis {
  neu: number
  bekannt: number
  uebersprungen: number
  zugeordnet: number
  anhaenge: number
  fehler: string[]
  /** Budget erschöpft — der nächste Lauf macht weiter. */
  weiter: boolean
  rueckfall: boolean
}

export async function postfachStand(): Promise<PostfachStand> {
  const [r] = await sql<{ value: PostfachStand }[]>`select value from settings where key = ${POSTFACH_SCHLUESSEL}`
  return r?.value ?? {}
}

async function standSchreiben(teil: PostfachStand) {
  await sql`insert into settings (key, value) values (${POSTFACH_SCHLUESSEL}, ${sql.json(teil as never)})
            on conflict (key) do update set value = settings.value || excluded.value`
}

async function alleSeiten(holen: (seite?: string) => Promise<{ ids: string[]; weiter?: string }>): Promise<string[]> {
  const ids: string[] = []
  let seite: string | undefined
  for (let i = 0; i < MAX_SEITEN; i++) {
    const r = await holen(seite)
    ids.push(...r.ids)
    if (!r.weiter) break
    seite = r.weiter
  }
  return ids
}

async function verlaufSammeln(api: GmailApi, cursor: string): Promise<{ ids: string[]; historyId: string }> {
  const ids: string[] = []
  let seite: string | undefined
  let historyId = cursor
  for (let i = 0; i < 50; i++) {
    const r = await api.verlauf(cursor, seite)
    ids.push(...r.ids)
    historyId = r.historyId
    if (!r.weiter) break
    seite = r.weiter
  }
  return { ids: [...new Set(ids)], historyId }
}

export async function postfachAbgleichen(budgetMs = ABGLEICH_BUDGET_MS): Promise<AbgleichErgebnis> {
  const beginn = Date.now()
  const api = await gmail()
  const stand = await postfachStand()
  const ergebnis: AbgleichErgebnis = {
    neu: 0, bekannt: 0, uebersprungen: 0, zugeordnet: 0, anhaenge: 0, fehler: [], weiter: false, rueckfall: false,
  }

  let ids: string[]
  let neuerCursor: string
  let adresse = stand.adresse
  if (!stand.history_id) {
    const profil = await api.profil()
    adresse = profil.emailAddress.toLowerCase()
    neuerCursor = profil.historyId
    // Die Liste kommt neueste zuerst — übernommen wird in zeitlicher Folge.
    ids = (await alleSeiten((s) => api.liste(ERSTLAUF_ABFRAGE, s))).reverse()
  } else {
    try {
      const r = await verlaufSammeln(api, stand.history_id)
      ids = r.ids
      neuerCursor = r.historyId
    } catch (err) {
      if (!(err instanceof VerlaufAbgelaufen)) throw err
      ergebnis.rueckfall = true
      const profil = await api.profil()
      adresse = profil.emailAddress.toLowerCase()
      neuerCursor = profil.historyId
      ids = (await alleSeiten((s) => api.liste(RUECKFALL_ABFRAGE, s))).reverse()
    }
  }
  adresse ??= (process.env.EINKAUF_POSTFACH ?? '').toLowerCase()

  const bekannt = ids.length
    ? new Set(
        (await sql<{ gmail_message_id: string }[]>`
          select gmail_message_id from mail_nachrichten where gmail_message_id = any(${ids}::text[])`).map(
          (r) => r.gmail_message_id,
        ),
      )
    : new Set<string>()

  for (const id of ids) {
    if (bekannt.has(id)) {
      ergebnis.bekannt++
      continue
    }
    if (Date.now() - beginn > budgetMs) {
      ergebnis.weiter = true
      break
    }
    let n: GmailNachricht
    try {
      n = await api.nachricht(id)
    } catch (err) {
      // Zwischenzeitlich gelöscht (404): überspringen; alles andere bricht ab
      // und der Cursor bleibt stehen.
      const text = err instanceof Error ? err.message : String(err)
      if (/\b404\b/.test(text)) {
        ergebnis.uebersprungen++
        continue
      }
      throw err
    }
    try {
      const r = await nachrichtUebernehmen(n, adresse)
      if (r === 'uebersprungen') ergebnis.uebersprungen++
      else if (r === 'bekannt') ergebnis.bekannt++
      else {
        ergebnis.neu++
        ergebnis.anhaenge += r.anhaenge
        if (r.zugeordnet) ergebnis.zugeordnet++
      }
    } catch (err) {
      // Eine kaputte Mail darf das Postfach nicht blockieren.
      ergebnis.fehler.push(`${id}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
    }
  }

  await standSchreiben({
    ...(ergebnis.weiter ? {} : { history_id: neuerCursor }),
    adresse,
    letzter_lauf: new Date().toISOString(),
    letzte_neue: ergebnis.neu,
  })
  if (ergebnis.fehler.length) {
    const { logTransaction } = await import('@/modules/integrationen/transaktionen')
    await logTransaction({
      system: 'google',
      kind: 'gmail.abgleich',
      ok: false,
      statusCode: null,
      error: ergebnis.fehler.slice(0, 3).join(' | '),
    })
  }
  return ergebnis
}

type Uebernahme = 'uebersprungen' | 'bekannt' | { anhaenge: number; zugeordnet: boolean; threadId: string }

/**
 * Eine Gmail-Nachricht übernehmen: Richtung (gesendet = Ausgang),
 * Weiterleitung eines Kollegen erkennen (dann zählt der ursprüngliche
 * Absender), Thread anlegen oder fortschreiben, Anhänge vormerken und die
 * Zuordnungsregel laufen lassen — alles in einer Transaktion.
 */
export async function nachrichtUebernehmen(n: GmailNachricht, postfach: string): Promise<Uebernahme> {
  const labels = n.labelIds ?? []
  if (labels.some((l) => UEBERSPRINGEN.has(l))) return 'uebersprungen'

  const m = mailZerlegen(n.payload, n.internalDate)
  const eigeneDomain = domainVon(postfach)
  const absender = m.von?.email ?? null
  const gesendet = labels.includes('SENT') || (absender !== null && absender === postfach)

  let richtung: 'eingang' | 'ausgang' = gesendet ? 'ausgang' : 'eingang'
  let quelle: 'gmail' | 'weitergeleitet' = 'gmail'
  let von = absender
  let vonName = m.von?.name ?? null
  let datum = m.datum ?? new Date()
  let betreff = m.betreff
  let text = m.text
  let erfasstVon: string | null = null

  // Ein Kollege (eigene Domain) leitet einen Alt-Thread weiter: der
  // ursprüngliche Absender, sein Datum und sein Betreff zählen.
  if (!gesendet && eigeneDomain && domainVon(absender) === eigeneDomain) {
    const w = weiterleitungZerlegen(m.text)
    if (w) {
      quelle = 'weitergeleitet'
      erfasstVon = absender
      von = w.von.email
      vonName = w.von.name
      datum = kopfDatumLesen(w.datum) ?? datum
      betreff = w.betreff ?? betreffKern(m.betreff)
      text = w.text || m.text
      richtung = domainVon(w.von.email) === eigeneDomain ? 'ausgang' : 'eingang'
    }
  }

  return tx(async (t) => {
    const [thread] = await t<{ id: string }[]>`
      insert into mail_threads (gmail_thread_id, betreff, kanal)
      values (${n.threadId}, ${betreffKern(betreff) || betreff || null}, 'email')
      on conflict (gmail_thread_id) do update set gmail_thread_id = excluded.gmail_thread_id
      returning id`
    const [nachricht] = await t<{ id: string }[]>`
      insert into mail_nachrichten (thread_id, gmail_message_id, rfc822_id, in_reply_to, richtung, kanal,
                                    von, von_name, an, cc, betreff, datum, text, html, quelle, erfasst_von)
      values (${thread.id}, ${n.id}, ${m.rfc822Id}, ${m.inReplyTo}, ${richtung}, 'email',
              ${von}, ${vonName}, ${m.an}::text[], ${m.cc}::text[], ${betreff || null}, ${datum},
              ${text || null}, ${m.html}, ${quelle}, ${erfasstVon})
      on conflict (gmail_message_id) do nothing
      returning id`
    if (!nachricht) return 'bekannt' as const

    // Alle rechten Seiten sehen die alten Werte: die neueste Nachricht
    // bestimmt Richtung und Zeit; eine Antwort des Lieferanten holt einen
    // erledigten Thread zurück in den Posteingang (ignorierte bleiben still).
    await t`
      update mail_threads set
        anzahl = anzahl + 1,
        letzte_richtung = case when letzte_am is null or ${datum} >= letzte_am then ${richtung}::mail_richtung
                               else letzte_richtung end,
        letzte_am = greatest(coalesce(letzte_am, ${datum}), ${datum}),
        status = case when ${richtung} = 'eingang' and status = 'erledigt' then 'offen'::mail_thread_status
                      else status end,
        betreff = coalesce(betreff, ${betreffKern(betreff) || null})
      where id = ${thread.id}`

    let anhaenge = 0
    for (const a of m.anhaenge) {
      const signatur = a.mime.startsWith('image/') && (a.groesse ?? 0) < SIGNATUR_BYTES
      const [zeile] = await t<{ id: string }[]>`
        insert into mail_anhaenge (nachricht_id, dateiname, mime, groesse, gmail_attachment_id, fehler)
        values (${nachricht.id}, ${a.dateiname}, ${a.mime}, ${a.groesse}, ${a.attachmentId},
                ${signatur ? 'Nicht abgelegt: kleines Bild (vermutlich Signatur)' : null})
        returning id`
      if (signatur) continue
      await t`select enqueue_job('gmail_anhang_ablegen', ${t.json({ anhang_id: zeile.id })},
                                 ${`gmail-anhang:${zeile.id}`})`
      anhaenge++
    }

    const [z] = await t<{ zugeordnet: boolean }[]>`select mail_thread_zuordnen(${thread.id}) as zugeordnet`
    return { anhaenge, zugeordnet: z.zugeordnet, threadId: thread.id }
  })
}
