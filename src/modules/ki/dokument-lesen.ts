import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import { drive } from '../google/drive.ts'
import { einkaufKiBereit } from './einkauf-ki.ts'
import {
  type DokumentErgebnis,
  dokumentAuftrag,
  dokumentErgebnisLesen,
  dokumentLesbarkeit,
  fakeDokumentAntwort,
  staffelnZuordnen,
  vorschlagEingabeLesen,
} from './einkauf-prompt.ts'
import { type AgentLauf, neuerLauf, vorschlagSpeichern } from './einkauf-werkzeuge.ts'
import { kiModell } from './modelle.ts'
import { kiFake } from './uebersetzen.ts'

/**
 * Dokument-Leser des Einkaufs (0109), Outbox-Job `ki_dokument_lesen`:
 * PDFs und Bilder gehen direkt an Claude (Dokument- bzw. Bild-Block im
 * selben Aufrufweg wie agent.ts/uebersetzen.ts), das Ergebnis steht danach
 * in `dokumente.text_auszug` (durchsuchbar über `dokumente.suche`).
 *
 * Erkennt Claude ein Angebot mit Staffeln und hängt das Dokument an einem
 * Einkaufsprojekt mit Lieferant, entsteht der Vorschlag „Angebot erfassen";
 * ist die Art noch „Sonstiges", der Vorschlag, sie zu setzen. Angelegt wird
 * auch hier nichts außer Vorschlägen.
 *
 * Excel: KRNL hat keinen Tabellen-Parser, eine neue Abhängigkeit kommt
 * dafür nicht hinein (Entscheidungslog 2026-10-01) — Excel-Dateien werden
 * als „nicht lesbar" markiert.
 */

/** Größer schicken wir nicht (Claude nimmt 32 MB je Anfrage, base64 bläht um ein Drittel auf). */
const MAX_BYTES = 20 * 1024 * 1024
const MAX_TEXT = 100_000

type Lesestatus = 'gelesen' | 'nicht_lesbar' | 'fehler'

async function statusSetzen(id: string, status: Lesestatus, text?: string | null): Promise<void> {
  await sql`
    update dokumente set text_status = ${status}, text_gelesen_am = now(),
                         text_auszug = coalesce(${text ?? null}, text_auszug)
    where id = ${id}`
}

export async function dokumentKiLesen(dokumentId: string): Promise<string> {
  const bereit = await einkaufKiBereit(sql)
  if (!bereit.ok) return `Übersprungen — ${bereit.grund}`

  const [d] = await sql<
    { id: string; name: string; mime: string | null; groesse: number | null; drive_file_id: string; art: string; text_status: string | null; partner_id: string | null }[]
  >`
    select id, name, mime, groesse::float as groesse, drive_file_id, art::text as art, text_status, partner_id
    from dokumente where id = ${dokumentId}`
  if (!d) return 'Dokument nicht mehr vorhanden'
  if (d.text_status === 'gelesen') return 'Schon gelesen'

  const lesbar = dokumentLesbarkeit(d.mime, d.name)
  if (lesbar === 'excel') {
    await statusSetzen(d.id, 'nicht_lesbar')
    return 'Excel ist nicht lesbar — KRNL hat (noch) keinen Tabellen-Parser'
  }
  if (lesbar === 'nicht_lesbar') {
    await statusSetzen(d.id, 'nicht_lesbar')
    return `Übersprungen — ${d.mime ?? 'unbekannter Dateityp'} wird nicht gelesen`
  }
  if ((d.groesse ?? 0) > MAX_BYTES) {
    await statusSetzen(d.id, 'nicht_lesbar')
    return 'Übersprungen — Datei größer als 20 MB'
  }

  // Wo hängt das Dokument? Projekt (für Angebote), Thread, Bestellung.
  const verweise = await sql<{ modell: string; record_id: string }[]>`
    select modell, record_id from dokument_verweise where dokument_id = ${d.id}`
  const threadId = verweise.find((v) => v.modell === 'mail_thread')?.record_id ?? null
  const [thread] = threadId
    ? await sql<{ partner_id: string | null; einkaufsprojekt_id: string | null; purchase_order_id: string | null }[]>`
        select partner_id, einkaufsprojekt_id, purchase_order_id from mail_threads where id = ${threadId}`
    : []
  const projektId = verweise.find((v) => v.modell === 'einkaufsprojekt')?.record_id ?? thread?.einkaufsprojekt_id ?? null
  const partnerId = d.partner_id ?? thread?.partner_id ?? null
  const positionen = projektId
    ? await sql<{ id: string; bezeichnung: string }[]>`
        select id, coalesce(bezeichnung, case when variant_id is not null then variant_display_name(variant_id) end, '') as bezeichnung
        from einkaufsprojekt_positionen where projekt_id = ${projektId} order by sequence, created_at`
    : []

  const bytes = await (await drive()).dateiInhalt(d.drive_file_id)
  const fake = kiFake()
  const modell = fake ? 'fake' : await kiModell(sql, 'einkauf')
  let antwortText: string
  let input = 0
  let output = 0
  let cacheLesen = 0
  let cacheSchreiben = 0
  if (fake) {
    antwortText = fakeDokumentAntwort(bytes, d.name)
  } else {
    const daten = Buffer.from(bytes).toString('base64')
    const anhang: Anthropic.Messages.ContentBlockParam =
      lesbar === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: daten } }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (d.mime ?? 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: daten,
            },
          }
    try {
      // Eine Anfrage, höchstens 40 s (Start in den ersten 15 s der KI-Spur → unter 60 s).
      const antwort = await new Anthropic({ timeout: 40_000, maxRetries: 0 }).messages.create({
        model: modell,
        max_tokens: 8000,
        messages: [
          {
            role: 'user',
            content: [anhang, { type: 'text', text: dokumentAuftrag({ name: d.name, art: d.art, positionen: positionen.map((p) => p.bezeichnung) }) }],
          },
        ],
      })
      antwortText = antwort.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      input = antwort.usage.input_tokens ?? 0
      output = antwort.usage.output_tokens ?? 0
      cacheLesen = antwort.usage.cache_read_input_tokens ?? 0
      cacheSchreiben = antwort.usage.cache_creation_input_tokens ?? 0
    } catch (err) {
      const status = err instanceof Anthropic.APIError ? err.status : undefined
      // Kaputtes oder abgelehntes PDF: als Fehler am Dokument, kein Endlos-Wiederholen.
      if (status !== undefined && [400, 413, 422].includes(status)) {
        await statusSetzen(d.id, 'fehler')
        return `Nicht lesbar (${status}) — ${err instanceof Error ? err.message.slice(0, 200) : ''}`
      }
      throw err
    }
  }

  await sql`
    insert into ki_verbrauch (ebene, modell, zweck, modell_bezug, record_id, input_tokens, output_tokens,
                              cache_lesen_tokens, cache_schreiben_tokens)
    values ('einkauf', ${modell}, 'dokument_lesen', 'dokument', ${d.id}, ${input}, ${output}, ${cacheLesen}, ${cacheSchreiben})`

  const ergebnis = dokumentErgebnisLesen(antwortText)
  const text = [ergebnis.zusammenfassung, ergebnis.text].filter(Boolean).join('\n\n').slice(0, MAX_TEXT)
  await statusSetzen(d.id, 'gelesen', text || '(kein Text erkannt)')

  const lauf = neuerLauf({
    quelle: 'dokument',
    quelleId: d.id,
    modell,
    threadId,
    partnerId,
    einkaufsprojektId: projektId,
    purchaseOrderId: thread?.purchase_order_id ?? null,
  })
  const vorschlaege = await vorschlaegeAusDokument(ergebnis, { d, projektId, partnerId, positionen, lauf })
  return `Gelesen (${text.length} Zeichen)${vorschlaege.length ? ` — ${vorschlaege.join('; ')}` : ''}`
}

