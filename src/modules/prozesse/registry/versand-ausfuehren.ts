import { sql } from '@/db/client'
import {
  adresseFuerPickingPruefen,
  cancelShipmentById,
  consumePackagingForPicking,
  createLabelForPicking,
  createReturnLabelForPartner,
  queueFulfillmentForPicking,
  syncTracking,
} from '@/modules/versand/service'
import { pruefText } from '@/modules/versand/dhl-validierung'
import { drucken, zielDrucker } from '@/modules/druck/auftrag'
import { packtischAbgleich } from '@/modules/versand/packtisch-logik'
import { gelabeltNichtAusgebucht } from '@/modules/versand/gelabelt'
import { gewichteAusShopify } from '@/modules/integrationen/gewichte'
import { versandbereitMitVorschlag } from '@/modules/versand/regeln'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Versand-Aktionen — Fachlogik aus versand/actions.ts. */

/**
 * Was nach dem Label passiert (Entscheidungslog 2026-10-01, „Label bucht
 * aus"): sobald das Label rausgeht, ist die Ware weg — Warenausgang buchen,
 * Kartonage verbrauchen, Shop-Rückmeldung einreihen. `nichtAusbuchen` ist
 * der bewusste Ausnahmefall (nur das Label drucken). Ein Ersatz-Label für
 * eine schon ausgebuchte Lieferung (nach Storno) meldet nur die neue
 * Sendungsnummer an den Shop. Scheitert das Buchen, bleibt das Label gültig
 * und der Grund steht am Beleg — nachholen über „Gelabelte ausbuchen".
 */
export async function nachLabelAusbuchen(
  pickingId: string,
  shipmentId: string,
  nichtAusbuchen: boolean,
): Promise<{ ausgebucht: boolean; hinweis: string | null }> {
  const [zustand] = await sql<{ state: string }[]>`
    select state from stock_pickings where id = ${pickingId}`

  if (zustand?.state === 'done') {
    // Ersatz-Label: schon gemeldet → der Job reicht nur die neue Nummer nach.
    await sql`
      update shipments set shopify_fulfillment_id = (
        select alt.shopify_fulfillment_id from shipments alt
        where alt.picking_id = ${pickingId} and alt.id <> ${shipmentId}
          and alt.shopify_fulfillment_id is not null
        order by alt.created_at desc limit 1)
      where id = ${shipmentId} and shopify_fulfillment_id is null`
    await sql`
      select enqueue_job('shopify_fulfillment_create', ${sql.json({ shipment_id: shipmentId })},
                         ${`fulfillment:${shipmentId}`})
      from shipments s join sales_orders so on so.id = s.sales_order_id
      where s.id = ${shipmentId} and so.shopify_order_id is not null`
    return { ausgebucht: false, hinweis: 'Lieferung war schon ausgebucht — die neue Sendungsnummer geht an den Shop' }
  }
  if (nichtAusbuchen) return { ausgebucht: false, hinweis: 'nicht ausgebucht (nur Label)' }
  if (zustand?.state !== 'assigned') {
    return { ausgebucht: false, hinweis: 'nicht ausgebucht — die Lieferung ist noch nicht reserviert' }
  }

  try {
    await sql`select picking_validate(${pickingId}, ${sql.json({})}, false)`
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Ausbuchen nach dem Label fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    return { ausgebucht: false, hinweis: `Ausbuchen fehlgeschlagen: ${message}` }
  }
  await consumePackagingForPicking(pickingId).catch(() => undefined)
  try {
    await queueFulfillmentForPicking(pickingId)
  } catch (err) {
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Shopify-Rückmeldung konnte nicht eingereiht werden: ${err instanceof Error ? err.message : String(err)}`})`
      .catch(() => undefined)
  }
  return { ausgebucht: true, hinweis: null }
}

