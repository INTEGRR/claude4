import { sql, tx } from '@/db/client'
import { antwortKoepfe } from '@/modules/einkauf/mail-bauen'
import { MAX_ANHANG_BYTES, versandText } from '@/modules/einkauf/mail-senden'
import { type Sprache, type VorlagenAnlass, offenePlatzhalter, vorlageFuellen } from '@/modules/einkauf/mail-vorlagen'
import { nachrichtUebersetzen as nachrichtUebersetzenKern } from '@/modules/einkauf/nachricht-uebersetzen'
import { zielOrdner } from '@/modules/google/ablage'
import { driveKonfiguriert, postfachKonfiguriert } from '@/modules/google/auth'
import { drive } from '@/modules/google/drive'
import { uebersetzen, uebersetzungMoeglich } from '@/modules/ki/uebersetzen'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 2b (0094): Entwürfe, Vorlagen, Übersetzung, Freigabe. */

/** Anrede, wenn der Name des Gegenübers fehlt — je Sprache, passend zu den Vorlagen. */
const ANREDE_ERSATZ: Record<Sprache, string> = { de: 'zusammen', en: 'Sir or Madam', zh: '尊敬的供应商' }

export interface EntwurfEingabe {
  thread_id?: string
  partner_id?: string
  purchase_order_id?: string
  vorlage?: VorlagenAnlass
  sprache?: Sprache
  an?: string[]
  cc?: string[]
  betreff?: string
  text_de?: string
  text_ziel?: string
  anhang_dokument_ids: string[]
  antwort_erwartet_bis?: string
  bestell_pdf: boolean
  einkaufsprojekt_id?: string
}

/** Zusätze für aufrufende Fachfunktionen (Anfrage aus dem Einkaufsprojekt, 0097). */
export interface EntwurfZusatz {
  /** Den aus der Vorlage gefüllten Text je Sprache nachbearbeiten (z. B. Positionsblock einsetzen). */
  textAnpassen?: (text: string, sprache: Sprache) => string
  /** Weitere bzw. übersteuerte Platzhalter je Sprache (z. B. {{dokumente}} der Pflichtdokument-Nachfrage, 0108). */
  werte?: (sprache: Sprache) => Record<string, string | undefined>
}

