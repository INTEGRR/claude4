import { sql, tx } from '@/db/client'
import { drive } from '@/modules/google/drive'
import { gmail } from '@/modules/google/gmail'
import { antwortKoepfe, type MailAnhangDaten, mimeBauen } from './mail-bauen.ts'
import { betreffKern } from './mail-zerlegen.ts'
import { postfachStand } from './postfach-abgleich.ts'

/**
 * Dienstschritt `gmail_senden` (0094): ein freigegebener Entwurf geht über
 * das Einkaufspostfach hinaus — im bestehenden Gmail-Thread mit
 * In-Reply-To/References, Anhänge frisch aus der Drive-Ablage. Danach steht
 * die Mail als Nachricht im Thread (der nächste Abgleich erkennt sie an der
 * Gmail-ID und übernimmt sie nicht doppelt), der Entwurf ist `gesendet`,
 * und mit „Antwort erwartet bis" entsteht die Wiedervorlage.
 */

/** Gmail nimmt 25 MB je Mail; base64 bläht um ein Drittel auf. */
export const MAX_ANHANG_BYTES = 18 * 1024 * 1024

interface Entwurf {
  id: string
  status: string
  thread_id: string | null
  gmail_thread_id: string | null
  partner_id: string | null
  purchase_order_id: string | null
  an: string[]
  cc: string[]
  betreff: string
  text_de: string
  text_ziel: string | null
  sprache: 'de' | 'en' | 'zh'
  anhang_dokument_ids: string[]
  antwort_erwartet_bis: string | null
  freigegeben_von: string | null
  zustaendig_id: string | null
}

/** Der Text, der hinausgeht: Deutsch an deutsche Lieferanten, sonst die Zielsprache. */
export function versandText(e: { sprache: string; text_de: string; text_ziel: string | null }): string {
  return (e.sprache === 'de' ? e.text_de : (e.text_ziel ?? '')).trim()
}

export async function postfachAdresse(): Promise<string> {
  const stand = await postfachStand()
  if (stand.adresse) return stand.adresse
  if (process.env.EINKAUF_POSTFACH) return process.env.EINKAUF_POSTFACH.toLowerCase()
  return (await (await gmail()).profil()).emailAddress.toLowerCase()
}