export async function labelErstellen(
  p: { weight_g?: number; dhl_product?: string; nicht_ausbuchen: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  // Der Labeldrucker des Platzes bestimmt das DHL-Format — schon beim Erzeugen.
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'versandlabel')
  let result: Awaited<ReturnType<typeof createLabelForPicking>>
  try {
    result = await createLabelForPicking(pickingId, {
      weightG: p.weight_g,
      product: p.dhl_product,
      printFormat: ziel?.dhlFormat ?? undefined,
    })
    if (result.warnings.length > 0) {
      await sql`select log_event('stock_picking', ${pickingId}, 'note',
        ${`DHL-Hinweise zur Adresse: ${result.warnings.join(' | ')}`}, 'system')`
    }
  } catch (err) {
    // Fehler dauerhaft am Beleg festhalten — nicht nur flüchtig in der UI.
    const message = err instanceof Error ? err.message : String(err)
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`DHL-Label fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    throw err
  }
  const buchung = await nachLabelAusbuchen(pickingId, result.shipmentId, p.nicht_ausbuchen)
  const druck = await drucken(
    'versandlabel',
    { art: 'label', shipmentId: result.shipmentId },
    { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
    ziel,
  )
  const teile = [
    `Label ${result.shipmentNumber} erstellt (${result.product})`,
    buchung.ausgebucht ? 'ausgebucht, Shop-Rückmeldung eingereiht' : buchung.hinweis,
  ].filter(Boolean)
  return {
    text: `${teile.join(' — ')}.${druck.gedruckt ? ` ${druck.meldung}` : ''}`,
    recordId: result.shipmentId,
    ...(druck.gedruckt ? {} : { link: `/api/label/${result.shipmentId}` }),
  }
}

/**
 * Adresse prüfen (Entscheidungslog 2026-10-01): DHL prüft die Sendung mit
 * validate=true — derselbe Request wie „Label erstellen", im Format des
 * Labeldruckers am Platz, aber ohne Label und ohne Buchung. Gespeichert wird
 * nur der Protokolleintrag an der Lieferung. Beanstandet DHL etwas (Fehler
 * ODER Hinweis), endet die Aktion mit der Meldung als Fehler — rot am Knopf,
 * damit niemand ein „ok" überliest.
 */
export async function adressePruefen(
  p: { weight_g?: number; dhl_product?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'versandlabel')
  let r: Awaited<ReturnType<typeof adresseFuerPickingPruefen>>
  try {
    r = await adresseFuerPickingPruefen(pickingId, {
      weightG: p.weight_g,
      product: p.dhl_product,
      printFormat: ziel?.dhlFormat ?? undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Adresse prüfen: ${message.slice(0, 300)}`}, ${ctx.actor})`.catch(() => undefined)
    throw err
  }
  const text = pruefText(r.pruefung, r.adresse)
  await sql`select log_event('stock_picking', ${pickingId}, ${r.pruefung.ok ? 'note' : 'error'},
    ${`Adresse bei DHL geprüft: ${text}`.slice(0, 1000)}, ${ctx.actor})`
  if (!r.pruefung.ok) throw new Error(text)
  return { text, recordId: pickingId, daten: { ...r.pruefung } }
}

/**
 * Der Packtisch-Abschluss: gescannte Positionen prüfen, Label erstellen
 * (oder ein vorhandenes wiederverwenden — macht die Aktion nach einem
 * Teilfehler gefahrlos wiederholbar), Warenausgang buchen, Kartonage
 * verbrauchen, Shop-Rückmeldung einreihen. Die Bausteine sind dieselben
 * wie in transferBuchen/massendruck — hier als EIN Prozessschritt.
 */
export async function packtischAbschliessen(
  p: { gepackt: Record<string, number>; weight_g?: number; dhl_product?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const pickingId = ctx.recordId!

  // Soll-Positionen der Lieferung — gescannt wird gegen SKU ODER Barcode.
  // Je VARIANTE aggregiert: zwei Auftragszeilen derselben Variante teilen
  // sich einen Scan-Schlüssel; unaggregiert würde jede Zeile einzeln gegen
  // dieselbe gescannte Menge geprüft und eine Unterdeckung durchrutschen.
  const soll = await sql<
    { qty: number; sku: string | null; barcode: string | null; product: string }[]
  >`
    select sum(m.qty)::float as qty, pv.sku, pv.barcode,
           variant_display_name(m.variant_id) as product
    from stock_moves m
    join product_variants pv on pv.id = m.variant_id
    where m.picking_id = ${pickingId} and m.state <> 'cancel'
    group by m.variant_id, pv.sku, pv.barcode`
  if (soll.length === 0) throw new Error('Die Lieferung hat keine offenen Positionen.')

  const abgleich = packtischAbgleich(soll, p.gepackt)
  if (abgleich.fehlend.length > 0) {
    throw new Error(`Noch nicht vollständig gescannt: ${abgleich.fehlend.join(', ')}.`)
  }
  if (abgleich.fremd.length > 0) {
    throw new Error(
      `Gescannte Artikel gehören nicht zu dieser Lieferung: ${abgleich.fremd.join(', ')}.`,
    )
  }

  // Label: ein vorhandenes wird wiederverwendet (Wiederholung nach
  // Teilfehler), sonst frisch erstellt — im Format des Labeldruckers am
  // Platz (0087).
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'versandlabel')
  const [vorhanden] = await sql<{ id: string; shipment_number: string }[]>`
    select id, shipment_number from shipments
    where picking_id = ${pickingId} and state <> 'cancelled'
      and (label_pdf is not null or label_path is not null)
    order by created_at desc limit 1`
  let shipmentId: string
  let sendung: string
  if (vorhanden) {
    shipmentId = vorhanden.id
    sendung = vorhanden.shipment_number
  } else {
    const result = await createLabelForPicking(pickingId, {
      weightG: p.weight_g,
      product: p.dhl_product,
      printFormat: ziel?.dhlFormat ?? undefined,
    })
    shipmentId = result.shipmentId
    sendung = result.shipmentNumber
    if (result.warnings.length > 0) {
      await sql`select log_event('stock_picking', ${pickingId}, 'note',
        ${`DHL-Hinweise zur Adresse: ${result.warnings.join(' | ')}`}, 'system')`
    }
  }

  // Warenausgang — bereits gebuchte Lieferung (Wiederholungsfall) überspringen.
  const [zustand] = await sql<{ state: string }[]>`
    select state from stock_pickings where id = ${pickingId}`
  if (zustand?.state !== 'done') {
    await sql`select picking_validate(${pickingId}, ${sql.json({})}, false)`
    await consumePackagingForPicking(pickingId).catch(() => undefined)
  }

  // Shop-Rückmeldung (Fulfillment + Tracking, Shopify mailt den Kunden) —
  // darf den Abschluss nie blockieren, muss aber eine Spur hinterlassen.
  try {
    await queueFulfillmentForPicking(pickingId)
  } catch (err) {
    await sql`select log_event('stock_picking', ${pickingId}, 'error',
      ${`Shopify-Rückmeldung konnte nicht eingereiht werden: ${err instanceof Error ? err.message : String(err)}`})`
      .catch(() => undefined)
  }

  // Druck: über die Brücke still am Labeldrucker des Tisches — dann KEIN
  // Link, sonst öffnete der Packtisch zusätzlich einen Tab (Doppeldruck).
  // Ohne Drucker bleibt das PDF im Browser.
  const druck = await drucken(
    'versandlabel',
    { art: 'label', shipmentId },
    { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
    ziel,
  )

  return {
    text: `Sendung ${sendung} abgeschlossen — Ware gebucht, Shop-Rückmeldung eingereiht.${druck.gedruckt ? ` ${druck.meldung}` : ''}`,
    recordId: pickingId,
    ...(druck.gedruckt ? {} : { link: `/api/label/${shipmentId}` }),
  }
}

export async function labelStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await cancelShipmentById(ctx.recordId!)
  return {}
}

export async function trackingAktualisieren(): Promise<AktionsErgebnis> {
  const r = await syncTracking(20)
  const text = `${r.checked} Sendung(en) geprüft, ${r.updated} aktualisiert.`
  return { text: r.fehler ? `${text} Abbruch: ${r.fehler}` : text }
}

/** Höchstzahl je Massendruck-Lauf — DHL-Aufrufe laufen nacheinander. */
const MASSENDRUCK_LIMIT = 25

export async function massendruck(
  p: {
    einzel: boolean
    sku: string
    land: string
    produkt: string
    nicht_ausbuchen: boolean
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const rows = await versandbereitMitVorschlag({
    nurEinzelposition: p.einzel,
    sku: p.sku,
    land: p.land,
    produkt: p.produkt,
  })
  const offen = rows.filter((r) => Number(r.shipment_count) === 0)
  if (offen.length === 0) throw new Error('Kein Treffer ohne vorhandenes Label.')

  const stapel = offen.slice(0, MASSENDRUCK_LIMIT)
  const shipmentIds: string[] = []
  const fehler: string[] = []
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'versandlabel')
  let meldung: string | null = null
  let ausgebucht = 0

  for (const r of stapel) {
    try {
      const result = await createLabelForPicking(r.picking_id, {
        printFormat: ziel?.dhlFormat ?? undefined,
      })
      shipmentIds.push(result.shipmentId)
      const druck = await drucken(
        'versandlabel',
        { art: 'label', shipmentId: result.shipmentId },
        { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor },
        ziel,
      )
      if (druck.gedruckt) meldung = druck.meldung
      const buchung = await nachLabelAusbuchen(r.picking_id, result.shipmentId, p.nicht_ausbuchen)
      if (buchung.ausgebucht) ausgebucht++
      else if (!p.nicht_ausbuchen && buchung.hinweis) fehler.push(`${r.picking_number}: ${buchung.hinweis}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fehler.push(`${r.picking_number}: ${message}`)
      await sql`select log_event('stock_picking', ${r.picking_id}, 'error',
        ${`Massendruck fehlgeschlagen: ${message.slice(0, 300)}`}, 'system')`.catch(() => undefined)
    }
  }

  const rest = offen.length - stapel.length
  const teile = [
    `${shipmentIds.length} Label${shipmentIds.length === 1 ? '' : 's'} erstellt`,
    p.nicht_ausbuchen ? 'nicht ausgebucht (nur Labels)' : `${ausgebucht} ausgebucht`,
    rest > 0 ? `${rest} weitere warten (Grenze ${MASSENDRUCK_LIMIT} je Lauf)` : null,
    fehler.length ? `${fehler.length} Fehler: ${fehler.slice(0, 3).join(' | ')}` : null,
  ].filter(Boolean)

  if (shipmentIds.length === 0) throw new Error(teile.join(' — '))
  // Über die Brücke gedruckt: kein Sammel-PDF obendrauf (Doppeldruck).
  if (meldung) return { text: `${teile.join(' — ')}. ${meldung}` }
  return { text: teile.join(' — ') + '.', link: `/api/label/sammel?ids=${shipmentIds.join(',')}` }
}

