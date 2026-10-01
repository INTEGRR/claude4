import { sql } from '@/db/client'
import { betreffKern, zitatTrennen } from '../einkauf/mail-zerlegen.ts'
import { registrierteAktion } from '../prozesse/registry/index.ts'
import { UUID_MUSTER } from '../prozesse/registry/typen.ts'
import {
  type VorschlagEingabe,
  type WerkzeugName,
  entwurfEingabeLesen,
  vorschlagEingabeLesen,
} from './einkauf-prompt.ts'
import { FINANZ_SPERRE, ergebnisFuerModell, runReadOnlyQuery } from './sql-tool.ts'

/**
 * Die Werkzeuge des Einkaufs-Agenten (0109), ausführender Teil. Der Katalog
 * (Namen, Schemas) steht in einkauf-prompt.ts; `satisfies Record<WerkzeugName,
 * …>` hält beide deckungsgleich.
 *
 * Lesend: SQL (dasselbe Werkzeug wie der Chat-Agent — Read-only-Transaktion,
 * Sperrliste, dazu IMMER die Finanzsperre: der Agent läuft ohne Benutzer,
 * seine Vorschläge sieht jeder im Einkauf), Thread, Lieferantenakte,
 * Projekt, Dokument.
 *
 * Schreibend genau zwei Tabellen (geschlossene Allowlist im Wächter
 * tests/prozess-registry.test.ts): `ki_vorschlaege` und `mail_entwuerfe`
 * mit quelle 'agent' und Status 'entwurf'. Kein Senden, keine Freigabe,
 * kein Aufruf einer Registry-Aktion, kein Job — tests/einkauf-agent-
 * waechter.test.ts prüft das statisch.
 */

export const AGENT_AKTEUR = 'KI-Agent (Einkauf)'
const MAX_VORSCHLAEGE = 8

export class WerkzeugFehler extends Error {}

/** Zustand eines Agentenlaufs — was er gerade sichtet und was er angelegt hat. */
export interface AgentLauf {
  quelle: 'mail_nachricht' | 'dokument'
  quelleId: string
  modell: string
  threadId: string | null
  partnerId: string | null
  einkaufsprojektId: string | null
  purchaseOrderId: string | null
  /** Zeitpunkt der auslösenden Nachricht — kein zweiter Entwurf auf dieselbe Mail. */
  nachrichtAm: string | null
  standardSprache: string | null
  vorschlaege: string[]
  entwuerfe: string[]
  hinweise: string[]
}

export function neuerLauf(p: Pick<AgentLauf, 'quelle' | 'quelleId' | 'modell'> & Partial<AgentLauf>): AgentLauf {
  return {
    threadId: null,
    partnerId: null,
    einkaufsprojektId: null,
    purchaseOrderId: null,
    nachrichtAm: null,
    standardSprache: null,
    vorschlaege: [],
    entwuerfe: [],
    hinweise: [],
    ...p,
  }
}

type Handler = (input: Record<string, unknown>, lauf: AgentLauf) => Promise<string>

const json = (x: unknown) => JSON.stringify(x, null, 1)

function uuidAus(input: Record<string, unknown>, feld: string, ersatz?: string | null): string {
  const roh = typeof input[feld] === 'string' && input[feld] ? String(input[feld]) : (ersatz ?? '')
  if (!UUID_MUSTER.test(roh)) throw new WerkzeugFehler(`${feld} fehlt oder ist keine UUID.`)
  return roh
}

const kuerzen = (text: string | null | undefined, max: number) =>
  !text ? '' : text.length > max ? `${text.slice(0, max)} … [gekürzt]` : text

// --- Lesende Werkzeuge -----------------------------------------------------------

async function sqlAbfrage(input: Record<string, unknown>): Promise<string> {
  const query = String(input.query ?? '').trim()
  if (!query) throw new WerkzeugFehler('query fehlt.')
  const ergebnis = await runReadOnlyQuery(sql, query, FINANZ_SPERRE)
  if (ergebnis.error) throw new WerkzeugFehler(`Fehler: ${ergebnis.error}`)
  return ergebnisFuerModell(ergebnis)
}

