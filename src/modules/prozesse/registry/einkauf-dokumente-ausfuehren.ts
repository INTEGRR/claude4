import { sql, tx } from '@/db/client'
import { canAccess } from '@/modules/auth/permissions'
import {
  DOKUMENT_MODELLE,
  type DokumentArt,
  type DokumentModell,
  STUECK_BYTES,
  artAusDateiname,
} from '@/modules/einkauf/dokument-modelle'
import { ablageEinrichten, zielOrdner } from '@/modules/google/ablage'
import { driveKonfiguriert } from '@/modules/google/auth'
import { drive } from '@/modules/google/drive'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 1 (0092): Ablage, Upload, Dokumentenindex, Lieferantenakte. */

function ablageBereit() {
  if (!driveKonfiguriert()) {
    throw new Error(
      'Die Google-Ablage ist nicht angebunden — GOOGLE_DIENSTKONTO_JSON und GOOGLE_EINKAUF_ABLAGE_ID setzen (Einstellungen → Schnittstellen).',
    )
  }
}

/** Beleg existiert und der Nutzer darf dessen Bereich sehen. */
export async function belegPruefen(modell: DokumentModell, recordId: string, ctx: AktionsKontext) {
  const ziel = DOKUMENT_MODELLE[modell]
  if (!canAccess(ctx.rollen ?? ctx.role, ziel.bereich)) {
    throw new Error(`Für ${ziel.label} fehlt Ihrer Rolle die Berechtigung.`)
  }
  const [da] = await sql`select 1 from ${sql(ziel.tabelle)} where id = ${recordId}`
  if (!da) throw new Error(`${ziel.label} existiert nicht (mehr).`)
}

export async function ablageEinrichtenAusfuehren(_p: object, _ctx: AktionsKontext): Promise<AktionsErgebnis> {
  ablageBereit()
  const namen = await ablageEinrichten()
  return { text: `Einkaufsablage bereit: ${namen.join(', ')}.` }
}

