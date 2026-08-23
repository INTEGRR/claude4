import { sql, tx } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Vorgangs-Aktionen. */

export async function anlegen(
  p: { prozess_code: string; titel?: string; partner_id?: string; zusatz: Record<string, unknown> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [prozess] = await sql<{ code: string }[]>`
    select code from prozesse
    where code = ${p.prozess_code} and aktiv and modell = 'vorgang'`
  if (!prozess) {
    throw new Error(`„${p.prozess_code}" ist kein aktiver Vorgangs-Prozess.`)
  }

  // Der Startzustand kommt aus der Prozessdefinition: der Zustand des
  // Anlage-Schritts der aktiven Version (Fallback 'neu').
  const [schritt] = await sql<{ zustand: string | null }[]>`
    select s.zustand from prozess_schritte s
    where s.version_id = prozess_aktive_version(${p.prozess_code})
      and s.aktion = 'vorgang.anlegen'
    limit 1`

  const [vorgang] = await sql<{ id: string; number: string }[]>`
    insert into vorgaenge (number, prozess_code, titel, state, partner_id, zusatz)
    values (next_sequence('vorgang'), ${p.prozess_code}, ${p.titel ?? null},
            ${schritt?.zustand ?? 'neu'}, ${p.partner_id ?? null},
            ${sql.json(p.zusatz as never)})
    returning id, number`

  await sql`select log_event('vorgang', ${vorgang.id}::uuid, 'state',
    ${`Vorgang gestartet (${p.prozess_code})`}, ${ctx.actor})`

  return {
    text: `Vorgang ${vorgang.number} gestartet.`,
    link: `/vorgaenge/${vorgang.id}`,
    recordId: vorgang.id,
  }
}

/**
 * Die Fuge Vorgang → Fachbeleg: aus dem Laufzeit-Beleg entsteht ein echter
 * Verkaufsauftrag, verkettet über origin_model/origin_id (Migration 0072) —
 * danach findet teilprozess_stand('verkauf', …, 'vorgang', id) den Auftrag,
 * und Auftrag & Lieferung laufen als Teilprozess im selben Diagramm weiter.
 * Vorbild: repair_create_quotation (0010) — anlegen, zurückverknüpfen,
 * idempotent. Der Zielzustand kommt aus den Schritt-params: der Belegstatus
 * bleibt die einzige Zustandswahrheit.
 */
export async function auftragAnlegen(
  p: { state: string; vermerk?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [vorgang] = await sql<
    { number: string; titel: string | null; partner_id: string | null }[]
  >`
    select number, titel, partner_id from vorgaenge where id = ${id}`
  if (!vorgang) throw new Error('Vorgang nicht gefunden.')
  if (!vorgang.partner_id) {
    throw new Error(
      'Der Vorgang braucht einen Kunden — in der Details-Karte setzen, dann erneut.',
    )
  }

  // Idempotenz weich (verlinken statt doppeln) — und hart über den
  // partiellen Unique-Index sales_orders_ein_auftrag_je_vorgang.
  const [vorhanden] = await sql<{ id: string; number: string }[]>`
    select id, number from sales_orders
    where origin_model = 'vorgang' and origin_id = ${id}`
  if (vorhanden) {
    return {
      text: `Auftrag ${vorhanden.number} existiert bereits zu diesem Vorgang.`,
      link: `/verkauf/${vorhanden.id}`,
      recordId: id,
    }
  }

  const order = await tx(async (t) => {
    const [neu] = await t<{ id: string; number: string }[]>`
      insert into sales_orders (number, partner_id, client_order_ref, note,
                                origin_model, origin_id, origin_label)
      values (next_sequence('sale'), ${vorgang.partner_id},
              ${vorgang.titel ?? vorgang.number}, ${p.vermerk ?? null},
              'vorgang', ${id}, ${vorgang.number})
      returning id, number`
    // Lieferadresse aus dem Kontakt vorbelegen (wie verkauf.auftrag_anlegen).
    await t`
      update sales_orders so set
        ship_name = pa.name, ship_street = pa.street, ship_house_number = pa.house_number,
        ship_street2 = pa.street2, ship_zip = pa.zip, ship_city = pa.city,
        ship_country_code = pa.country_code, ship_phone = pa.phone, ship_email = pa.email
      from partners pa where pa.id = so.partner_id and so.id = ${neu.id}`
    await t`update vorgaenge set state = ${p.state} where id = ${id}`
    return neu
  })

  await sql`select log_event('vorgang', ${id}::uuid, 'state',
    ${`Auftrag ${order.number} aus ${vorgang.number} angelegt (→ ${p.state})`}, ${ctx.actor})`
  await sql`select log_event('sales_order', ${order.id}::uuid, 'note',
    ${`Entstanden aus Vorgang ${vorgang.number}`}, ${ctx.actor})`

  return {
    text: `Auftrag ${order.number} angelegt — Positionen und Preise dort erfassen.`,
    link: `/verkauf/${order.id}`,
    recordId: id,
  }
}

/**
 * Formulare liefern Strings — im zusatz-jsonb müssen aber echte Typen liegen,
 * sonst läuft `bedingung_pruefen` auf `zusatz.budget > 1000` gegen "5000" und
 * vergleicht Text. Die Koerzierung sitzt hier (die Ausführung kennt die
 * feld_definitionen), nicht im formdata (das bleibt pur).
 *
 * Leerer String = Wert löschen (jsonb null) — das Formular zeigt den Ist-Wert,
 * wer ihn leert, meint „weg damit". Ausnahme schalter: leer heißt „aus".
 */
export function koerziereFeldwert(typ: string | undefined, roh: unknown): unknown {
  if (typeof roh !== 'string') return roh
  const text = roh.trim()
  if (typ === 'schalter') return text === 'on' || text === 'true' || text === 'ja'
  if (text === '') return null
  if (typ === 'nummer') {
    const zahl = Number(text.replace(',', '.'))
    if (Number.isNaN(zahl)) throw new Error(`„${roh}" ist keine Zahl.`)
    return zahl
  }
  return text
}

export async function kopfAendern(
  p: { titel?: string; partner_id?: string; zusatz?: Record<string, unknown> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [vorgang] = await sql<{ prozess_code: string; number: string }[]>`
    select prozess_code, number from vorgaenge where id = ${id}`
  if (!vorgang) throw new Error('Vorgang nicht gefunden.')

  const defs = await sql<{ name: string; typ: string }[]>`
    select name, typ from feld_definitionen
    where modell = 'vorgang'
      and (prozess_code is null or prozess_code = ${vorgang.prozess_code})`
  const typJeName = new Map(defs.map((d) => [d.name, d.typ]))
  const koerziert: Record<string, unknown> = {}
  for (const [name, roh] of Object.entries(p.zusatz ?? {})) {
    try {
      koerziert[name] = koerziereFeldwert(typJeName.get(name), roh)
    } catch (err) {
      throw new Error(`Feld „${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await sql`
    update vorgaenge set
      titel = coalesce(${p.titel ?? null}, titel),
      partner_id = coalesce(${p.partner_id ?? null}::uuid, partner_id),
      zusatz = zusatz || ${sql.json(koerziert as never)}
    where id = ${id}`
  await sql`select log_event('vorgang', ${id}::uuid, 'note',
    ${`Kopf geändert${Object.keys(koerziert).length ? ` (${Object.keys(koerziert).join(', ')})` : ''}`},
    ${ctx.actor})`
  return { text: `${vorgang.number} aktualisiert.`, recordId: id }
}

export async function statusSetzen(
  p: { state: string; vermerk?: string; zusatz?: Record<string, unknown> },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  await sql`
    update vorgaenge set
      state = ${p.state},
      zusatz = zusatz || ${sql.json((p.zusatz ?? {}) as never)}
    where id = ${id}`
  await sql`select log_event('vorgang', ${id}::uuid, 'state',
    ${`Zustand: ${p.state}${p.vermerk ? ` — ${p.vermerk.slice(0, 300)}` : ''}`}, ${ctx.actor})`
  return { recordId: id }
}