async function threadLesen(input: Record<string, unknown>, lauf: AgentLauf): Promise<string> {
  const id = uuidAus(input, 'thread_id', lauf.threadId)
  const [t] = await sql`
    select t.id, t.betreff, t.status::text as status, t.kanal::text as kanal, t.zugeordnet_durch::text as zugeordnet_durch,
           t.partner_id, p.name as lieferant, p.sprache, t.purchase_order_id, po.number as bestellung, po.state::text as bestellstatus,
           t.einkaufsprojekt_id, ep.nummer as projekt, ep.titel as projekt_titel
    from mail_threads t
    left join partners p on p.id = t.partner_id
    left join purchase_orders po on po.id = t.purchase_order_id
    left join einkaufsprojekte ep on ep.id = t.einkaufsprojekt_id
    where t.id = ${id}`
  if (!t) throw new WerkzeugFehler('Thread nicht gefunden.')
  const nachrichten = await sql<
    { id: string; richtung: string; von: string | null; von_name: string | null; datum: string; betreff: string | null; text: string | null; text_de: string | null; sprache: string | null }[]
  >`
    select id, richtung::text as richtung, von, von_name, datum::text as datum, betreff, text, text_de, sprache
    from mail_nachrichten where thread_id = ${id}
    order by datum desc limit 15`
  const anhaenge = await sql<{ nachricht_id: string; dateiname: string; dokument_id: string | null; art: string | null; text_status: string | null }[]>`
    select a.nachricht_id, a.dateiname, a.dokument_id, d.art::text as art, d.text_status
    from mail_anhaenge a
    join mail_nachrichten n on n.id = a.nachricht_id
    left join dokumente d on d.id = a.dokument_id
    where n.thread_id = ${id}`
  return json({
    thread: t,
    nachrichten: nachrichten.reverse().map((n) => ({
      ...n,
      text: kuerzen(zitatTrennen(n.text ?? '').neu, 3000),
      text_de: n.text_de ? kuerzen(zitatTrennen(n.text_de).neu, 2000) : null,
      anhaenge: anhaenge.filter((a) => a.nachricht_id === n.id).map(({ nachricht_id: _n, ...a }) => a),
    })),
  })
}

async function lieferantenakteLesen(input: Record<string, unknown>): Promise<string> {
  const id = uuidAus(input, 'partner_id')
  const [partner] = await sql`
    select p.id, p.name, p.email, p.country_code, p.sprache, p.mail_domains, p.standard_incoterm, p.standard_waehrung,
           u.name as einkaeufer
    from partners p left join users u on u.id = p.einkaeufer_id
    where p.id = ${id}`
  if (!partner) throw new WerkzeugFehler('Lieferant nicht gefunden.')
  const [bestellungen, angebote, preise, vertraege, wiedervorlagen] = await Promise.all([
    sql`
      select po.id, po.number, po.state::text as state, po.currency, po.created_at::date::text as datum,
             coalesce(po.eta_confirmed::text, po.expected_arrival::date::text) as eta, po.verschifft_am::text as verschifft_am,
             (select coalesce(sum(l.qty * l.price_unit), 0) from purchase_order_lines l where l.order_id = po.id)::float as summe
      from purchase_orders po
      where po.vendor_id = ${id} and po.state not in ('cancel', 'done')
      order by po.created_at desc limit 15`,
    sql`
      select a.id, ep.nummer as projekt, a.projekt_id, a.version, a.waehrung, a.incoterm_code, a.moq::float as moq,
             a.lieferzeit_tage, a.gueltig_bis::text as gueltig_bis, a.verworfen, a.created_at::date::text as datum,
             (select json_agg(json_build_object('position', coalesce(pp.bezeichnung, ''), 'ab_menge', s.ab_menge, 'preis', s.preis)
                              order by pp.sequence, s.ab_menge)
                from lieferantenangebot_staffeln s join einkaufsprojekt_positionen pp on pp.id = s.position_id
               where s.angebot_id = a.id) as staffeln
      from lieferantenangebote a join einkaufsprojekte ep on ep.id = a.projekt_id
      where a.partner_id = ${id}
      order by a.created_at desc limit 10`,
    sql`
      select coalesce(vp.product_name, case when vp.variant_id is not null then variant_display_name(vp.variant_id) end, pt.name) as artikel,
             vp.min_qty::float as ab_menge, vp.price::float as preis, vp.currency, vp.lead_time_days,
             vp.date_start::text as gueltig_ab, vp.date_end::text as gueltig_bis
      from vendor_prices vp left join product_templates pt on pt.id = vp.template_id
      where vp.vendor_id = ${id}
      order by vp.updated_at desc nulls last, vp.created_at desc limit 30`,
    sql`
      select art::text as art, titel, status::text as status, gueltig_von::text as gueltig_von, gueltig_bis::text as gueltig_bis, waehrung
      from lieferantenvertraege where partner_id = ${id} order by gueltig_von desc nulls last`,
    sql`
      select modell, faellig_am::text as faellig_am, grund from wiedervorlagen
      where erledigt_am is null and modell = 'partner' and record_id = ${id} order by faellig_am`,
  ])
  return json({ partner, offene_bestellungen: bestellungen, letzte_angebote: angebote, lieferantenpreise: preise, vertraege, wiedervorlagen })
}

