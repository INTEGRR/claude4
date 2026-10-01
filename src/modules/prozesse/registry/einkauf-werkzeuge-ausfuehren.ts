import { sql, tx } from '@/db/client'
import { type WerkzeugStatus, WERKZEUG_STATUS, lebensdauer, schussBuchbar } from '@/modules/einkauf/werkzeuge'
import { varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung Einkauf Stufe 4 (0107): Werkzeuge/Formen beim Lieferanten (prozessfrei). */

interface Werkzeug {
  id: string
  nummer: string
  bezeichnung: string
  status: WerkzeugStatus
  schuss_zaehler: number
  lebensdauer_schuss: number | null
  waehrung: string
}

async function werkzeugLesen(id: string): Promise<Werkzeug> {
  const [w] = await sql<Werkzeug[]>`
    select id, nummer, bezeichnung, status::text as status, schuss_zaehler, lebensdauer_schuss, waehrung
    from werkzeuge where id = ${id}`
  if (!w) throw new Error('Werkzeug nicht gefunden.')
  return w
}

async function templateAufloesen(produkt: string): Promise<{ id: string; name: string }> {
  const v = await varianteAufloesen(sql, produkt)
  const [t] = await sql<{ id: string }[]>`select template_id as id from product_variants where id = ${v.id}`
  return { id: t.id, name: v.name }
}

interface Zeile {
  id: string
  number: string
  vendor_id: string
  currency: string
  betrag: number
  einkaufsprojekt_id: string | null
}

async function bestellzeileLesen(id: string): Promise<Zeile> {
  const [z] = await sql<Zeile[]>`
    select l.id, po.number, po.vendor_id, po.currency, (l.qty * l.price_unit)::float as betrag, po.einkaufsprojekt_id
    from purchase_order_lines l join purchase_orders po on po.id = l.order_id
    where l.id = ${id}`
  if (!z) throw new Error('Bestellzeile nicht gefunden.')
  return z
}

async function stammdatenPruefen(p: { partner_id?: string; waehrung?: string; einkaufsprojekt_id?: string }) {
  if (p.partner_id) {
    const [l] = await sql`select 1 from partners where id = ${p.partner_id}`
    if (!l) throw new Error('Lieferant nicht gefunden.')
  }
  if (p.waehrung) {
    const [w] = await sql`select 1 from currencies where code = ${p.waehrung}`
    if (!w) throw new Error(`Währung ${p.waehrung} ist in KRNL nicht angelegt.`)
  }
  if (p.einkaufsprojekt_id) {
    const [e] = await sql`select 1 from einkaufsprojekte where id = ${p.einkaufsprojekt_id}`
    if (!e) throw new Error('Einkaufsprojekt nicht gefunden.')
  }
}

export async function werkzeugAnlegen(
  p: {
    bezeichnung: string
    art: string
    partner_id?: string
    eigentuemer: string
    kosten?: number
    waehrung?: string
    purchase_order_line_id?: string
    einkaufsprojekt_id?: string
    produkt?: string
    lebensdauer_schuss?: number
    schuss_zaehler: number
    status: WerkzeugStatus
    notiz?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const zeile = p.purchase_order_line_id ? await bestellzeileLesen(p.purchase_order_line_id) : null
  const partnerId = p.partner_id ?? zeile?.vendor_id
  if (!partnerId) throw new Error('Bitte den Lieferanten angeben, bei dem das Werkzeug steht.')
  const projektId = p.einkaufsprojekt_id ?? zeile?.einkaufsprojekt_id ?? undefined
  const [lieferant] = await sql<{ standard_waehrung: string | null }[]>`select standard_waehrung from partners where id = ${partnerId}`
  const waehrung = p.waehrung ?? zeile?.currency ?? lieferant?.standard_waehrung ?? 'EUR'
  await stammdatenPruefen({ partner_id: partnerId, waehrung, einkaufsprojekt_id: projektId })
  const artikel = p.produkt ? await templateAufloesen(p.produkt) : null

  const w = await tx(async (t) => {
    const [neu] = await t<{ id: string; nummer: string }[]>`
      insert into werkzeuge (nummer, bezeichnung, art, partner_id, eigentuemer, kosten, waehrung, purchase_order_line_id,
                             einkaufsprojekt_id, template_id, lebensdauer_schuss, schuss_zaehler, status, notiz, erstellt_von)
      values (next_sequence('werkzeug'), ${p.bezeichnung}, ${p.art}, ${partnerId}, ${p.eigentuemer},
              ${p.kosten ?? zeile?.betrag ?? null}, ${waehrung}, ${zeile?.id ?? null}, ${projektId ?? null},
              ${artikel?.id ?? null}, ${p.lebensdauer_schuss ?? null}, ${p.schuss_zaehler},
              ${p.status}::werkzeug_status, ${p.notiz ?? null}, ${ctx.actor})
      returning id, nummer`
    await t`select log_event('werkzeug', ${neu.id}, 'state',
                             ${`Werkzeug angelegt (${WERKZEUG_STATUS[p.status]}${zeile ? `, Bestellung ${zeile.number}` : ''})`}, ${ctx.actor})`
    if (projektId) {
      await t`select log_event('einkaufsprojekt', ${projektId}, 'info', ${`Werkzeug ${neu.nummer} „${p.bezeichnung}" angelegt`}, ${ctx.actor})`
    }
    return neu
  })
  return { text: `Werkzeug ${w.nummer} angelegt.`, recordId: w.id, link: `/einkauf/werkzeuge/${w.id}` }
}

/**
 * Beim Bestellen eines Einkaufsprojekts mit Werkzeugkosten (Stufe 3): der
 * Werkzeug-Datensatz entsteht von selbst („in Auftrag", Eigentum bei uns) und
 * hängt an der Werkzeugkosten-Zeile. Gibt es schon ein Werkzeug des Projekts
 * beim selben Lieferanten ohne Bestellzeile (vorab von Hand angelegt), wird
 * dieses verknüpft statt ein zweites angelegt. Läuft in der Transaktion der
 * Bestellung.
 */
export async function werkzeugAusBestellung(
  t: typeof sql,
  b: {
    projektId: string
    projektNummer: string
    projektTitel: string
    partnerId: string
    zeileId: string
    bestellnummer: string
    kosten: number
    waehrung: string
    actor: string
  },
): Promise<{ id: string; nummer: string; neu: boolean }> {
  const [vorhanden] = await t<{ id: string; nummer: string }[]>`
    update werkzeuge set purchase_order_line_id = ${b.zeileId},
                         kosten = coalesce(kosten, ${b.kosten}),
                         waehrung = case when kosten is null then ${b.waehrung} else waehrung end
    where id = (select id from werkzeuge
                where einkaufsprojekt_id = ${b.projektId} and partner_id = ${b.partnerId}
                  and purchase_order_line_id is null and status <> 'ausgemustert'
                order by created_at limit 1)
    returning id, nummer`
  if (vorhanden) {
    await t`select log_event('werkzeug', ${vorhanden.id}, 'info', ${`Mit Bestellung ${b.bestellnummer} verknüpft (Werkzeugkosten)`}, ${b.actor})`
    return { ...vorhanden, neu: false }
  }
  const [neu] = await t<{ id: string; nummer: string }[]>`
    insert into werkzeuge (nummer, bezeichnung, art, partner_id, eigentuemer, kosten, waehrung, purchase_order_line_id,
                           einkaufsprojekt_id, status, erstellt_von)
    values (next_sequence('werkzeug'), ${`Werkzeug ${b.projektTitel}`.slice(0, 200)}, 'sonstiges', ${b.partnerId}, 'wir',
            ${b.kosten}, ${b.waehrung}, ${b.zeileId}, ${b.projektId}, 'in_auftrag', ${b.actor})
    returning id, nummer`
  await t`select log_event('werkzeug', ${neu.id}, 'state',
                           ${`Aus Einkaufsprojekt ${b.projektNummer} angelegt (Werkzeugkosten in Bestellung ${b.bestellnummer})`}, ${b.actor})`
  return { ...neu, neu: true }
}

export async function werkzeugAendern(
  p: {
    bezeichnung?: string
    art?: string
    partner_id?: string
    eigentuemer?: string
    kosten?: number
    waehrung?: string
    lebensdauer_schuss?: number
    einkaufsprojekt_id?: string
    produkt?: string
    purchase_order_line_id?: string
    notiz?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const w = await werkzeugLesen(ctx.recordId!)
  await stammdatenPruefen({ partner_id: p.partner_id, waehrung: p.waehrung, einkaufsprojekt_id: p.einkaufsprojekt_id || undefined })
  const artikel = p.produkt ? await templateAufloesen(p.produkt) : null
  if (p.purchase_order_line_id) await bestellzeileLesen(p.purchase_order_line_id)
  await sql`
    update werkzeuge set
      bezeichnung = coalesce(${p.bezeichnung ?? null}, bezeichnung),
      art = coalesce(${p.art ?? null}, art),
      partner_id = coalesce(${p.partner_id ?? null}::uuid, partner_id),
      eigentuemer = coalesce(${p.eigentuemer ?? null}, eigentuemer),
      kosten = coalesce(${p.kosten ?? null}, kosten),
      waehrung = coalesce(${p.waehrung ?? null}, waehrung),
      lebensdauer_schuss = coalesce(${p.lebensdauer_schuss ?? null}, lebensdauer_schuss),
      einkaufsprojekt_id = case when ${p.einkaufsprojekt_id !== undefined}
                                then nullif(${p.einkaufsprojekt_id ?? ''}, '')::uuid else einkaufsprojekt_id end,
      template_id = case when ${p.produkt !== undefined} then ${artikel?.id ?? null}::uuid else template_id end,
      purchase_order_line_id = case when ${p.purchase_order_line_id !== undefined}
                                    then nullif(${p.purchase_order_line_id ?? ''}, '')::uuid else purchase_order_line_id end,
      notiz = case when ${p.notiz !== undefined} then nullif(${p.notiz ?? ''}, '') else notiz end
    where id = ${w.id}`
  await sql`select log_event('werkzeug', ${w.id}, 'info', 'Stammdaten geändert', ${ctx.actor})`
  return { text: `${w.nummer} gespeichert.`, recordId: w.id }
}

export async function werkzeugStatusSetzen(p: { status: WerkzeugStatus; grund?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const w = await werkzeugLesen(ctx.recordId!)
  if (w.status === p.status) throw new Error(`${w.nummer} ist schon ${WERKZEUG_STATUS[p.status].toLowerCase()}.`)
  if (w.status === 'ausgemustert') {
    throw new Error(`${w.nummer} ist ausgemustert — das ist endgültig. Für einen Nachbau ein neues Werkzeug anlegen.`)
  }
  await sql`
    update werkzeuge set status = ${p.status}::werkzeug_status, status_grund = ${p.grund ?? null}
    where id = ${w.id}`
  const text = `Status: ${WERKZEUG_STATUS[w.status]} → ${WERKZEUG_STATUS[p.status]}${p.grund ? ` (${p.grund})` : ''}`
  await sql`select log_event('werkzeug', ${w.id}, 'state', ${text}, ${ctx.actor})`
  return { text: `${w.nummer}: ${WERKZEUG_STATUS[p.status]}.`, recordId: w.id }
}

export async function werkzeugSchussBuchen(p: { anzahl: number; notiz?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const w = await werkzeugLesen(ctx.recordId!)
  const verbot = schussBuchbar(w.status, w.schuss_zaehler, p.anzahl)
  if (verbot) throw new Error(verbot)
  const [neu] = await sql<{ schuss_zaehler: number }[]>`
    update werkzeuge set schuss_zaehler = schuss_zaehler + ${p.anzahl}
    where id = ${w.id} and schuss_zaehler + ${p.anzahl} >= 0
    returning schuss_zaehler`
  if (!neu) throw new Error('Der Zähler stünde dann unter 0.')
  const fmt = (n: number) => n.toLocaleString('de-DE')
  const ld = lebensdauer(neu.schuss_zaehler, w.lebensdauer_schuss)
  const stand = w.lebensdauer_schuss
    ? `${fmt(neu.schuss_zaehler)} von ${fmt(w.lebensdauer_schuss)} Schuss (${ld.pct} %)`
    : `${fmt(neu.schuss_zaehler)} Schuss`
  await sql`select log_event('werkzeug', ${w.id}, 'info',
                             ${`${p.anzahl > 0 ? '+' : ''}${fmt(p.anzahl)} Schuss gebucht — Stand ${stand}${p.notiz ? ` (${p.notiz})` : ''}`},
                             ${ctx.actor})`
  const warnung =
    ld.stufe === 'ueber'
      ? ' Die Lebensdauer ist erreicht — Ersatz oder Überholung planen.'
      : ld.stufe === 'bald'
        ? ' Über 90 % der Lebensdauer — eine Wiedervorlage erinnert daran.'
        : ''
  return { text: `${w.nummer}: Stand ${stand}.${warnung}`, recordId: w.id }
}