/** Artikelgewicht im Versand setzen (2026-10-01) — am Artikel, für alle Varianten. */
export async function artikelgewichtSetzen(
  p: { variant_id: string; weight_g: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [artikel] = await sql<{ id: string; name: string }[]>`
    update product_templates pt set weight_g = ${p.weight_g}
    from product_variants pv
    where pv.id = ${p.variant_id} and pt.id = pv.template_id
    returning pt.id, pt.name`
  if (!artikel) throw new Error('Artikel nicht gefunden')
  await sql`select log_event('product_template', ${artikel.id}, 'note',
    ${`Gewicht im Versand gesetzt: ${p.weight_g} g`}, ${ctx.actor})`
  return { text: `${artikel.name}: ${p.weight_g} g gespeichert.`, daten: { weight_g: p.weight_g } }
}

/** Gewichte aus Shopify übernehmen (2026-10-01) — nur wo keines gepflegt ist. */
export async function gewichteAusShopifyUebernehmen(p: { ueberschreiben: boolean }): Promise<AktionsErgebnis> {
  const r = await gewichteAusShopify(p.ueberschreiben)
  const teile = [
    `${r.gesetzt} Gewicht${r.gesetzt === 1 ? '' : 'e'} übernommen`,
    r.schonGepflegt ? `${r.schonGepflegt} schon gepflegt` : null,
    r.ohneGewichtImShop ? `${r.ohneGewichtImShop} ohne Gewicht im Shop` : null,
  ].filter(Boolean)
  return { text: `${teile.join(' · ')} (${r.gelesen} Shop-Varianten gelesen).`, daten: { ...r } }
}

/**
 * Nachholen (2026-10-01): Lieferungen mit Label, die nicht ausgebucht sind —
 * jede wird gebucht wie direkt nach dem Label (Warenausgang, Kartonage,
 * Shop-Rückmeldung mit der Sendungsnummer des Labels).
 */
export async function gelabelteAusbuchen(p: { ids?: string[] }): Promise<AktionsErgebnis> {
  const offen = await gelabeltNichtAusgebucht(p.ids)
  if (offen.length === 0) throw new Error('Keine Lieferung mit Label, die noch nicht ausgebucht ist.')
  let ausgebucht = 0
  const fehler: string[] = []
  for (const r of offen) {
    const buchung = await nachLabelAusbuchen(r.picking_id, r.shipment_id, false)
    if (buchung.ausgebucht) ausgebucht++
    else fehler.push(`${r.picking_number}: ${buchung.hinweis}`)
  }
  const teile = [
    `${ausgebucht} Lieferung${ausgebucht === 1 ? '' : 'en'} ausgebucht, Shop-Rückmeldung eingereiht`,
    fehler.length ? `${fehler.length} nicht: ${fehler.slice(0, 3).join(' | ')}` : null,
  ].filter(Boolean)
  if (ausgebucht === 0) throw new Error(teile.join(' — '))
  return { text: `${teile.join(' — ')}.`, daten: { ausgebucht, fehler: fehler.length } }
}

/**
 * Packzettel der Auswahl drucken (0091): am A4-Drucker des Arbeitsplatzes
 * bzw. Ersatz — sonst der Sammeldruck im Browser. Der Zeitpunkt steht an
 * der Lieferung (Marke „Zettel gedruckt" im Versand).
 */
export async function packzettelDrucken(
  p: { ids: string[] },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const ziel = await zielDrucker(ctx.arbeitsplatzId, 'packzettel')
  let meldung: string | null = null
  if (ziel) {
    for (const pickingId of p.ids) {
      const druck = await drucken('packzettel', { art: 'packzettel', pickingId }, { arbeitsplatzId: ctx.arbeitsplatzId, von: ctx.actor }, ziel)
      if (druck.gedruckt) meldung = druck.meldung
    }
  }
  await sql`update stock_pickings set packzettel_gedruckt_am = now() where id = any(${p.ids}::uuid[])`
  if (meldung) return { text: `${p.ids.length} Packzettel: ${meldung}` }
  return {
    text: `${p.ids.length} Packzettel — kein Drucker für Packzettel am Arbeitsplatz, Sammeldruck im Browser.`,
    link: `/versand/packzettel?ids=${p.ids.join(',')}`,
  }
}

export async function retourenlabelErstellen(p: {
  partner_id: string
  reference?: string
}): Promise<AktionsErgebnis> {
  await createReturnLabelForPartner(p.partner_id, { reference: p.reference })
  return { text: 'Retourenlabel erstellt und an den Kunden gemailt.' }
}

// --- Kartonagen (Versand-Konfiguration) --------------------------------------

export async function kartonageSpeichern(p: {
  id?: string
  name: string
  variant_id: string
  capacity: number
  max_content_g: number
  kleinpaket: boolean
  sequence: number
}): Promise<AktionsErgebnis> {
  if (p.id) {
    await sql`
      update packagings set
        name = ${p.name}, variant_id = ${p.variant_id}, capacity = ${p.capacity},
        max_content_g = ${p.max_content_g}, kleinpaket = ${p.kleinpaket},
        sequence = ${p.sequence}
      where id = ${p.id}`
  } else {
    await sql`
      insert into packagings (name, variant_id, capacity, max_content_g, kleinpaket, sequence)
      values (${p.name}, ${p.variant_id}, ${p.capacity}, ${p.max_content_g},
              ${p.kleinpaket}, ${p.sequence})`
  }
  return { text: 'Kartonage gespeichert.' }
}

export async function kartonageSchalten(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update packagings set active = not active where id = ${ctx.recordId!}`
  return {}
}

export async function kartonageLoeschen(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from packagings where id = ${ctx.recordId!}`
  return {}
}

// --- Versandregeln -----------------------------------------------------------

export async function versandregelSpeichern(p: {
  id?: string
  name: string
  sequence: number
  min_weight_g: number | null
  max_weight_g: number | null
  zone: string | null
  skus: string[] | null
  sku_scope: string
  require_kleinpaket_fit: boolean
  dhl_product: string | null
  billing_number: string | null
  insurance_from_value: number | null
}): Promise<AktionsErgebnis> {
  if (p.id) {
    await sql`
      update shipping_rules set
        name = ${p.name}, sequence = ${p.sequence},
        min_weight_g = ${p.min_weight_g}, max_weight_g = ${p.max_weight_g},
        zone = ${p.zone}, skus = ${p.skus}, sku_scope = ${p.sku_scope},
        require_kleinpaket_fit = ${p.require_kleinpaket_fit},
        dhl_product = ${p.dhl_product}, billing_number = ${p.billing_number},
        insurance_from_value = ${p.insurance_from_value}
      where id = ${p.id}`
  } else {
    await sql`
      insert into shipping_rules
        (name, sequence, min_weight_g, max_weight_g, zone, skus, sku_scope,
         require_kleinpaket_fit, dhl_product, billing_number, insurance_from_value)
      values
        (${p.name}, ${p.sequence}, ${p.min_weight_g}, ${p.max_weight_g}, ${p.zone},
         ${p.skus}, ${p.sku_scope}, ${p.require_kleinpaket_fit}, ${p.dhl_product},
         ${p.billing_number}, ${p.insurance_from_value})`
  }
  return { text: 'Regel gespeichert.' }
}

export async function versandregelSchalten(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update shipping_rules set active = not active where id = ${ctx.recordId!}`
  return {}
}

export async function versandregelLoeschen(
  _p: Record<string, never>,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`delete from shipping_rules where id = ${ctx.recordId!}`
  return {}
}

export async function versandregelVerschieben(
  p: { richtung: 'hoch' | 'runter' },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const regeln = await sql<{ id: string; sequence: number }[]>`
    select id, sequence from shipping_rules order by sequence, name`
  const index = regeln.findIndex((r) => r.id === id)
  const nachbar = p.richtung === 'hoch' ? index - 1 : index + 1
  if (index < 0 || nachbar < 0 || nachbar >= regeln.length) return {}

  // Gleiche sequence-Werte machen den Tausch wirkungslos — dann neu
  // durchnummerieren und noch einmal.
  if (regeln[index].sequence === regeln[nachbar].sequence) {
    for (const [i, r] of regeln.entries()) {
      await sql`update shipping_rules set sequence = ${(i + 1) * 10} where id = ${r.id}`
    }
    return versandregelVerschieben(p, ctx)
  }
  await sql`update shipping_rules set sequence = ${regeln[nachbar].sequence}
            where id = ${regeln[index].id}`
  await sql`update shipping_rules set sequence = ${regeln[index].sequence}
            where id = ${regeln[nachbar].id}`
  return {}
}
