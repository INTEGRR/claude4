import { createHash } from 'node:crypto'
import { sql, tx } from '@/db/client'
import { zielOrdner } from '@/modules/google/ablage'
import { driveKonfiguriert } from '@/modules/google/auth'
import { drive } from '@/modules/google/drive'
import { gmail } from '@/modules/google/gmail'
import { artAusDateiname, dokumentLesbarkeit } from './dokument-modelle.ts'
import { mailZerlegen } from './mail-zerlegen.ts'

/**
 * Outbox-Job `gmail_anhang_ablegen` (0093): ein Mail-Anhang wandert in die
 * Drive-Ablage — in den Ordner der Bestellung bzw. des Lieferanten des
 * Threads, ohne Zuordnung in „Eingang". Schickt ein Lieferant dieselbe
 * Datei zum dritten Mal (jede Antwort hängt die Zeichnung wieder an),
 * entsteht keine dritte Kopie: gleicher Inhalt (md5) beim selben
 * Lieferanten → das vorhandene Dokument wird nur verknüpft.
 */

export const POSTFACH_AKTEUR = 'Einkaufspostfach'

export async function anhangAblegen(anhangId: string): Promise<string> {
  const [a] = await sql<
    {
      id: string
      dateiname: string
      mime: string | null
      groesse: number | null
      gmail_attachment_id: string | null
      dokument_id: string | null
      gmail_message_id: string | null
      thread_id: string
      partner_id: string | null
      purchase_order_id: string | null
    }[]
  >`
    select a.id, a.dateiname, a.mime, a.groesse::float as groesse, a.gmail_attachment_id, a.dokument_id,
           n.gmail_message_id, n.thread_id, t.partner_id, t.purchase_order_id
    from mail_anhaenge a
    join mail_nachrichten n on n.id = a.nachricht_id
    join mail_threads t on t.id = n.thread_id
    where a.id = ${anhangId}`
  if (!a) return 'Anhang nicht mehr vorhanden'
  if (a.dokument_id) return 'Bereits abgelegt'
  if (!a.gmail_message_id || !a.gmail_attachment_id) return 'Kein Gmail-Anhang — nichts abzuholen'
  if (!driveKonfiguriert()) {
    throw new Error('Die Google-Ablage ist nicht angebunden — GOOGLE_EINKAUF_ABLAGE_ID setzen')
  }

  const api = await gmail()
  let bytes: Uint8Array
  try {
    bytes = await api.anhang(a.gmail_message_id, a.gmail_attachment_id)
  } catch (err) {
    // Gmail vergibt Anhang-IDs bei jedem Abruf neu; ist die gespeicherte
    // verfallen, holt ein frischer Abruf der Nachricht die aktuelle.
    const frisch = mailZerlegen((await api.nachricht(a.gmail_message_id)).payload).anhaenge.find(
      (x) => x.dateiname === a.dateiname && (a.groesse === null || x.groesse === a.groesse),
    )
    if (!frisch) throw err
    bytes = await api.anhang(a.gmail_message_id, frisch.attachmentId)
  }

  const md5 = createHash('md5').update(bytes).digest('hex')
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from dokumente
    where md5 = ${md5} and partner_id is not distinct from ${a.partner_id}
    order by created_at limit 1`

  let dokumentId: string
  let text: string
  if (vorhanden) {
    dokumentId = vorhanden.id
    text = `„${a.dateiname}" war schon abgelegt — verknüpft statt kopiert`
  } else {
    const ordner = await zielOrdner('mail_thread', a.thread_id)
    const datei = await (await drive()).dateiHochladen({
      name: a.dateiname,
      mime: a.mime || 'application/octet-stream',
      bytes,
      elternId: ordner,
    })
    const [d] = await sql<{ id: string }[]>`
      insert into dokumente (drive_file_id, name, mime, groesse, md5, art, quelle, partner_id, hochgeladen_von)
      values (${datei.id}, ${a.dateiname}, ${a.mime || 'application/octet-stream'}, ${bytes.byteLength},
              ${datei.md5Checksum ?? md5}, ${artAusDateiname(a.dateiname)}, 'mail', ${a.partner_id}, ${POSTFACH_AKTEUR})
      on conflict (drive_file_id) do update set updated_at = now()
      returning id`
    dokumentId = d.id
    text = `„${a.dateiname}" abgelegt`
  }

  await tx(async (t) => {
    const ziele: [string, string | null][] = [
      ['mail_thread', a.thread_id],
      ['partner', a.partner_id],
      ['purchase_order', a.purchase_order_id],
    ]
    for (const [modell, id] of ziele) {
      if (!id) continue
      await t`insert into dokument_verweise (dokument_id, modell, record_id, verknuepft_von)
              values (${dokumentId}, ${modell}, ${id}, ${POSTFACH_AKTEUR})
              on conflict do nothing`
    }
    await t`update mail_anhaenge set dokument_id = ${dokumentId}, fehler = null where id = ${a.id}`
    // Einkaufs-Agent (0109): PDFs und Bilder liest die KI-Spur (Excel wird
    // dort „nicht lesbar"); schon gelesene überspringt der Job selbst.
    if (dokumentLesbarkeit(a.mime, a.dateiname) !== 'nicht_lesbar') {
      await t`select enqueue_job('ki_dokument_lesen', ${t.json({ dokument_id: dokumentId })}, ${`ki-dokument:${dokumentId}`})`
    }
  })
  return text
}
