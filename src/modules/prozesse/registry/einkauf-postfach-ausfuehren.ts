import { sql, tx } from '@/db/client'
import { absenderKennung } from '@/modules/einkauf/mail-regeln'
import { postfachAbgleichen } from '@/modules/einkauf/postfach-abgleich'
import { zielOrdner } from '@/modules/google/ablage'
import { driveKonfiguriert, postfachKonfiguriert } from '@/modules/google/auth'
import { drive } from '@/modules/google/drive'
import { belegPruefen } from './einkauf-dokumente-ausfuehren.ts'
import type { WiedervorlageModell } from './einkauf-postfach.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 2a (0093): Posteingang, erfasste Nachrichten, Wiedervorlagen. */

export async function mailZuordnen(
  p: { partner_id?: string; purchase_order_id?: string; einkaufsprojekt_id?: string; zustaendig_id?: string; absender_merken: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const threadId = ctx.recordId!
  let partnerId = p.partner_id ?? null
  // Nur ein Einkaufsprojekt gewählt (0097): Lieferant und Bestellung des Threads bleiben.
  const nurProjekt = Boolean(p.einkaufsprojekt_id && !p.partner_id && !p.purchase_order_id)
  let projekt: { nummer: string } | undefined
  if (p.einkaufsprojekt_id) {
    ;[projekt] = await sql<{ nummer: string }[]>`select nummer from einkaufsprojekte where id = ${p.einkaufsprojekt_id}`
    if (!projekt) throw new Error('Einkaufsprojekt nicht gefunden.')
  }
  if (nurProjekt) {
    const [t] = await sql<{ partner_id: string | null }[]>`select partner_id from mail_threads where id = ${threadId}`
    partnerId = t?.partner_id ?? null
  }
  if (p.purchase_order_id) {
    const [po] = await sql<{ vendor_id: string; number: string }[]>`
      select vendor_id, number from purchase_orders where id = ${p.purchase_order_id}`
    if (!po) throw new Error('Bestellung nicht gefunden.')
    if (partnerId && partnerId !== po.vendor_id) {
      throw new Error(`Bestellung ${po.number} gehört zu einem anderen Lieferanten.`)
    }
    partnerId = po.vendor_id
  }
  const [partner] = partnerId
    ? await sql<{ name: string; einkaeufer_id: string | null }[]>`
        select name, einkaeufer_id from partners where id = ${partnerId}`
    : []
  if (partnerId && !partner) throw new Error('Lieferant nicht gefunden.')
  if (!partner && !nurProjekt) throw new Error('Lieferant nicht gefunden.')

  const gemerkt = await tx(async (t) => {
    const [thread] = await t<{ id: string }[]>`
      update mail_threads set
        partner_id = ${partnerId},
        purchase_order_id = case when ${nurProjekt} then purchase_order_id else ${p.purchase_order_id ?? null}::uuid end,
        einkaufsprojekt_id = coalesce(${p.einkaufsprojekt_id ?? null}::uuid, einkaufsprojekt_id),
        zustaendig_id = coalesce(${p.zustaendig_id ?? null}::uuid, zustaendig_id, ${partner?.einkaeufer_id ?? null}::uuid),
        zugeordnet_durch = 'mensch'
      where id = ${threadId}
      returning id`
    if (!thread) throw new Error('Thread nicht gefunden.')
    if (partnerId) await t`update partners set is_vendor = true where id = ${partnerId} and not is_vendor`
    if (p.einkaufsprojekt_id && partnerId) {
      // Antwort auf eine Anfrage: der Thread hängt ab jetzt an ihr.
      await t`update lieferantenanfragen set thread_id = coalesce(thread_id, ${threadId})
              where projekt_id = ${p.einkaufsprojekt_id} and partner_id = ${partnerId}`
    }

    // Anhänge folgen dem Thread: an Lieferant und Bestellung hängen,
    // herrenlose Dokumente bekommen den Lieferanten.
    const doks = await t<{ dokument_id: string }[]>`
      select dokument_id from dokument_verweise where modell = 'mail_thread' and record_id = ${threadId}`
    for (const d of doks) {
      if (partnerId) {
        await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
                values (${d.dokument_id}, 'partner', ${partnerId}, ${ctx.actor}) on conflict do nothing`
      }
      if (p.einkaufsprojekt_id) {
        await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
                values (${d.dokument_id}, 'einkaufsprojekt', ${p.einkaufsprojekt_id}, ${ctx.actor}) on conflict do nothing`
      }
      if (p.purchase_order_id) {
        await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
                values (${d.dokument_id}, 'purchase_order', ${p.purchase_order_id}, ${ctx.actor}) on conflict do nothing`
      }
    }
    await t`update dokumente set partner_id = coalesce(partner_id, ${partnerId})
            where partner_id is null and id in (
              select dokument_id from dokument_verweise where modell = 'mail_thread' and record_id = ${threadId})`

    let kennung: string | null = null
    if (p.absender_merken && partnerId) {
      const [erste] = await t<{ von: string | null }[]>`
        select coalesce(
          (select von from mail_nachrichten where thread_id = ${threadId} and richtung = 'eingang' and von like '%@%'
           order by datum limit 1),
          (select an[1] from mail_nachrichten where thread_id = ${threadId} and richtung = 'ausgang' and an[1] like '%@%'
           order by datum limit 1)) as von`
      if (erste?.von) {
        kennung = absenderKennung(erste.von)
        const [belegt] = await t<{ name: string }[]>`
          select name from partners where id <> ${partnerId} and ${kennung} = any(mail_domains)`
        if (belegt) throw new Error(`${kennung} ist schon ${belegt.name} zugeordnet — dort zuerst entfernen.`)
        await t`update partners set mail_domains = array_append(mail_domains, ${kennung})
                where id = ${partnerId} and not (${kennung} = any(mail_domains))`
      }
    }
    const ziel = [partner?.name, projekt?.nummer].filter(Boolean).join(' · ')
    await t`select log_event('mail_thread', ${threadId}, 'info', ${`Zugeordnet: ${ziel}`}, ${ctx.actor})`
    return kennung
  })

  const umgezogen = await anhaengeUmziehen(threadId)
  return {
    text:
      `Thread ${[partner?.name, projekt?.nummer].filter(Boolean).join(' · ')} zugeordnet.` +
      (gemerkt ? ` ${gemerkt} wird künftig automatisch zugeordnet.` : '') +
      (umgezogen ? ` ${umgezogen} Datei(en) in den Lieferantenordner verschoben.` : ''),
    recordId: threadId,
  }
}

/**
 * Dateien des Threads, die noch im Ablage-Eingang liegen, in den Ordner
 * von Bestellung bzw. Lieferant verschieben. Best effort: ein Drive-Fehler
 * macht die Zuordnung nicht rückgängig (die Verknüpfung in KRNL zählt).
 */
async function anhaengeUmziehen(threadId: string): Promise<number> {
  if (!driveKonfiguriert()) return 0
  const [eingang] = await sql<{ folder_id: string }[]>`select folder_id from drive_ordner where schluessel = 'wurzel:eingang'`
  if (!eingang) return 0
  const doks = await sql<{ drive_file_id: string }[]>`
    select d.drive_file_id from dokumente d
    join dokument_verweise v on v.dokument_id = d.id and v.modell = 'mail_thread' and v.record_id = ${threadId}
    where d.quelle = 'mail'`
  if (doks.length === 0) return 0
  let ziel: string
  let api: Awaited<ReturnType<typeof drive>>
  try {
    ziel = await zielOrdner('mail_thread', threadId)
    api = await drive()
  } catch {
    return 0
  }
  let n = 0
  for (const d of doks) {
    try {
      const datei = await api.dateiLesen(d.drive_file_id)
      if (!datei.parents?.includes(eingang.folder_id)) continue
      await api.dateiVerschieben(d.drive_file_id, ziel)
      n++
    } catch {
      // Datei in Drive gelöscht oder keine Rechte: bleibt, wo sie ist.
    }
  }
  return n
}

export async function mailStatusSetzen(
  p: { status: 'offen' | 'erledigt' | 'ignoriert' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [t] = await sql<{ id: string }[]>`
    update mail_threads set status = ${p.status} where id = ${ctx.recordId!} returning id`
  if (!t) throw new Error('Thread nicht gefunden.')
  await sql`select log_event('mail_thread', ${t.id}, 'info', ${`Status: ${p.status}`}, ${ctx.actor})`
  const text = { offen: 'Thread wieder offen.', erledigt: 'Thread erledigt.', ignoriert: 'Thread ignoriert.' }[p.status]
  return { text, recordId: t.id }
}

export async function nachrichtErfassen(
  p: {
    kanal: 'alibaba' | 'telefon' | 'sonstiges' | 'email'
    richtung: 'eingang' | 'ausgang'
    thread_id?: string
    partner_id?: string
    purchase_order_id?: string
    betreff?: string
    text: string
    datum?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  let partnerId = p.partner_id ?? null
  if (p.purchase_order_id) {
    const [po] = await sql<{ vendor_id: string }[]>`select vendor_id from purchase_orders where id = ${p.purchase_order_id}`
    if (!po) throw new Error('Bestellung nicht gefunden.')
    partnerId ??= po.vendor_id
  }
  const datum = p.datum ? new Date(p.datum) : new Date()

  const threadId = await tx(async (t) => {
    let id = p.thread_id ?? null
    if (id) {
      const [da] = await t<{ id: string; partner_id: string | null }[]>`
        select id, partner_id from mail_threads where id = ${id} for update`
      if (!da) throw new Error('Thread nicht gefunden.')
      partnerId ??= da.partner_id
    } else {
      const [neu] = await t<{ id: string }[]>`
        insert into mail_threads (betreff, partner_id, purchase_order_id, zustaendig_id, kanal, zugeordnet_durch)
        values (${p.betreff || null}, ${partnerId}, ${p.purchase_order_id ?? null},
                coalesce((select einkaeufer_id from partners where id = ${partnerId}), ${ctx.userId ?? null}::uuid),
                ${p.kanal}, ${partnerId ? 'mensch' : null})
        returning id`
      id = neu.id
    }
    const [partner] = partnerId
      ? await t<{ name: string; email: string | null }[]>`select name, email from partners where id = ${partnerId}`
      : []
    const [nachricht] = await t<{ id: string }[]>`
      insert into mail_nachrichten (thread_id, richtung, kanal, von, von_name, betreff, datum, text, quelle, erfasst_von)
      values (${id}, ${p.richtung}, ${p.kanal},
              ${p.richtung === 'eingang' ? (partner?.email ?? null) : null},
              ${p.richtung === 'eingang' ? (partner?.name ?? null) : ctx.actor},
              ${p.betreff || null}, ${datum}, ${p.text}, 'manuell', ${ctx.actor})
      returning id`
    // Auch ein von Hand erfasster Alibaba-Chat ist eine eingehende Nachricht:
    // der Einkaufs-Agent sichtet sie (0109; ohne eingeschaltete Ebene übersprungen).
    if (p.richtung === 'eingang') {
      await t`select enqueue_job('ki_mail_triage', ${t.json({ nachricht_id: nachricht.id })},
                                 ${`ki-triage:${nachricht.id}`})`
    }
    await t`
      update mail_threads set
        anzahl = anzahl + 1,
        letzte_richtung = case when letzte_am is null or ${datum} >= letzte_am then ${p.richtung}::mail_richtung
                               else letzte_richtung end,
        letzte_am = greatest(coalesce(letzte_am, ${datum}), ${datum}),
        status = case when ${p.richtung} = 'eingang' and status = 'erledigt' then 'offen'::mail_thread_status
                      else status end
      where id = ${id}`
    await t`select log_event('mail_thread', ${id}, 'info', ${`Nachricht erfasst (${p.kanal})`}, ${ctx.actor})`
    return id
  })
  return { text: 'Nachricht erfasst.', recordId: threadId, link: `/einkauf/posteingang/${threadId}` }
}

export async function wiedervorlageAnlegen(
  p: { modell: WiedervorlageModell; record_id: string; faellig_am: string; grund: string; zustaendig_id?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await belegPruefen(p.modell, p.record_id, ctx)
  const [w] = await sql<{ id: string }[]>`
    insert into wiedervorlagen (modell, record_id, faellig_am, grund, zustaendig_id, erstellt_von)
    values (${p.modell}, ${p.record_id}, ${p.faellig_am}, ${p.grund}, ${p.zustaendig_id ?? ctx.userId ?? null}, ${ctx.actor})
    returning id`
  await sql`select log_event(${p.modell}, ${p.record_id}, 'info', ${`Wiedervorlage ${p.faellig_am}: ${p.grund}`}, ${ctx.actor})`
  return { text: `Wiedervorlage für ${p.faellig_am.split('-').reverse().join('.')} angelegt.`, recordId: w.id }
}

export async function wiedervorlageErledigen(p: { wiedervorlage_id: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [w] = await sql<{ id: string; modell: string; record_id: string; grund: string }[]>`
    update wiedervorlagen set erledigt_am = now(), erledigt_von = ${ctx.actor}
    where id = ${p.wiedervorlage_id} and erledigt_am is null
    returning id, modell, record_id, grund`
  if (!w) throw new Error('Wiedervorlage nicht gefunden oder schon erledigt.')
  await sql`select log_event(${w.modell}, ${w.record_id}, 'info', ${`Wiedervorlage erledigt: ${w.grund}`}, ${ctx.actor})`
  return { text: 'Wiedervorlage erledigt.', recordId: w.id }
}

export async function postfachAbgleichenAusfuehren(_p: object, _ctx: AktionsKontext): Promise<AktionsErgebnis> {
  if (!postfachKonfiguriert()) {
    throw new Error('Das Einkaufspostfach ist nicht angebunden — GOOGLE_DIENSTKONTO_JSON und EINKAUF_POSTFACH setzen.')
  }
  const r = await postfachAbgleichen(20_000)
  const teile = [
    `${r.neu} neue Nachricht(en)`,
    r.zugeordnet ? `${r.zugeordnet} zugeordnet` : '',
    r.anhaenge ? `${r.anhaenge} Anhang/Anhänge zur Ablage eingereiht` : '',
    r.weiter ? 'weitere folgen beim nächsten Lauf' : '',
    r.rueckfall ? 'Verlauf war abgelaufen — die letzten 7 Tage neu gelesen' : '',
    r.fehler.length ? `${r.fehler.length} Fehler: ${r.fehler[0]}` : '',
  ].filter(Boolean)
  return { text: `Postfach abgeglichen: ${teile.join(', ')}.`, daten: { ...r } }
}