export async function uploadVorbereiten(
  p: {
    name: string
    mime?: string
    groesse: number
    modell: DokumentModell
    record_id: string
    art?: DokumentArt
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  ablageBereit()
  await belegPruefen(p.modell, p.record_id, ctx)
  const ordner = await zielOrdner(p.modell, p.record_id)
  const mime = p.mime || 'application/octet-stream'
  const api = await drive()
  const uri = await api.uploadSitzungAnlegen({ name: p.name, mime, groesse: p.groesse, elternId: ordner })
  const [s] = await sql<{ id: string }[]>`
    insert into upload_sitzungen (session_uri, name, mime, groesse, ordner_id, modell, record_id, art, erstellt_von)
    values (${uri}, ${p.name}, ${mime}, ${p.groesse}, ${ordner}, ${p.modell}, ${p.record_id},
            ${p.art ?? artAusDateiname(p.name)}, ${ctx.actor})
    returning id`
  return {
    text: `Upload „${p.name}" vorbereitet.`,
    recordId: s.id,
    daten: { sitzung_id: s.id, stueck_bytes: STUECK_BYTES },
  }
}

export async function dokumentRegistrieren(
  p: { sitzung_id: string; drive_file_id: string; revision?: string; notiz?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  ablageBereit()
  const [s] = await sql<
    {
      id: string
      name: string
      groesse: number
      ordner_id: string
      modell: DokumentModell
      record_id: string
      art: DokumentArt
      erstellt_von: string
      abgeschlossen_am: string | null
    }[]
  >`select id, name, groesse::float as groesse, ordner_id, modell, record_id, art::text as art,
           erstellt_von, abgeschlossen_am::text as abgeschlossen_am
    from upload_sitzungen where id = ${p.sitzung_id}`
  if (!s) throw new Error('Upload-Sitzung nicht gefunden.')
  if (s.erstellt_von !== ctx.actor) throw new Error('Diese Upload-Sitzung gehört einem anderen Benutzer.')
  if (s.abgeschlossen_am) throw new Error('Dieser Upload ist bereits übernommen.')

  // Nie der ID aus dem Browser glauben: Google muss die Datei in genau
  // diesem Ordner mit genau dieser Größe kennen.
  const api = await drive()
  const datei = await api.dateiLesen(p.drive_file_id)
  if (!datei.parents?.includes(s.ordner_id)) {
    throw new Error('Die Datei liegt nicht im Ordner dieses Uploads.')
  }
  if (datei.size !== undefined && Number(datei.size) !== Number(s.groesse)) {
    throw new Error(`Die Datei ist unvollständig angekommen (${datei.size} von ${s.groesse} Bytes).`)
  }

  const partnerId = await partnerZumBeleg(s.modell, s.record_id)
  const dokId = await tx(async (t) => {
    const [d] = await t<{ id: string }[]>`
      insert into dokumente (drive_file_id, name, mime, groesse, md5, art, revision, quelle,
                             partner_id, notiz, hochgeladen_von)
      values (${datei.id}, ${datei.name}, ${datei.mimeType}, ${Number(datei.size ?? s.groesse)},
              ${datei.md5Checksum ?? null}, ${s.art}, ${p.revision || null}, 'upload',
              ${partnerId}, ${p.notiz || null}, ${ctx.actor})
      on conflict (drive_file_id) do update set updated_at = now()
      returning id`
    await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
            values (${d.id}, ${s.modell}, ${s.record_id}, ${ctx.actor})
            on conflict do nothing`
    await t`update upload_sitzungen set drive_file_id = ${datei.id}, abgeschlossen_am = now()
            where id = ${s.id}`
    await t`select log_event(${s.modell}, ${s.record_id}, 'info', ${`Dokument „${datei.name}" hinzugefügt`}, ${ctx.actor})`
    return d.id
  })
  return { text: `„${datei.name}" abgelegt.`, recordId: dokId }
}

/** Lieferant eines Belegs — damit die Lieferantenakte alle seine Dateien zeigt. */
export async function partnerZumBeleg(modell: DokumentModell, recordId: string): Promise<string | null> {
  if (modell === 'partner') return recordId
  if (modell === 'purchase_order') {
    const [r] = await sql<{ vendor_id: string }[]>`select vendor_id from purchase_orders where id = ${recordId}`
    return r?.vendor_id ?? null
  }
  if (modell === 'vendor_bill') {
    const [r] = await sql<{ vendor_id: string }[]>`select vendor_id from vendor_bills where id = ${recordId}`
    return r?.vendor_id ?? null
  }
  if (modell === 'mail_thread') {
    const [r] = await sql<{ partner_id: string | null }[]>`select partner_id from mail_threads where id = ${recordId}`
    return r?.partner_id ?? null
  }
  return null
}

export async function dokumentVerknuepfen(
  p: { dokument_id: string; modell: DokumentModell; record_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await belegPruefen(p.modell, p.record_id, ctx)
  const [d] = await sql<{ name: string }[]>`select name from dokumente where id = ${p.dokument_id}`
  if (!d) throw new Error('Dokument nicht gefunden.')
  await sql`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
            values (${p.dokument_id}, ${p.modell}, ${p.record_id}, ${ctx.actor})
            on conflict do nothing`
  await sql`select log_event(${p.modell}, ${p.record_id}, 'info', ${`Dokument „${d.name}" verknüpft`}, ${ctx.actor})`
  return { text: `„${d.name}" verknüpft.`, recordId: p.dokument_id }
}

export async function dokumentLoesen(
  p: { dokument_id: string; modell: DokumentModell; record_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await belegPruefen(p.modell, p.record_id, ctx)
  const geloest = await sql<{ name: string }[]>`
    delete from dokument_verweise v using dokumente d
    where v.dokument_id = d.id and v.dokument_id = ${p.dokument_id}
      and v.modell = ${p.modell} and v.record_id = ${p.record_id}
    returning d.name`
  if (geloest.length === 0) throw new Error('Diese Verknüpfung gibt es nicht.')
  await sql`select log_event(${p.modell}, ${p.record_id}, 'info', ${`Dokument „${geloest[0].name}" gelöst`}, ${ctx.actor})`
  return { text: `„${geloest[0].name}" gelöst — die Datei bleibt in der Ablage.` }
}

export async function dokumentAendern(
  p: { dokument_id: string; art?: DokumentArt; revision?: string; notiz?: string },
  _ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [d] = await sql<{ name: string }[]>`
    update dokumente set
      art = coalesce(${p.art ?? null}::dokument_art, art),
      revision = case when ${p.revision !== undefined} then nullif(${p.revision ?? ''}, '') else revision end,
      notiz = case when ${p.notiz !== undefined} then nullif(${p.notiz ?? ''}, '') else notiz end
    where id = ${p.dokument_id}
    returning name`
  if (!d) throw new Error('Dokument nicht gefunden.')
  return { text: `„${d.name}" gespeichert.`, recordId: p.dokument_id }
}

export async function lieferantendatenSetzen(
  p: {
    sprache?: 'de' | 'en' | 'zh'
    mail_domains: string[]
    einkaeufer_id?: string
    standard_incoterm?: string
    standard_waehrung?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const domains = [...new Set(p.mail_domains)]
  // Eine Maildomain gehört genau einem Lieferanten — sonst wäre die
  // automatische Zuordnung eingehender Mails mehrdeutig.
  const belegt = await sql<{ name: string; domain: string }[]>`
    select p.name, d as domain from partners p, unnest(p.mail_domains) d
    where p.id <> ${ctx.recordId!} and d = any(${domains}::text[])`
  if (belegt.length > 0) {
    throw new Error(
      `Maildomain schon vergeben: ${belegt.map((b) => `${b.domain} (${b.name})`).join(', ')}.`,
    )
  }
  const [r] = await sql<{ name: string }[]>`
    update partners set
      is_vendor = true,
      sprache = ${p.sprache ?? null},
      mail_domains = ${domains}::text[],
      einkaeufer_id = ${p.einkaeufer_id ?? null},
      standard_incoterm = ${p.standard_incoterm ?? null},
      standard_waehrung = ${p.standard_waehrung ?? null}
    where id = ${ctx.recordId!}
    returning name`
  if (!r) throw new Error('Kontakt nicht gefunden.')
  return { text: `Einkaufsdaten von „${r.name}" gespeichert.`, recordId: ctx.recordId }
}