export async function entwurfAnlegen(
  p: EntwurfEingabe,
  ctx: AktionsKontext,
  quelle: 'mensch' | 'agent' = 'mensch',
  zusatz: EntwurfZusatz = {},
): Promise<AktionsErgebnis> {
  let partnerId = p.partner_id ?? null
  let poId = p.purchase_order_id ?? null
  let betreff = p.betreff ?? ''
  let an = p.an ?? []
  let ansprechpartner: string | null = null
  let threadBetreff: string | null = null
  let verlauf: { rfc822Id: string | null }[] = []

  if (p.thread_id) {
    const [t] = await sql<{ partner_id: string | null; purchase_order_id: string | null; betreff: string | null }[]>`
      select partner_id, purchase_order_id, betreff from mail_threads where id = ${p.thread_id}`
    if (!t) throw new Error('Thread nicht gefunden.')
    partnerId ??= t.partner_id
    poId ??= t.purchase_order_id
    threadBetreff = t.betreff
    const [letzte] = await sql<{ von: string | null; von_name: string | null }[]>`
      select von, von_name from mail_nachrichten
      where thread_id = ${p.thread_id} and richtung = 'eingang' and von like '%@%'
      order by datum desc limit 1`
    if (letzte) {
      if (!an.length && letzte.von) an = [letzte.von]
      ansprechpartner = letzte.von_name?.split(/[\s,]+/)[0] ?? null
    }
    verlauf = (
      await sql<{ rfc822_id: string | null }[]>`
        select rfc822_id from mail_nachrichten where thread_id = ${p.thread_id} order by datum`
    ).map((v) => ({ rfc822Id: v.rfc822_id }))
  }

  let po: { number: string; vendor_id: string; eta: string | null } | undefined
  if (poId) {
    ;[po] = await sql<{ number: string; vendor_id: string; eta: string | null }[]>`
      select number, vendor_id, to_char(coalesce(eta_confirmed::timestamptz, expected_arrival), 'YYYY-MM-DD') as eta
      from purchase_orders where id = ${poId}`
    if (!po) throw new Error('Bestellung nicht gefunden.')
    if (partnerId && partnerId !== po.vendor_id) throw new Error(`Bestellung ${po.number} gehört zu einem anderen Lieferanten.`)
    partnerId = po.vendor_id
  }

  const [partner] = partnerId
    ? await sql<{ name: string; email: string | null; sprache: string | null; country_code: string | null }[]>`
        select name, email, sprache, country_code from partners where id = ${partnerId}`
    : []
  if (partnerId && !partner) throw new Error('Lieferant nicht gefunden.')
  if (!an.length && partner?.email) an = [partner.email.toLowerCase()]
  const sprache: Sprache =
    p.sprache ?? ((partner?.sprache as Sprache | null) ?? (partner && partner.country_code !== 'DE' ? 'en' : 'de'))

  let textDe = p.text_de ?? ''
  let textZiel: string | null = sprache === 'de' ? null : (p.text_ziel ?? null)
  if (p.vorlage) {
    const vorlagen = await sql<{ sprache: Sprache; betreff: string; text: string }[]>`
      select sprache, betreff, text from mail_vorlagen where anlass = ${p.vorlage} and aktiv and sprache in ('de', ${sprache})`
    const de = vorlagen.find((v) => v.sprache === 'de')
    const ziel = vorlagen.find((v) => v.sprache === sprache)
    if (!de || !ziel) throw new Error(`Vorlage „${p.vorlage}" fehlt für ${sprache}.`)
    const [firma] = await sql<{ name: string | null }[]>`select value ->> 'name' as name from settings where key = 'company'`
    const werte = (s: Sprache) => ({
      ansprechpartner: ansprechpartner ?? ANREDE_ERSATZ[s],
      lieferant: partner?.name,
      bestellnummer: po?.number,
      liefertermin: po?.eta,
      einkaeufer: ctx.actor,
      firma: firma?.name ?? undefined,
      ...(zusatz.werte?.(s) ?? {}),
    })
    const anpassen = zusatz.textAnpassen ?? ((t: string) => t)
    if (!p.text_de) textDe = anpassen(vorlageFuellen(de.text, werte('de')), 'de')
    if (sprache !== 'de' && !p.text_ziel) textZiel = anpassen(vorlageFuellen(ziel.text, werte(sprache)), sprache)
    if (!betreff) betreff = vorlageFuellen((sprache === 'de' ? de : ziel).betreff, werte(sprache))
  }
  // Antwort im Thread: Betreff „Re: …" des Gesprächs, damit Gmail und der Lieferant ihn zuordnen.
  if (p.thread_id && !p.betreff) betreff = antwortKoepfe(verlauf, threadBetreff ?? betreff).betreff

  const anhaenge = [...p.anhang_dokument_ids]
  if (p.bestell_pdf) {
    if (!poId) throw new Error('Das Bestell-PDF braucht eine Bestellung.')
    anhaenge.push(await bestellPdfAblegen(poId, partnerId, ctx))
  }

  const [e] = await sql<{ id: string }[]>`
    insert into mail_entwuerfe (thread_id, partner_id, purchase_order_id, an, cc, betreff, text_de, text_ziel, sprache,
                                vorlage, anhang_dokument_ids, quelle, antwort_erwartet_bis, erstellt_von, zustaendig_id,
                                einkaufsprojekt_id)
    values (${p.thread_id ?? null}, ${partnerId}, ${poId}, ${an}::text[], ${p.cc ?? []}::text[], ${betreff}, ${textDe}, ${textZiel},
            ${sprache}, ${p.vorlage ?? null}, ${anhaenge}::uuid[], ${quelle}, ${p.antwort_erwartet_bis ?? null},
            ${ctx.actor}, ${ctx.userId ?? null}, ${p.einkaufsprojekt_id ?? null})
    returning id`
  await sql`select log_event('mail_entwurf', ${e.id}, 'info', ${`Entwurf angelegt${p.vorlage ? ` (Vorlage ${p.vorlage})` : ''}`}, ${ctx.actor})`
  return { text: 'Entwurf angelegt.', recordId: e.id, link: `/einkauf/entwuerfe/${e.id}` }
}

