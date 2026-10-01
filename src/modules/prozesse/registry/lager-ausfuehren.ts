import { SPERRE_MINUTEN, sammelAbgleich } from '../../versand/kommissionier-logik.ts'
import { sql, tx } from '@/db/client'
import { parseLotSpec } from '@/modules/shared/form'
import { consumePackagingForPicking, queueFulfillmentForPicking } from '@/modules/versand/service'
import { drucken, zielDrucker } from '@/modules/druck/auftrag'
import {
  MAX_ANZAHL_JE_VARIANTE,
  MAX_ETIKETTEN_JE_DRUCK,
  positionenAlsParameter,
} from '../../druck/etikett-layout.ts'
import { varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/**
 * Ausführung der Lager-Aktionen. Die Fachlogik stammt unverändert aus
 * lager/actions.ts — sie ruft dieselben SQL-Funktionen; neu ist nur, dass
 * sie hier adressierbar ist (HTTP-Route, Prozesstest, generierte Maske)
 * statt allein am Formular zu hängen.
 */

const HAUPTLAGER = async (): Promise<string> => {
  const [loc] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  return loc.id
}

export async function transferBuchen(
  p: { mengen: Record<string, number>; lose: Record<string, string>; backorder: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  const mengen = { ...p.mengen }

  // Explizit erfasste Lose/Seriennummern vor der Buchung zuordnen
  // (leere Felder überlassen die Zuteilung der Automatik in move_done).
  for (const [moveId, wert] of Object.entries(p.lose)) {
    if (!wert.trim()) continue
    const [row] = await sql<{ tracking: 'lot' | 'serial' | 'none' }[]>`
      select product_tracking(variant_id) as tracking from stock_moves where id = ${moveId}`
    if (!row || row.tracking === 'none') continue
    const lots = parseLotSpec(wert, row.tracking)
    await sql`select set_move_lots(${moveId}, ${sql.json(lots as never)})`
    // Erfasste Lose bestimmen die Ist-Menge, wenn keine explizit angegeben ist.
    if (!(moveId in mengen)) mengen[moveId] = lots.reduce((sum, l) => sum + l.qty, 0)
  }

  await sql`select picking_validate(${pickingId}, ${sql.json(mengen)}, ${p.backorder})`

  // Die Kartonage verlässt das Haus mit der Ware — jetzt wird sie verbraucht.
  await consumePackagingForPicking(pickingId).catch(() => undefined)

  // Nach dem Warenausgang die Sendung an Shopify melden (läuft über die
  // Outbox). Die Rückmeldung darf den Warenausgang nie blockieren — aber sie
  // muss eine Spur hinterlassen.
  try {
    await queueFulfillmentForPicking(pickingId)
  } catch (err) {
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Shopify-Rückmeldung konnte nicht eingereiht werden: ${err instanceof Error ? err.message : String(err)}`})`
      .catch(() => undefined)
  }

  return { recordId: pickingId }
}

export async function transferBestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_confirm(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function verfuegbarkeitPruefen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_check_availability(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function transferStornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select picking_cancel(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function transferRetoure(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ picking_return: string }[]>`select picking_return(${ctx.recordId!})`
  return { recordId: row.picking_return }
}

export async function transferDetails(
  p: { user_id?: string; priority: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update stock_pickings set
      user_id = ${p.user_id ?? null},
      priority = ${p.priority ? '1' : '0'}
    where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

// --- Inventur / Ausschuss ---------------------------------------------------

export async function zaehlungErfassen(
  p: { variant_id: string; counted_qty: number },
): Promise<AktionsErgebnis> {
  const loc = await HAUPTLAGER()
  const [current] = await sql<{ on_hand: number }[]>`
    select coalesce(on_hand, 0) as on_hand from stock_quants
    where location_id = ${loc} and variant_id = ${p.variant_id}`
  const [row] = await sql<{ id: string }[]>`
    insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
    values (${loc}, ${p.variant_id}, ${p.counted_qty}, ${current?.on_hand ?? 0})
    returning id`
  return { recordId: row.id }
}

export async function zaehlungBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select inventory_apply(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function zaehlungLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`delete from inventory_counts where id = ${ctx.recordId!} and applied_at is null`
  return {}
}

export async function ausschussBuchen(
  p: { variant_id: string; qty: number; reason?: string },
): Promise<AktionsErgebnis> {
  const loc = await HAUPTLAGER()
  await sql`select scrap(${p.variant_id}, ${p.qty}, ${loc}, ${p.reason ?? null})`
  return {}
}

// --- Artikel-Etiketten --------------------------------------------------------

/**
 * Artikel-Etiketten (Variante, Wareneingang, KI): Kennungen auflösen (UUID
 * aus der Maske, SKU/Barcode/Name von der KI), gleiche Varianten
 * zusammenfassen, dann je Variante EIN Druckauftrag mit der Anzahl am
 * Etikettendrucker des Arbeitsplatzes bzw. Ersatz (0087). Ohne Drucker das
 * PDF im Browser — alle Positionen in einem Dokument.
 */
export async function artikeletikettDrucken(
  p: { positionen: { variant_id: string; anzahl: number }[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const summe = new Map<string, number>()
  for (const pos of p.positionen) {
    const v = await varianteAufloesen(sql, pos.variant_id)
    summe.set(v.id, Math.min(MAX_ANZAHL_JE_VARIANTE, (summe.get(v.id) ?? 0) + pos.anzahl))
  }
  const positionen = [...summe].map(([variantId, anzahl]) => ({ variantId, anzahl }))
  const gesamt = positionen.reduce((a, x) => a + x.anzahl, 0)
  if (gesamt > MAX_ETIKETTEN_JE_DRUCK) {
    throw new Error(`Höchstens ${MAX_ETIKETTEN_JE_DRUCK} Etiketten je Druck — bitte aufteilen.`)
  }

  // Ohne Code kein Etikett: vorher abweisen statt an der Brücke scheitern.
  const ohneCode = await sql<{ name: string }[]>`
    select variant_display_name(id) as name from product_variants
    where id = any(${positionen.map((x) => x.variantId)}::uuid[])
      and coalesce(nullif(trim(barcode), ''), nullif(trim(sku), '')) is null`
  if (ohneCode.length > 0) {
    throw new Error(
      `${ohneCode.map((v) => v.name).join(', ')}: weder Barcode noch SKU — bitte zuerst an der Variante hinterlegen.`,
    )
  }

  const stueck = `${gesamt} Artikel-Etikett${gesamt === 1 ? '' : 'en'}`
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'artikeletikett')
  if (!ziel) {
    return {
      text: `${stueck} — kein Etikettendrucker für Artikel-Etiketten, PDF im Browser geöffnet (einrichten: Einstellungen → Arbeitsplätze & Drucker).`,
      link: `/api/etikett/artikel?pos=${positionenAlsParameter(positionen)}`,
    }
  }
  let meldung = ''
  let wartete = 0
  for (const x of positionen) {
    const druck = await drucken(
      'artikeletikett',
      { art: 'artikeletikett', variantId: x.variantId, anzahl: x.anzahl },
      { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
      ziel,
    )
    if (druck.gedruckt) {
      meldung = druck.meldung
      if (druck.wartete) wartete++
    }
  }
  // Ein noch offener Auftrag derselben Variante am selben Drucker wird nicht
  // verdoppelt (Doppelklick) — das sagt die Meldung, statt still zu schlucken.
  const doppelt =
    wartete > 0
      ? ` ${wartete} Variante${wartete === 1 ? '' : 'n'} lag${wartete === 1 ? '' : 'en'} schon in der Warteschlange — nach dem Druck erneut drucken.`
      : ''
  return { text: `${stueck}: ${meldung}${doppelt}` }
}

// --- Meldebestände ----------------------------------------------------------

export async function meldebestandAnlegen(p: {
  variant_id: string
  min_qty: number
  max_qty: number
  qty_multiple: number
  route?: string
}): Promise<AktionsErgebnis> {
  const produkt = await varianteAufloesen(sql, p.variant_id)
  const loc = await HAUPTLAGER()
  // Zwei Regeln je Produkt hieße zwei widersprüchliche Beschaffungs-
  // Vorschläge — ändern statt doppelt anlegen.
  const [vorhanden] = await sql<{ id: string }[]>`
    select id from stock_orderpoints
    where variant_id = ${produkt.id} and location_id = ${loc}`
  if (vorhanden) {
    throw new Error(
      `Für ${produkt.name} gibt es bereits einen Meldebestand — bitte dort ändern statt neu anlegen.`,
    )
  }
  const [row] = await sql<{ id: string }[]>`
    insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, qty_multiple, route)
    values (${produkt.id}, ${loc}, ${p.min_qty}, ${p.max_qty}, ${p.qty_multiple},
            ${p.route ?? null})
    returning id`
  return { text: `Meldebestand für ${produkt.name} angelegt.`, recordId: row.id }
}

export async function meldebestandLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`delete from stock_orderpoints where id = ${ctx.recordId!}`
  return {}
}

export async function meldebestandSchlummern(
  p: { tage: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update stock_orderpoints
            set snoozed_until = current_date + ${p.tage}::int
            where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

export async function meldebestandWecken(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`update stock_orderpoints set snoozed_until = null where id = ${ctx.recordId!}`
  return { recordId: ctx.recordId }
}

/*
 * Legt Bestellung oder Fertigungsauftrag an. Der entstandene Beleg zählt als
 * offener Zulauf, der Vorschlag verschwindet also aus der Liste (0053) — die
 * Rückmeldung muss trotzdem sagen, welcher Beleg entstanden ist, damit der
 * Weg dorthin klickbar bleibt.
 */
export async function beschaffungAusfuehren(
  p: { menge?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ orderpoint_execute: string }[]>`
    select orderpoint_execute(${ctx.recordId!}, ${ctx.actor}, ${p.menge ?? null})`
  const beleg = row.orderpoint_execute

  const istFertigung = beleg.startsWith('MO/')
  const [ziel] = istFertigung
    ? await sql<{ id: string }[]>`select id from manufacturing_orders where number = ${beleg}`
    : await sql<{ id: string }[]>`select id from purchase_orders where number = ${beleg}`

  return {
    text: istFertigung
      ? `Fertigungsauftrag ${beleg} angelegt und bestätigt.`
      : `Position in Bestellung ${beleg} aufgenommen (Entwurf).`,
    link: ziel ? (istFertigung ? `/fertigung/${ziel.id}` : `/einkauf/${ziel.id}`) : undefined,
    recordId: ziel?.id,
  }
}

export async function eroeffnungsbewertung(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select valuation_initialize(null, ${ctx.actor})`
  return {}
}

// --- Kommissionieren (0091) ----------------------------------------------------

async function sammelSperre(pickingId: string, actor: string) {
  const [p] = await sql<
    { number: string; state: string; von: string | null; seit: string | null; frisch: boolean }[]
  >`
    select number, state::text, kommissionierung_von as von, kommissionierung_seit::text as seit,
           coalesce(kommissionierung_seit > now() - make_interval(mins => ${SPERRE_MINUTEN}), false) as frisch
    from stock_pickings where id = ${pickingId}`
  if (!p) throw new Error('Lieferung nicht gefunden.')
  if (p.state !== 'assigned') {
    throw new Error(`Lieferung ${p.number} ist nicht versandbereit (Status ${p.state}).`)
  }
  if (p.von && p.von !== actor && p.frisch) {
    throw new Error(
      `${p.number} wird gerade von ${p.von} gesammelt (seit ${new Date(p.seit!).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}).`,
    )
  }
  return p
}

export async function kommissionierungStarten(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  const p = await sammelSperre(pickingId, ctx.actor)
  await sql`update stock_pickings
            set kommissionierung_von = ${ctx.actor}, kommissionierung_seit = now()
            where id = ${pickingId}`
  return { text: `${p.number}: Sammeln begonnen.`, recordId: pickingId, link: `/kommissionieren/${pickingId}` }
}

export async function kommissionieren(
  p: { gesammelt: Record<string, number>; unvollstaendig: boolean; vermerk?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  const kopf = await sammelSperre(pickingId, ctx.actor)
  const moves = await sql<{ id: string; variant_id: string; qty: number; name: string; sku: string | null }[]>`
    select m.id, m.variant_id, m.qty::float as qty, variant_display_name(m.variant_id) as name, pv.sku
    from stock_moves m join product_variants pv on pv.id = m.variant_id
    where m.picking_id = ${pickingId} and m.state <> 'cancel'
    order by m.created_at`
  const positionen = [...new Map(moves.map((m) => [m.variant_id, m])).values()].map((m) => ({
    variantId: m.variant_id,
    name: m.name,
    sku: m.sku,
    barcode: null,
    soll: moves.filter((x) => x.variant_id === m.variant_id).reduce((s, x) => s + Number(x.qty), 0),
    uom: '',
  }))
  const abgleich = sammelAbgleich(positionen, p.gesammelt)
  if (abgleich.fremd.length > 0) throw new Error('Gemeldete Artikel gehören nicht zu dieser Lieferung.')
  if (abgleich.zuViel.length > 0) throw new Error(`Mehr gesammelt als bestellt: ${abgleich.zuViel.join(', ')}.`)
  if (abgleich.fehlend.length > 0 && !p.unvollstaendig) {
    throw new Error(
      `Noch nicht vollständig gesammelt: ${abgleich.fehlend.join(', ')} — gesammelt wird unter ` +
        '„Kommissionieren" (Handy/Tablet), oder mit „unvollständig" und Vermerk speichern.',
    )
  }

  await tx(async (t) => {
    // Menge je Variante auf die Bewegungen verteilen (Reihenfolge der Anlage).
    for (const pos of positionen) {
      let rest = Number(p.gesammelt[pos.variantId] ?? 0)
      for (const m of moves.filter((x) => x.variant_id === pos.variantId)) {
        const teil = Math.min(rest, Number(m.qty))
        await t`update stock_moves set qty_kommissioniert = ${teil} where id = ${m.id}`
        rest -= teil
      }
    }
    await t`update stock_pickings
            set kommissioniert_am = case when ${abgleich.vollstaendig} then now() end,
                kommissioniert_von = ${abgleich.vollstaendig ? ctx.actor : null},
                kommissionierung_von = null, kommissionierung_seit = null
            where id = ${pickingId}`
    if (!abgleich.vollstaendig) {
      await t`select log_event('stock_picking', ${pickingId}, 'error',
        ${`Kommissionierung unvollständig — fehlt: ${abgleich.fehlend.join(', ')}${p.vermerk ? ` (${p.vermerk})` : ''}`},
        ${ctx.actor})`
    } else if (p.vermerk) {
      await t`select log_event('stock_picking', ${pickingId}, 'note',
        ${`Kommissioniert — ${p.vermerk}`}, ${ctx.actor})`
    }
  })

  return {
    text: abgleich.vollstaendig
      ? `${kopf.number} kommissioniert — Ware zum Packtisch.`
      : `${kopf.number}: Fortschritt gespeichert, es fehlt ${abgleich.fehlend.join(', ')}.`,
    recordId: pickingId,
  }
}
