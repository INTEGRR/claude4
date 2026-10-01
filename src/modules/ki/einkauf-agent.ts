import Anthropic from '@anthropic-ai/sdk'
import { sql } from '@/db/client'
import { zitatTrennen } from '../einkauf/mail-zerlegen.ts'
import { einkaufKiBereit } from './einkauf-ki.ts'
import {
  EINKAUF_AGENT_WERKZEUGE,
  type TriageKontext,
  fakeTriageZug,
  systemPromptEinkauf,
  triageAuftrag,
} from './einkauf-prompt.ts'
import { AGENT_AKTEUR, type AgentLauf, neuerLauf, werkzeugAusfuehren } from './einkauf-werkzeuge.ts'
import { kiModell } from './modelle.ts'
import { SCHEMA_DOKU } from './schema-doku.ts'
import { kiFake } from './uebersetzen.ts'

/**
 * Einkaufs-Agent (0109): sichtet jede eingehende Nachricht (Outbox-Job
 * `ki_mail_triage`, eigene Spur „ki"). Claude bekommt den Vorgang als
 * Kontext und die Werkzeuge aus einkauf-prompt.ts — lesen darf er viel,
 * anlegen nur Vorschläge und einen Antwort-Entwurf. Gesendet, gebucht,
 * freigegeben oder entschieden wird hier nichts.
 *
 * Aufrufweg wie im Chat-Agenten (agent.ts) und bei der Übersetzung
 * (uebersetzen.ts): dasselbe SDK, Modell je Ebene aus den Einstellungen
 * (modelle.ts, Ebene „einkauf"), Token in ki_verbrauch. KI_FAKE=1 ersetzt
 * Claude durch deterministische Werkzeugaufrufe (fakeTriageZug).
 */

const MAX_RUNDEN = 6
/**
 * Vercel beendet die Cron-Funktion nach 60 s: die KI-Spur beginnt Jobs nur in
 * den ersten 15 s (KI_SPUR_BUDGET_MS), ein Lauf startet nach 20 s keine neue
 * Modellrunde mehr, jede Anfrage darf 25 s dauern — zusammen unter 60 s.
 * Wiederholt wird über die Outbox (Backoff), nicht im SDK.
 */
export const TRIAGE_BUDGET_MS = 20_000
const MAX_TEXT = 12_000

interface Verbrauch {
  input: number
  output: number
  cacheLesen: number
  cacheSchreiben: number
}