async function projektLesen(input: Record<string, unknown>, lauf: AgentLauf): Promise<string> {
  const id = uuidAus(input, 'einkaufsprojekt_id', lauf.einkaufsprojektId)
  const [projekt] = await sql`
    select id, nummer, titel, art, status::text as status, zieltermin::text as zieltermin, muster_pflicht,
           left(coalesce(beschreibung, ''), 2000) as beschreibung, gewaehltes_angebot_id
    from einkaufsprojekte where id = ${id}`
  if (!projekt) throw new WerkzeugFehler('Einkaufsprojekt nicht gefunden.')
  const positionen = await sql<{ id: string; bezeichnung: string; variant_id: string | null; menge: number; zielpreis_eur: number | null }[]>`
    select id, coalesce(bezeichnung, case when variant_id is not null then variant_display_name(variant_id) end, '') as bezeichnung,
           variant_id, menge::float as menge, zielpreis_eur::float as zielpreis_eur, gewicht_g::float as gewicht_g, hs_code
    from einkaufsprojekt_positionen where projekt_id = ${id} order by sequence, created_at`
  const [anfragen, angebote] = await Promise.all([
    sql`
      select a.partner_id, p.name as lieferant, a.status, a.frist::text as frist
      from lieferantenanfragen a join partners p on p.id = a.partner_id where a.projekt_id = ${id}`,
    sql<{ id: string }[]>`
      select a.id, a.partner_id, p.name as lieferant, a.version, a.waehrung, a.incoterm_code, a.moq::float as moq,
             a.lieferzeit_tage, a.anzahlung_pct::float as anzahlung_pct, a.werkzeugkosten::float as werkzeugkosten,
             a.gueltig_bis::text as gueltig_bis, a.verworfen, a.quelle,
             (select json_agg(json_build_object('position_id', s.position_id, 'ab_menge', s.ab_menge, 'preis', s.preis) order by s.ab_menge)
                from lieferantenangebot_staffeln s where s.angebot_id = a.id) as staffeln
      from lieferantenangebote a join partners p on p.id = a.partner_id
      where a.projekt_id = ${id} order by a.created_at`,
  ])
  const einstand: Record<string, readonly unknown[]> = {}
  for (const a of angebote) {
    einstand[a.id] = await sql`
      select position_id, einstand_eur::float as einstand_eur_je_stueck, zielpreis_eur::float as zielpreis_eur, hinweise
      from einstand_schaetzen(${a.id}::uuid)`
  }
  const varianten = positionen.map((p) => p.variant_id).filter((v): v is string => Boolean(v))
  const historie = varianten.length
    ? await sql`
        select variant_display_name(l.variant_id) as artikel, l.price_unit::float as preis, po.currency, l.qty::float as menge,
               po.number, po.created_at::date::text as datum, p.name as lieferant
        from purchase_order_lines l
        join purchase_orders po on po.id = l.order_id
        join partners p on p.id = po.vendor_id
        where l.variant_id = any(${varianten}::uuid[]) and po.state not in ('cancel', 'draft')
        order by po.created_at desc limit 20`
    : []
  return json({ projekt, positionen, anfragen, angebote, einstand_je_angebot: einstand, preishistorie: historie })
}

async function dokumentLesen(input: Record<string, unknown>): Promise<string> {
  const id = uuidAus(input, 'dokument_id')
  const [d] = await sql<{ text_auszug: string | null }[]>`
    select d.id, d.name, d.art::text as art, d.mime, d.revision, d.text_status, d.text_auszug, p.name as lieferant
    from dokumente d left join partners p on p.id = d.partner_id where d.id = ${id}`
  if (!d) throw new WerkzeugFehler('Dokument nicht gefunden.')
  const verweise = await sql`select modell, record_id from dokument_verweise where dokument_id = ${id}`
  return json({
    ...d,
    text_auszug: d.text_auszug ? kuerzen(d.text_auszug, 20_000) : null,
    hinweis: d.text_auszug ? undefined : 'Noch kein gelesener Text (der Dokument-Leser läuft getrennt; Excel ist nicht lesbar).',
    verweise,
  })
}

// --- Schreibende Werkzeuge ---------------------------------------------------------