/** Rendert das Bestell-PDF und legt es als Dokument „Bestellung" in den Bestellordner. */
async function bestellPdfAblegen(poId: string, partnerId: string | null, ctx: AktionsKontext): Promise<string> {
  if (!driveKonfiguriert()) {
    throw new Error('Das Bestell-PDF wird in der Google-Ablage abgelegt — GOOGLE_EINKAUF_ABLAGE_ID setzen.')
  }
  const { bestellungPdf } = await import('@/modules/einkauf/bestellung-pdf')
  const pdf = await bestellungPdf(poId)
  const datei = await (await drive()).dateiHochladen({
    name: pdf.dateiname,
    mime: 'application/pdf',
    bytes: pdf.bytes,
    elternId: await zielOrdner('purchase_order', poId),
  })
  return tx(async (t) => {
    const [d] = await t<{ id: string }[]>`
      insert into dokumente (drive_file_id, name, mime, groesse, md5, art, quelle, partner_id, hochgeladen_von)
      values (${datei.id}, ${pdf.dateiname}, 'application/pdf', ${pdf.bytes.byteLength}, ${datei.md5Checksum ?? null},
              'bestellung', 'manuell', ${partnerId}, ${ctx.actor})
      returning id`
    await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
            values (${d.id}, 'purchase_order', ${poId}, ${ctx.actor}) on conflict do nothing`
    if (partnerId) {
      await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
              values (${d.id}, 'partner', ${partnerId}, ${ctx.actor}) on conflict do nothing`
    }
    return d.id
  })
}

export interface EntwurfZeile {
  id: string
  status: string
  sprache: Sprache
  text_de: string
  text_ziel: string | null
  an: string[]
  betreff: string
  anhang_dokument_ids: string[]
}

export async function entwurfLesen(id: string): Promise<EntwurfZeile> {
  const [e] = await sql<EntwurfZeile[]>`
    select id, status::text as status, sprache, text_de, text_ziel, an, betreff, anhang_dokument_ids
    from mail_entwuerfe where id = ${id}`
  if (!e) throw new Error('Entwurf nicht gefunden.')
  return e
}

/**
 * Prüfungen vor der Freigabe — geteilt von der Einzelfreigabe und der
 * Sammelfreigabe der Anfragen (0097): Postfach angebunden, Empfänger,
 * Betreff, Text in der Versandsprache, keine offenen Platzhalter, Anhänge
 * unter der Gmail-Grenze. Wirft mit einer Meldung für Menschen.
 */
export async function freigabePruefen(e: EntwurfZeile): Promise<void> {
  if (e.status !== 'entwurf') throw new Error('Dieser Entwurf ist schon freigegeben oder erledigt.')
  if (!postfachKonfiguriert()) {
    throw new Error('Das Einkaufspostfach ist nicht angebunden — GOOGLE_DIENSTKONTO_JSON und EINKAUF_POSTFACH setzen.')
  }
  if (e.an.length === 0) throw new Error('Bitte mindestens einen Empfänger eintragen.')
  if (!e.betreff.trim()) throw new Error('Bitte einen Betreff eintragen.')
  const text = versandText(e)
  if (!text) {
    throw new Error(
      e.sprache === 'de' ? 'Der Text ist leer.' : 'Der Text in der Sprache des Lieferanten ist leer — erst übersetzen oder schreiben.',
    )
  }
  const offen = offenePlatzhalter(`${e.betreff}\n${text}`)
  if (offen.length) throw new Error(`Noch offene Platzhalter: ${offen.map((o) => `[${o}]`).join(', ')} — bitte ausfüllen.`)
  if (e.anhang_dokument_ids.length) {
    const [{ summe }] = await sql<{ summe: number }[]>`
      select coalesce(sum(groesse), 0)::float as summe from dokumente where id = any(${e.anhang_dokument_ids}::uuid[])`
    if (summe > MAX_ANHANG_BYTES) {
      throw new Error(`Die Anhänge sind zusammen ${(summe / 1024 / 1024).toFixed(1)} MB groß — höchstens 18 MB je Mail. Große Dateien per Drive-Link oder WeTransfer teilen.`)
    }
  }
}

/** Freigeben und das Senden einreihen — in der Transaktion des Aufrufers. */
export async function freigabeEinreihen(t: typeof sql, e: EntwurfZeile, actor: string): Promise<void> {
  await t`update mail_entwuerfe set status = 'freigegeben', freigegeben_von = ${actor}, freigegeben_am = now(), fehler = null
          where id = ${e.id}`
  await t`select enqueue_job('gmail_senden', ${t.json({ entwurf_id: e.id })}, ${`gmail-senden:${e.id}`})`
  await t`select log_event('mail_entwurf', ${e.id}, 'info', ${`Freigegeben — wird an ${e.an.join(', ')} gesendet`}, ${actor})`
}

export async function mailEntwurfAnlegen(p: EntwurfEingabe, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  return entwurfAnlegen(p, ctx)
}