/** „1 Vorschlag", „2 Vorschläge". */
const anzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`

/** Haiku kennt kein adaptives Denken — dort ohne `thinking`. */
function denken(modell: string): { thinking?: { type: 'adaptive' } } {
  return modell.includes('haiku') ? {} : { thinking: { type: 'adaptive' } }
}

/** Den Vorgang zur Nachricht laden — Thread, Zuordnung, Projektpositionen, offene Vorschläge. */
export async function triageKontextLaden(nachrichtId: string): Promise<
  | { kontext: TriageKontext; richtung: string; gesichtet: boolean; threadStatus: string; erstelltAm: string }
  | null
> {
  const [n] = await sql<
    {
      id: string
      thread_id: string
      richtung: string
      kanal: string
      von: string | null
      von_name: string | null
      betreff: string | null
      datum: string
      text: string | null
      sprache: string | null
      ki_gesichtet_am: string | null
      created_at: string
    }[]
  >`
    select id, thread_id, richtung::text as richtung, kanal::text as kanal, von, von_name, betreff, datum::text as datum,
           text, sprache, ki_gesichtet_am::text as ki_gesichtet_am, created_at::text as created_at
    from mail_nachrichten where id = ${nachrichtId}`
  if (!n) return null
  const [t] = await sql<
    {
      id: string
      betreff: string | null
      status: string
      zugeordnet_durch: string | null
      anzahl: number
      partner_id: string | null
      lieferant: string | null
      sprache: string | null
      purchase_order_id: string | null
      bestellung: string | null
      bestellstatus: string | null
      einkaufsprojekt_id: string | null
      projekt_nummer: string | null
      projekt_titel: string | null
      projekt_status: string | null
    }[]
  >`
    select t.id, t.betreff, t.status::text as status, t.zugeordnet_durch::text as zugeordnet_durch, t.anzahl,
           t.partner_id, p.name as lieferant, p.sprache, t.purchase_order_id, po.number as bestellung,
           po.state::text as bestellstatus, t.einkaufsprojekt_id, ep.nummer as projekt_nummer, ep.titel as projekt_titel,
           ep.status::text as projekt_status
    from mail_threads t
    left join partners p on p.id = t.partner_id
    left join purchase_orders po on po.id = t.purchase_order_id
    left join einkaufsprojekte ep on ep.id = t.einkaufsprojekt_id
    where t.id = ${n.thread_id}`
  const positionen = t?.einkaufsprojekt_id
    ? await sql<{ id: string; bezeichnung: string; menge: number; zielpreis_eur: number | null }[]>`
        select id, coalesce(bezeichnung, case when variant_id is not null then variant_display_name(variant_id) end, '') as bezeichnung,
               menge::float as menge, zielpreis_eur::float as zielpreis_eur
        from einkaufsprojekt_positionen where projekt_id = ${t.einkaufsprojekt_id} order by sequence, created_at`
    : []
  const anhaenge = await sql<{ dateiname: string; dokument_id: string | null; text_status: string | null }[]>`
    select a.dateiname, a.dokument_id, d.text_status
    from mail_anhaenge a left join dokumente d on d.id = a.dokument_id
    where a.nachricht_id = ${n.id} order by a.created_at`
  const offen = await sql<{ aktion: string; titel: string; record_id: string | null }[]>`
    select aktion, titel, record_id from ki_vorschlaege
    where thread_id = ${n.thread_id} and status in ('offen', 'fehler') order by erstellt_am`
  const [{ entwuerfe }] = await sql<{ entwuerfe: number }[]>`
    select count(*)::int as entwuerfe from mail_entwuerfe where thread_id = ${n.thread_id} and status = 'entwurf'`

  const neu = zitatTrennen(n.text ?? '').neu
  const kontext: TriageKontext = {
    heute: new Date().toISOString().slice(0, 10),
    nachricht: {
      id: n.id,
      von: n.von,
      von_name: n.von_name,
      betreff: n.betreff,
      datum: n.datum,
      kanal: n.kanal,
      sprache: n.sprache,
      text: neu.length > MAX_TEXT ? `${neu.slice(0, MAX_TEXT)} … [gekürzt]` : neu,
      anhaenge,
    },
    thread: {
      id: n.thread_id,
      betreff: t?.betreff ?? null,
      status: t?.status ?? 'offen',
      zugeordnet_durch: t?.zugeordnet_durch ?? null,
      anzahl: t?.anzahl ?? 1,
      partner: t?.partner_id ? { id: t.partner_id, name: t.lieferant ?? '', sprache: t.sprache } : null,
      bestellung: t?.purchase_order_id ? { id: t.purchase_order_id, number: t.bestellung ?? '', state: t.bestellstatus ?? '' } : null,
      projekt: t?.einkaufsprojekt_id
        ? {
            id: t.einkaufsprojekt_id,
            nummer: t.projekt_nummer ?? '',
            titel: t.projekt_titel ?? '',
            status: t.projekt_status ?? '',
            positionen: [...positionen],
          }
        : null,
    },
    offene_vorschlaege: [...offen],
    offene_entwuerfe: entwuerfe,
  }
  return {
    kontext,
    richtung: n.richtung,
    gesichtet: Boolean(n.ki_gesichtet_am),
    threadStatus: t?.status ?? 'offen',
    erstelltAm: n.created_at,
  }
}

/** Synthetische Modellantwort für KI_FAKE — dieselbe Form wie von Claude. */
function fakeAntwort(runde: number, kontext: TriageKontext): Anthropic.Messages.Message {
  const aufrufe = fakeTriageZug(runde, kontext)
  const content = aufrufe
    ? aufrufe.map((a, i) => ({ type: 'tool_use', id: `fake_${runde}_${i}`, name: a.name, input: a.input }))
    : [{ type: 'text', text: 'Gesichtet (Fake).' }]
  return {
    id: `fake_${runde}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content,
    stop_reason: aufrufe ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Messages.Message
}

/**
 * Eine eingehende Nachricht sichten. Ergebnis ist der Text für die Outbox;
 * „Übersprungen — …" heißt erledigt ohne Lauf (Ebene aus, kein Schlüssel,
 * Monatsgrenze, ausgehende Nachricht, ignorierter Thread, schon gesichtet).
 */