/** Wo ein Vorschlag erscheint: Thread, Projekt, Bestellung, Lieferant. */
function vorschlagOrte(v: VorschlagEingabe, lauf: AgentLauf) {
  const w = v.werte as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' && UUID_MUSTER.test(x) ? x : null)
  const modell = registrierteAktion(v.aktion)?.modell
  const wvModell = v.aktion === 'einkauf.wiedervorlage_anlegen' ? String(w.modell ?? '') : null
  return {
    thread_id: v.aktion === 'einkauf.mail_zuordnen' ? v.recordId : wvModell === 'mail_thread' ? str(w.record_id) : lauf.threadId,
    einkaufsprojekt_id:
      (modell === 'einkaufsprojekt' ? v.recordId : null) ??
      str(w.einkaufsprojekt_id) ??
      (wvModell === 'einkaufsprojekt' ? str(w.record_id) : null) ??
      lauf.einkaufsprojektId,
    purchase_order_id: str(w.purchase_order_id) ?? (wvModell === 'purchase_order' ? str(w.record_id) : null) ?? lauf.purchaseOrderId,
    partner_id: str(w.partner_id) ?? (wvModell === 'partner' ? str(w.record_id) : null) ?? lauf.partnerId,
  }
}

/**
 * Einen geprüften Vorschlag speichern — geteilt vom Werkzeug
 * vorschlag_anlegen und vom Dokument-Leser. Prüft den Beleg (Existenz-
 * Check wie der Torwächter), verhindert Doppel und schreibt ausschließlich
 * in ki_vorschlaege.
 */
export async function vorschlagSpeichern(v: VorschlagEingabe, lauf: AgentLauf): Promise<string> {
  if (lauf.vorschlaege.length >= MAX_VORSCHLAEGE) {
    throw new WerkzeugFehler(`Höchstens ${MAX_VORSCHLAEGE} Vorschläge je Lauf — beschränke dich auf das Wichtigste.`)
  }
  const aktion = registrierteAktion(v.aktion)
  if (!aktion) throw new WerkzeugFehler('Unbekannte Aktion.')
  if (v.aktion === 'einkauf.mail_zuordnen' && lauf.threadId && v.recordId !== lauf.threadId) {
    throw new WerkzeugFehler('Zuordnen nur für den Thread der neuen Nachricht (record_id = dessen ID).')
  }
  if (aktion.bindung === 'beleg' && aktion.modell && v.recordId) {
    const [pruefung] = await sql<{ ok: boolean }[]>`select beleg_existiert(${aktion.modell}, ${v.recordId}::uuid) as ok`
    if (!pruefung?.ok) throw new WerkzeugFehler(`record_id ist kein Beleg vom Typ ${aktion.modell}.`)
  }
  const [doppelt] = await sql<{ id: string }[]>`
    select id from ki_vorschlaege
    where aktion = ${v.aktion} and record_id is not distinct from ${v.recordId}::uuid
      and parameter = ${sql.json(v.werte as never)}::jsonb and status in ('offen', 'fehler')
    limit 1`
  if (doppelt) return `Diesen Vorschlag gibt es schon (offen) — nichts doppelt angelegt.`

  const orte = vorschlagOrte(v, lauf)
  const [neu] = await sql<{ id: string }[]>`
    insert into ki_vorschlaege (aktion, parameter, record_id, art, titel, begruendung, belege, modell, quelle, quelle_id,
                                thread_id, partner_id, einkaufsprojekt_id, purchase_order_id)
    values (${v.aktion}, ${sql.json(v.werte as never)}, ${v.recordId}, ${v.art}, ${v.titel}, ${v.begruendung},
            ${sql.json(v.belege as never)}, ${lauf.modell}, ${lauf.quelle}, ${lauf.quelleId},
            ${orte.thread_id}, ${orte.partner_id}, ${orte.einkaufsprojekt_id}, ${orte.purchase_order_id})
    returning id`
  lauf.vorschlaege.push(neu.id)
  return `Vorschlag angelegt: „${v.titel}". Ein Mensch nimmt ihn an, ändert oder verwirft ihn — du führst nichts aus.`
}

async function vorschlagAnlegen(input: Record<string, unknown>, lauf: AgentLauf): Promise<string> {
  const g = vorschlagEingabeLesen(input)
  if (!g.ok) throw new WerkzeugFehler(g.fehler)
  return vorschlagSpeichern(g.wert, lauf)
}

/**
 * Antwort-Entwurf im Thread der Nachricht. Empfänger, Thread und Status legt
 * KRNL fest, nicht das Modell: an den Gesprächspartner, Status 'entwurf',
 * quelle 'agent' — gesendet wird erst nach der Freigabe durch einen Menschen
 * (Prozess mail_versand).
 */