export async function entwurfSenden(entwurfId: string): Promise<string> {
  const [e] = await sql<Entwurf[]>`
    select e.id, e.status::text as status, e.thread_id, t.gmail_thread_id, e.partner_id, e.purchase_order_id,
           e.an, e.cc, e.betreff, e.text_de, e.text_ziel, e.sprache, e.anhang_dokument_ids,
           e.antwort_erwartet_bis::text as antwort_erwartet_bis, e.freigegeben_von, e.zustaendig_id
    from mail_entwuerfe e left join mail_threads t on t.id = e.thread_id
    where e.id = ${entwurfId}`
  if (!e) return 'Entwurf nicht mehr vorhanden'
  if (e.status === 'gesendet') return 'Bereits gesendet'
  if (e.status !== 'freigegeben') return `Nicht freigegeben (${e.status}) — nichts gesendet`

  const text = versandText(e)
  const adresse = await postfachAdresse()
  const [firma] = await sql<{ name: string | null }[]>`select value ->> 'name' as name from settings where key = 'company'`
  const verlauf = e.thread_id
    ? await sql<{ rfc822_id: string | null }[]>`
        select rfc822_id from mail_nachrichten where thread_id = ${e.thread_id} order by datum, created_at`
    : []
  const koepfe = antwortKoepfe(verlauf.map((v) => ({ rfc822Id: v.rfc822_id })), e.betreff)

  const doks = e.anhang_dokument_ids.length
    ? await sql<{ id: string; drive_file_id: string; name: string; mime: string | null; groesse: number | null }[]>`
        select id, drive_file_id, name, mime, groesse::float as groesse from dokumente
        where id = any(${e.anhang_dokument_ids}::uuid[])`
    : []
  const api = await drive()
  const anhaenge: MailAnhangDaten[] = []
  for (const d of doks) {
    anhaenge.push({ dateiname: d.name, mime: d.mime || 'application/octet-stream', bytes: await api.dateiInhalt(d.drive_file_id) })
  }
  const summe = anhaenge.reduce((a, x) => a + x.bytes.byteLength, 0)
  if (summe > MAX_ANHANG_BYTES) {
    throw new Error(`Anhänge zu groß (${(summe / 1024 / 1024).toFixed(1)} MB) — höchstens 18 MB je Mail`)
  }

  const { raw, messageId } = mimeBauen({
    von: adresse,
    vonName: firma?.name ?? null,
    an: e.an,
    cc: e.cc,
    betreff: e.betreff,
    text,
    inReplyTo: koepfe.inReplyTo,
    references: koepfe.references,
    anhaenge,
  })

  let gesendet: { id: string; threadId: string }
  try {
    gesendet = await (await gmail()).senden(raw, e.gmail_thread_id)
  } catch (err) {
    await sql`update mail_entwuerfe set fehler = ${err instanceof Error ? err.message.slice(0, 500) : String(err)}
              where id = ${e.id}`
    throw err
  }

  await tx(async (t) => {
    let threadId = e.thread_id
    if (!threadId) {
      const [vorhanden] = await t<{ id: string }[]>`select id from mail_threads where gmail_thread_id = ${gesendet.threadId}`
      threadId =
        vorhanden?.id ??
        (
          await t<{ id: string }[]>`
            insert into mail_threads (gmail_thread_id, betreff, partner_id, purchase_order_id, zustaendig_id, kanal, zugeordnet_durch)
            values (${gesendet.threadId}, ${betreffKern(e.betreff) || e.betreff}, ${e.partner_id}, ${e.purchase_order_id},
                    ${e.zustaendig_id}, 'email', ${e.partner_id || e.purchase_order_id ? 'mensch' : null})
            returning id`
        )[0].id
    }
    const [n] = await t<{ id: string }[]>`
      insert into mail_nachrichten (thread_id, gmail_message_id, rfc822_id, in_reply_to, richtung, kanal, von, von_name,
                                    an, cc, betreff, datum, text, text_de, sprache, quelle, erfasst_von)
      values (${threadId}, ${gesendet.id}, ${messageId}, ${koepfe.inReplyTo}, 'ausgang', 'email', ${adresse}, ${firma?.name ?? null},
              ${e.an}::text[], ${e.cc}::text[], ${e.betreff}, now(), ${text},
              ${e.sprache === 'de' ? null : e.text_de}, ${e.sprache}, 'gmail', ${e.freigegeben_von})
      on conflict (gmail_message_id) do update set thread_id = excluded.thread_id
      returning id`
    for (const d of doks) {
      await t`insert into mail_anhaenge (nachricht_id, dateiname, mime, groesse, dokument_id)
              values (${n.id}, ${d.name}, ${d.mime}, ${d.groesse}, ${d.id})`
      await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
              values (${d.id}, 'mail_thread', ${threadId}, ${e.freigegeben_von}) on conflict do nothing`
    }
    await t`
      update mail_threads set anzahl = anzahl + 1, letzte_richtung = 'ausgang', letzte_am = now(),
             partner_id = coalesce(partner_id, ${e.partner_id}), purchase_order_id = coalesce(purchase_order_id, ${e.purchase_order_id})
      where id = ${threadId}`
    await t`
      update mail_entwuerfe set status = 'gesendet', gesendet_am = now(), gmail_message_id = ${gesendet.id},
             thread_id = ${threadId}, nachricht_id = ${n.id}, fehler = null
      where id = ${e.id}`
    if (e.antwort_erwartet_bis) {
      await t`insert into wiedervorlagen (modell, record_id, faellig_am, grund, zustaendig_id, erstellt_von)
              values ('mail_thread', ${threadId}, ${e.antwort_erwartet_bis}, ${`Antwort erwartet: ${betreffKern(e.betreff)}`},
                      ${e.zustaendig_id}, ${e.freigegeben_von})`
    }
    await t`select log_event('mail_entwurf', ${e.id}, 'email', ${`Gesendet an ${e.an.join(', ')}`}, ${e.freigegeben_von})`
    if (e.purchase_order_id) {
      await t`select log_event('purchase_order', ${e.purchase_order_id}, 'email',
                               ${`Mail an ${e.an.join(', ')} gesendet: ${e.betreff}`}, ${e.freigegeben_von})`
    }
  })
  return `„${e.betreff}" an ${e.an.join(', ')} gesendet${doks.length ? ` (${doks.length} Anhang/Anhänge)` : ''}`
}