export async function mailTriage(nachrichtId: string, budgetMs = TRIAGE_BUDGET_MS): Promise<string> {
  const beginn = Date.now()
  const bereit = await einkaufKiBereit(sql)
  if (!bereit.ok) return `Übersprungen — ${bereit.grund}`

  const geladen = await triageKontextLaden(nachrichtId)
  if (!geladen) return 'Nachricht nicht mehr vorhanden'
  if (geladen.richtung !== 'eingang') return 'Übersprungen — keine eingehende Nachricht'
  if (geladen.gesichtet) return 'Schon gesichtet'
  if (geladen.threadStatus === 'ignoriert') return 'Übersprungen — der Thread ist auf „ignoriert" gesetzt'

  const { kontext } = geladen
  const fake = kiFake()
  const modell = fake ? 'fake' : await kiModell(sql, 'einkauf')
  const lauf: AgentLauf = neuerLauf({
    quelle: 'mail_nachricht',
    quelleId: nachrichtId,
    modell,
    threadId: kontext.thread.id,
    partnerId: kontext.thread.partner?.id ?? null,
    einkaufsprojektId: kontext.thread.projekt?.id ?? null,
    purchaseOrderId: kontext.thread.bestellung?.id ?? null,
    nachrichtAm: geladen.erstelltAm,
    standardSprache: kontext.thread.partner?.sprache ?? null,
  })

  const verbrauch: Verbrauch = { input: 0, output: 0, cacheLesen: 0, cacheSchreiben: 0 }
  const client = fake ? null : new Anthropic({ timeout: 25_000, maxRetries: 0 })
  const system = systemPromptEinkauf(SCHEMA_DOKU)
  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: triageAuftrag(kontext) }]
  let abschluss = ''
  let fehler: string | null = null

  try {
    for (let runde = 0; runde < MAX_RUNDEN; runde++) {
      if (Date.now() - beginn > budgetMs) {
        lauf.hinweise.push('Zeitbudget erreicht')
        break
      }
      const antwort = client
        ? await client.messages.create({
            model: modell,
            max_tokens: 8000,
            ...denken(modell),
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            tools: EINKAUF_AGENT_WERKZEUGE,
            messages,
          })
        : fakeAntwort(runde, kontext)
      verbrauch.input += antwort.usage.input_tokens ?? 0
      verbrauch.output += antwort.usage.output_tokens ?? 0
      verbrauch.cacheLesen += antwort.usage.cache_read_input_tokens ?? 0
      verbrauch.cacheSchreiben += antwort.usage.cache_creation_input_tokens ?? 0

      if (antwort.stop_reason === 'refusal') {
        lauf.hinweise.push('Modell hat abgelehnt')
        break
      }
      if (antwort.stop_reason !== 'tool_use') {
        abschluss = antwort.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim()
        break
      }
      // Assistent-Blöcke (inkl. Denk-Blöcken) unverändert zurück — Pflicht bei Werkzeugen mit Denken.
      messages.push({ role: 'assistant', content: antwort.content })
      const ergebnisse: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const block of antwort.content) {
        if (block.type !== 'tool_use') continue
        const r = await werkzeugAusfuehren(block.name, block.input, lauf)
        ergebnisse.push({ type: 'tool_result', tool_use_id: block.id, content: r.text, ...(r.fehler ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: ergebnisse })
    }
  } catch (err) {
    // Dauerhafte Fehler (Anfrage ungültig, Schlüssel falsch, Modell unbekannt)
    // nicht zehnmal wiederholen — sie kosten nur. Netz, Überlast und
    // Ratenlimit wirft der Job weiter: Backoff und neuer Versuch.
    const status = err instanceof Anthropic.APIError ? err.status : undefined
    if (status !== undefined && [400, 401, 403, 404, 413, 422].includes(status)) {
      fehler = `${status}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
    } else {
      await verbrauchSchreiben(modell, nachrichtId, verbrauch)
      throw err
    }
  }

  await verbrauchSchreiben(modell, nachrichtId, verbrauch)
  await sql`update mail_nachrichten set ki_gesichtet_am = now() where id = ${nachrichtId}`
  const text =
    `KI-Agent hat gesichtet: ${anzahl(lauf.vorschlaege.length, 'Vorschlag', 'Vorschläge')}, ${anzahl(lauf.entwuerfe.length, 'Entwurf', 'Entwürfe')}` +
    (lauf.hinweise.length ? ` (${lauf.hinweise.join(', ')})` : '') +
    (fehler ? ` — Fehler ${fehler}` : '')
  await sql`select log_event('mail_thread', ${kontext.thread.id}, ${fehler ? 'error' : 'info'}, ${text}, ${AGENT_AKTEUR})`
  return abschluss ? `${text}. ${abschluss.slice(0, 300)}` : text
}

async function verbrauchSchreiben(modell: string, nachrichtId: string, v: Verbrauch): Promise<void> {
  await sql`
    insert into ki_verbrauch (ebene, modell, zweck, modell_bezug, record_id, input_tokens, output_tokens,
                              cache_lesen_tokens, cache_schreiben_tokens)
    values ('einkauf', ${modell}, 'mail_triage', 'mail_nachricht', ${nachrichtId}, ${v.input}, ${v.output},
            ${v.cacheLesen}, ${v.cacheSchreiben})`
}