/** Vorschläge aus dem Gelesenen: Art setzen, Angebot erfassen. Fehler sind Hinweise, kein Abbruch. */
async function vorschlaegeAusDokument(
  ergebnis: DokumentErgebnis,
  c: {
    d: { id: string; name: string; art: string }
    projektId: string | null
    partnerId: string | null
    positionen: { id: string; bezeichnung: string }[]
    lauf: AgentLauf
  },
): Promise<string[]> {
  const meldungen: string[] = []
  const beleg = [{ art: 'dokument', id: c.d.id, titel: c.d.name }]
  const anlegen = async (roh: Record<string, unknown>) => {
    const g = vorschlagEingabeLesen(roh)
    if (!g.ok) {
      meldungen.push(`kein Vorschlag: ${g.fehler}`)
      return
    }
    try {
      meldungen.push(await vorschlagSpeichern(g.wert, c.lauf))
    } catch (err) {
      meldungen.push(`kein Vorschlag: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (ergebnis.art && ergebnis.art !== 'sonstiges' && c.d.art === 'sonstiges') {
    await anlegen({
      aktion: 'einkauf.dokument_aendern',
      parameter: { dokument_id: c.d.id, art: ergebnis.art },
      begruendung: `Der Dokument-Leser hat „${c.d.name}" als ${ergebnis.art} erkannt${ergebnis.zusammenfassung ? ` (${ergebnis.zusammenfassung})` : ''}.`,
      belege: beleg,
    })
  }

  const angebot = ergebnis.angebot
  if (angebot && c.projektId && c.partnerId) {
    const staffeln = staffelnZuordnen(angebot.staffeln, c.positionen)
    if (!staffeln) {
      meldungen.push('Angebot erkannt, aber die Staffeln passen nicht eindeutig zu den Projektpositionen')
    } else {
      await anlegen({
        aktion: 'einkauf.angebot_erfassen',
        titel: `Angebot aus „${c.d.name}": ${staffeln.map((s) => `${s.ab_menge} × ${s.preis} ${angebot.waehrung ?? 'USD'}`).join(', ')}`.slice(0, 200),
        record_id: c.projektId,
        parameter: {
          partner_id: c.partnerId,
          waehrung: angebot.waehrung ?? 'USD',
          ...(angebot.moq ? { moq: angebot.moq } : {}),
          ...(angebot.incoterm ? { incoterm_code: angebot.incoterm } : {}),
          ...(angebot.lieferzeit_tage ? { lieferzeit_tage: Math.round(angebot.lieferzeit_tage) } : {}),
          quell_dokument_id: c.d.id,
          staffeln,
        },
        begruendung:
          `„${c.d.name}" enthält ein Angebot: ` +
          angebot.staffeln.map((s) => `${s.ab_menge} Stück zu ${s.preis} ${angebot.waehrung ?? '(Währung unklar)'}`).join(', ') +
          (angebot.moq ? `, MOQ ${angebot.moq}` : '') +
          (angebot.waehrung ? '.' : ' — Währung bitte prüfen (angenommen USD).'),
        belege: beleg,
      })
    }
  }
  return meldungen
}