export async function mailEntwurfAendern(
  p: {
    an?: string[]
    cc?: string[]
    betreff?: string
    text_de?: string
    text_ziel?: string
    sprache?: Sprache
    anhang_dokument_ids?: string[]
    antwort_erwartet_bis?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const e = await entwurfLesen(ctx.recordId!)
  if (e.status !== 'entwurf') throw new Error('Nur Entwürfe lassen sich ändern — dieser ist schon freigegeben oder erledigt.')
  await sql`
    update mail_entwuerfe set
      an = coalesce(${p.an ?? null}::text[], an),
      cc = coalesce(${p.cc ?? null}::text[], cc),
      betreff = coalesce(${p.betreff ?? null}, betreff),
      text_de = coalesce(${p.text_de ?? null}, text_de),
      text_ziel = case when ${p.text_ziel !== undefined} then nullif(${p.text_ziel ?? ''}, '') else text_ziel end,
      sprache = coalesce(${p.sprache ?? null}, sprache),
      anhang_dokument_ids = coalesce(${p.anhang_dokument_ids ?? null}::uuid[], anhang_dokument_ids),
      antwort_erwartet_bis = case when ${p.antwort_erwartet_bis !== undefined}
                                  then nullif(${p.antwort_erwartet_bis ?? ''}, '')::date else antwort_erwartet_bis end
    where id = ${e.id}`
  return { text: 'Entwurf gespeichert.', recordId: e.id }
}

export async function mailUebersetzen(p: { richtung: 'nach_ziel' | 'nach_de' }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const e = await entwurfLesen(ctx.recordId!)
  if (e.status !== 'entwurf') throw new Error('Nur Entwürfe lassen sich übersetzen.')
  if (e.sprache === 'de') throw new Error('Der Lieferant schreibt deutsch — nichts zu übersetzen.')
  if (!uebersetzungMoeglich()) throw new Error('Übersetzen braucht die KI — ANTHROPIC_API_KEY ist nicht gesetzt.')
  const quelle = p.richtung === 'nach_ziel' ? e.text_de : (e.text_ziel ?? '')
  if (!quelle.trim()) throw new Error(p.richtung === 'nach_ziel' ? 'Der deutsche Text ist leer.' : 'Der Text in der Zielsprache ist leer.')
  const u = await uebersetzen(quelle, p.richtung === 'nach_ziel' ? e.sprache : 'de', {
    zweck: p.richtung === 'nach_ziel' ? 'uebersetzung_entwurf' : 'rueckuebersetzung_entwurf',
    modell: 'mail_entwurf',
    recordId: e.id,
  })
  if (p.richtung === 'nach_ziel') await sql`update mail_entwuerfe set text_ziel = ${u.text} where id = ${e.id}`
  else await sql`update mail_entwuerfe set text_de = ${u.text} where id = ${e.id}`
  return { text: p.richtung === 'nach_ziel' ? 'Übersetzt — bitte gegenlesen.' : 'Ins Deutsche zurückübersetzt.', recordId: e.id }
}

export async function mailFreigeben(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const e = await entwurfLesen(ctx.recordId!)
  await freigabePruefen(e)
  await tx(async (t) => freigabeEinreihen(t as unknown as typeof sql, e, ctx.actor))
  return { text: `Freigegeben — die Mail an ${e.an.join(', ')} geht innerhalb einer Minute hinaus.`, recordId: e.id }
}

export async function mailVerwerfen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [e] = await sql<{ id: string }[]>`
    update mail_entwuerfe set status = 'verworfen' where id = ${ctx.recordId!} and status = 'entwurf' returning id`
  if (!e) throw new Error('Nur offene Entwürfe lassen sich verwerfen.')
  await sql`select log_event('mail_entwurf', ${e.id}, 'info', 'Verworfen', ${ctx.actor})`
  return { text: 'Entwurf verworfen.', recordId: e.id }
}

export async function nachrichtUebersetzen(p: { nachricht_id: string }, _ctx: AktionsKontext): Promise<AktionsErgebnis> {
  if (!uebersetzungMoeglich()) throw new Error('Übersetzen braucht die KI — ANTHROPIC_API_KEY ist nicht gesetzt.')
  const text = await nachrichtUebersetzenKern(p.nachricht_id, true)
  const [n] = await sql<{ thread_id: string }[]>`select thread_id from mail_nachrichten where id = ${p.nachricht_id}`
  return { text, recordId: n?.thread_id }
}