async function entwurfAnlegen(input: Record<string, unknown>, lauf: AgentLauf): Promise<string> {
  if (!lauf.threadId) throw new WerkzeugFehler('Ein Entwurf entsteht nur als Antwort im Thread der Nachricht.')
  if (lauf.entwuerfe.length >= 1) throw new WerkzeugFehler('Höchstens ein Entwurf je Lauf.')
  const g = entwurfEingabeLesen(input, lauf.standardSprache)
  if (!g.ok) throw new WerkzeugFehler(g.fehler)

  const [t] = await sql<
    { partner_id: string | null; purchase_order_id: string | null; einkaufsprojekt_id: string | null; betreff: string | null; zustaendig_id: string | null; email: string | null }[]
  >`
    select t.partner_id, t.purchase_order_id, t.einkaufsprojekt_id, t.betreff, t.zustaendig_id, p.email
    from mail_threads t left join partners p on p.id = t.partner_id where t.id = ${lauf.threadId}`
  if (!t) throw new WerkzeugFehler('Thread nicht gefunden.')
  if (lauf.nachrichtAm) {
    const [schon] = await sql<{ id: string }[]>`
      select id from mail_entwuerfe
      where thread_id = ${lauf.threadId} and quelle = 'agent' and created_at >= ${lauf.nachrichtAm}::timestamptz limit 1`
    if (schon) return 'Zu dieser Nachricht liegt schon ein KI-Entwurf vor — keiner doppelt angelegt.'
  }
  const [letzte] = await sql<{ von: string }[]>`
    select von from mail_nachrichten
    where thread_id = ${lauf.threadId} and richtung = 'eingang' and von like '%@%'
    order by datum desc limit 1`
  const an = [letzte?.von ?? t.email].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase())
  const betreff = g.wert.betreff ?? (t.betreff ? `Re: ${betreffKern(t.betreff)}` : 'Re:')

  const [e] = await sql<{ id: string }[]>`
    insert into mail_entwuerfe (thread_id, partner_id, purchase_order_id, einkaufsprojekt_id, an, betreff, text_de, text_ziel,
                                sprache, quelle, status, antwort_erwartet_bis, erstellt_von, zustaendig_id)
    values (${lauf.threadId}, ${t.partner_id}, ${t.purchase_order_id}, ${t.einkaufsprojekt_id}, ${an}::text[], ${betreff},
            ${g.wert.textDe}, ${g.wert.textZiel}, ${g.wert.sprache}, 'agent', 'entwurf', ${g.wert.antwortErwartetBis},
            ${AGENT_AKTEUR}, ${t.zustaendig_id})
    returning id`
  await sql`select log_event('mail_entwurf', ${e.id}, 'info',
                             'Entwurf vom KI-Agenten angelegt — gesendet wird erst nach Freigabe durch einen Menschen', ${AGENT_AKTEUR})`
  lauf.entwuerfe.push(e.id)
  return `Entwurf angelegt (an ${an.join(', ') || 'noch ohne Empfänger'}). Er wird NICHT gesendet — ein Mensch liest gegen und gibt frei.`
}

const HANDLER = {
  sql_abfrage: sqlAbfrage,
  thread_lesen: threadLesen,
  lieferantenakte_lesen: lieferantenakteLesen,
  projekt_lesen: projektLesen,
  dokument_lesen: dokumentLesen,
  vorschlag_anlegen: vorschlagAnlegen,
  entwurf_anlegen: entwurfAnlegen,
} satisfies Record<WerkzeugName, Handler>

/** Ein Werkzeugaufruf des Modells → Text für das tool_result (Fehler als is_error). */
export async function werkzeugAusfuehren(
  name: string,
  input: unknown,
  lauf: AgentLauf,
): Promise<{ text: string; fehler: boolean }> {
  const handler = (HANDLER as Record<string, Handler>)[name]
  if (!handler) return { text: `Unbekanntes Werkzeug „${name}".`, fehler: true }
  const eingabe = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  try {
    return { text: await handler(eingabe, lauf), fehler: false }
  } catch (err) {
    if (err instanceof WerkzeugFehler) return { text: err.message, fehler: true }
    // Datenbankfehler (z. B. eine ID, die es nicht gibt) gehen als Werkzeugfehler
    // an das Modell — es kann sich korrigieren, der Lauf bricht nicht ab.
    const text = err instanceof Error ? err.message.replace(/^error: /, '') : String(err)
    return { text: `Fehler: ${text.slice(0, 500)}`, fehler: true }
  }
}
