import { sql } from '@/db/client'
import { stornoNachlauf } from '@/modules/verkauf/storno-nachlauf'
import { partnerAufloesen, varianteAufloesen } from './aufloesen.ts'
import type { AktionsErgebnis, AktionsKontext, PositionsZeile } from './typen.ts'

/** Ausführung der Verkaufs-Aktionen — Fachlogik unverändert aus verkauf/actions.ts. */

export async function auftragAnlegen(p: { partner_id: string }): Promise<AktionsErgebnis> {
  const [order] = await sql<{ id: string; number: string }[]>`
    insert into sales_orders (number, partner_id)
    values (next_sequence('sale'), ${p.partner_id})
    returning id, number`

  // Lieferadresse aus dem Kontakt vorbelegen.
  await sql`
    update sales_orders so set
      ship_name = pa.name, ship_street = pa.street, ship_house_number = pa.house_number,
      ship_street2 = pa.street2, ship_zip = pa.zip, ship_city = pa.city,
      ship_country_code = pa.country_code, ship_phone = pa.phone, ship_email = pa.email
    from partners pa where pa.id = so.partner_id and so.id = ${order.id}`

  return {
    text: `Angebot ${order.number} angelegt.`,
    link: `/verkauf/${order.id}`,
    recordId: order.id,
  }
}

/**
 * BUG/00012: Am Telefon ist der Kunde oft neu — dann scheiterte der Auftrag
 * bisher daran, dass die Kontaktanlage eine andere Seite war. Kontakt und
 * Angebot entstehen jetzt in EINER Aktion: eine Torwächter-Prüfung, ein
 * Protokolleintrag, ein Weg. Die Kontaktanlage selbst bleibt die aus
 * kontakte-ausfuehren — kein zweiter Dialekt.
 */
export async function auftragFuerNeuenKunden(
  p: {
    name?: string
    vorname?: string
    nachname?: string
    is_company: boolean
    email?: string
    phone?: string
    street?: string
    house_number?: string
    zip?: string
    city?: string
    country_code: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const { partnerAnlegen } = await import('./kontakte-ausfuehren.ts')
  const kunde = await partnerAnlegen(
    { ...p, is_customer: true, is_vendor: false, vat: undefined },
    ctx,
  )
  const auftrag = await auftragAnlegen({ partner_id: kunde.recordId! })
  return { ...auftrag, text: `${kunde.text} ${auftrag.text}` }
}

/**
 * Kombi-Aktion für KI und API: Kopf + Zeilen in einem Aufruf. Sie KOMPONIERT
 * die bestehenden Aktionen (auftragAnlegen, positionHinzufuegen) — dadurch
 * kommen Lieferadresse, Einheit, Listenpreis und Statusneuberechnung gratis
 * und es gibt keinen zweiten Zeilen-Dialekt.
 */
export async function auftragMitPositionen(
  p: { kunde: string; positionen: PositionsZeile[]; hinweis?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Alle Kennungen VOR dem Kopf-Insert auflösen — scheitert eine, entsteht
  // gar kein Beleg statt ein halber.
  const kunde = await partnerAufloesen(sql, p.kunde, 'kunde')
  const varianten = []
  for (const pos of p.positionen) varianten.push(await varianteAufloesen(sql, pos.produkt))

  const kopf = await auftragAnlegen({ partner_id: kunde.id })
  const orderId = kopf.recordId!
  if (p.hinweis) await sql`update sales_orders set note = ${p.hinweis} where id = ${orderId}`

  for (const [i, pos] of p.positionen.entries()) {
    await positionHinzufuegen(
      { variant_id: varianten[i].id, qty: pos.menge, price_unit: pos.preis },
      { ...ctx, recordId: orderId },
    )
  }

  const [order] = await sql<{ number: string }[]>`
    select number from sales_orders where id = ${orderId}`
  return {
    text: `Angebot ${order.number} für ${kunde.name} mit ${p.positionen.length} Position(en) angelegt.`,
    link: `/verkauf/${orderId}`,
    recordId: orderId,
  }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select confirm_sales_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/** Der Satz, mit dem KRNL Storno und Reaktivierung von Shop-Aufträgen ablehnt. */
export const SHOP_STORNO_HINWEIS =
  'Shop-Bestellungen storniert Shopify: bitte im Shopify-Admin stornieren (mit Erstattung) — ' +
  'KRNL übernimmt den Storno dann automatisch samt Lieferung, Fertigung und DHL-Label.'

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [auftrag] = await sql<{ source: string }[]>`
    select source from sales_orders where id = ${ctx.recordId!}`

  // Storno führt Shopify (Entscheidungslog 2026-10-02): kein Storno aus KRNL,
  // keine Meldung an den Shop. Der Shop-Webhook storniert hier.
  if (auftrag?.source === 'shopify') throw new Error(SHOP_STORNO_HINWEIS)

  await sql`select cancel_sales_order(${ctx.recordId!}, ${ctx.actor})`
  const nachlauf = await stornoNachlauf(ctx.recordId!, ctx.actor)
  return {
    recordId: ctx.recordId,
    text: nachlauf.aufgaben
      ? 'Storniert — ein Paket ist schon ausgebucht, aber nicht übergeben: Aufgabe fürs Lager angelegt.'
      : undefined,
  }
}

export async function zurueckAufAngebot(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Ein in Shopify stornierter Auftrag lebt hier nicht wieder auf — Shopify führt.
  const [auftrag] = await sql<{ source: string }[]>`
    select source from sales_orders where id = ${ctx.recordId!}`
  if (auftrag?.source === 'shopify') throw new Error(SHOP_STORNO_HINWEIS)

  await sql`update sales_orders set state = 'draft', locked = false
            where id = ${ctx.recordId!} and state in ('cancel', 'sent')`
  await sql`select log_event('sales_order', ${ctx.recordId!}, 'state',
    'Auf Angebot zurückgesetzt', ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function kopfAendern(
  p: {
    user_id?: string
    client_order_ref?: string
    commitment_date?: string
    validity_date?: string
    payment_term_id?: string
    incoterm_code?: string
    incoterm_location?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update sales_orders set
      user_id = ${p.user_id ?? null},
      client_order_ref = ${p.client_order_ref ?? null},
      commitment_date = ${p.commitment_date ? new Date(p.commitment_date).toISOString() : null},
      validity_date = ${p.validity_date ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      incoterm_code = ${p.incoterm_code ?? null},
      incoterm_location = ${p.incoterm_location ?? null}
    where id = ${ctx.recordId!} and state <> 'cancel' and not locked`
  return { recordId: ctx.recordId }
}

export async function sperren(
  p: { locked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update sales_orders set locked = ${p.locked}
            where id = ${ctx.recordId!} and state = 'sale'`
  await sql`select log_event('sales_order', ${ctx.recordId!}, 'state',
    ${p.locked ? 'Auftrag gesperrt' : 'Auftrag entsperrt'}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function positionHinzufuegen(
  p: { variant_id: string; qty: number; price_unit?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select sales_order_guard_editable(${orderId})`

  const [info] = await sql<{ uom_id: string; name: string; price: number }[]>`
    select pt.uom_id, variant_display_name(pv.id) as name,
           pt.list_price + pv.price_extra as price
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`
  if (!info) throw new Error('Produkt nicht gefunden')

  await sql`
    insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
    values (
      ${orderId},
      coalesce((select max(sequence) + 10 from sales_order_lines where order_id = ${orderId}), 10),
      ${p.variant_id}, ${info.name}, ${p.qty}, ${info.uom_id},
      ${p.price_unit ?? Number(info.price)})`

  await sql`select sales_order_recompute_status(${orderId})`
  return { recordId: orderId }
}

export async function positionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select sales_order_guard_editable(${orderId})`
  await sql`delete from sales_order_lines where id = ${p.line_id} and order_id = ${orderId}`
  await sql`select sales_order_recompute_status(${orderId})`
  return { recordId: orderId }
}

// --- Kundenrechnungen (0115) ----------------------------------------------------

export async function rechnungErstellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [r] = await sql<{ id: string }[]>`
    select kundenrechnung_aus_lieferung(${ctx.recordId!}, ${ctx.actor}) as id`
  const [k] = await sql<{ nummer: string; brutto: number }[]>`
    select nummer, brutto from kundenrechnungen where id = ${r.id}`
  return {
    text: `Rechnung ${k.nummer} über ${Number(k.brutto).toFixed(2)} € erstellt.`,
    link: `/verkauf/rechnungen/${r.id}`,
    recordId: r.id,
  }
}

export async function rechnungZahlen(
  p: { datum?: string; betrag?: number; bankkonto_id?: string; zahlungsart?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const id = ctx.recordId!
  const [k] = await sql<{ art: string; nummer: string; offen: number }[]>`
    select art::text as art, nummer, kundenrechnung_offen(id) as offen from kundenrechnungen where id = ${id}`
  if (!k) throw new Error('Rechnung nicht gefunden')
  if (p.bankkonto_id || p.betrag) {
    // Über das Zahlungsregister: Teilbeträge möglich, bezahlt bei voller Deckung.
    const betrag = p.betrag ?? Number(k.offen)
    await sql`
      select zahlung_erfassen(${k.art === 'rechnung' ? 'ein' : 'aus'}, ${betrag}, 'EUR',
        ${p.datum ?? sql`current_date`}, ${p.bankkonto_id ?? null}, 'kundenrechnung', ${id},
        ${k.art === 'rechnung' ? `Rechnung ${k.nummer}` : `Erstattung ${k.nummer}`}, ${ctx.actor})`
  } else {
    await sql`select kundenrechnung_zahlen(${id}, ${p.datum ?? sql`current_date`}, ${p.zahlungsart ?? null}, ${ctx.actor})`
  }
  const [nachher] = await sql<{ status: string; offen: number }[]>`
    select status::text as status, kundenrechnung_offen(id) as offen from kundenrechnungen where id = ${id}`
  return {
    recordId: id,
    text: nachher.status === 'bezahlt'
      ? `${k.nummer} ist ${k.art === 'rechnung' ? 'bezahlt' : 'erstattet'}.`
      : `Zahlung erfasst — offen bleiben ${Number(nachher.offen).toFixed(2)} €.`,
  }
}

export async function rechnungStornieren(p: { grund?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [g] = await sql<{ id: string }[]>`
    select kundenrechnung_stornieren(${ctx.recordId!}, ${p.grund ?? null}, ${ctx.actor}) as id`
  const [k] = await sql<{ nummer: string; status: string }[]>`
    select nummer, status::text as status from kundenrechnungen where id = ${g.id}`
  return {
    recordId: ctx.recordId,
    text: `Gutschrift ${k.nummer} erstellt${k.status === 'offen' ? ' — die Erstattung steht noch aus' : ''}.`,
    link: `/verkauf/rechnungen/${g.id}`,
  }
}

export async function gutschriftErstellen(
  p: { positionen: { position_id: string; menge: number }[]; grund?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [g] = await sql<{ id: string }[]>`
    select kundenrechnung_gutschrift(${ctx.recordId!}, ${sql.json(p.positionen as never)}, ${p.grund ?? null}, ${ctx.actor}) as id`
  const [k] = await sql<{ nummer: string; brutto: number }[]>`select nummer, brutto from kundenrechnungen where id = ${g.id}`
  return {
    recordId: ctx.recordId,
    text: `Teilgutschrift ${k.nummer} über ${Number(k.brutto).toFixed(2)} € erstellt.`,
    link: `/verkauf/rechnungen/${g.id}`,
  }
}

export async function rechnungMahnen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [r] = await sql<{ stufe: number }[]>`select kundenrechnung_mahnen(${ctx.recordId!}, ${ctx.actor}) as stufe`
  const text = ['Zahlungserinnerung', '1. Mahnung', '2. Mahnung'][Number(r.stufe) - 1] ?? `Mahnstufe ${r.stufe}`
  return { recordId: ctx.recordId, text: `${text} erstellt — das Schreiben liegt als PDF am Beleg.`, link: `/api/verkauf/rechnung/${ctx.recordId}?art=mahnung` }
}

export async function rechnungDetails(p: { notiz?: string; faellig_am?: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`
    update kundenrechnungen set
      notiz = ${p.notiz ?? null},
      faellig_am = coalesce(${p.faellig_am ?? null}::date, faellig_am)
    where id = ${ctx.recordId!} and status = 'offen'`
  return { recordId: ctx.recordId }
}

export async function rechnungProbelaufLoeschen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [r] = await sql<{ n: number }[]>`select kundenrechnung_probelauf_loeschen(${ctx.actor}) as n`
  return {
    text:
      r.n > 0
        ? `${r.n} Testbeleg(e) des Probelaufs gelöscht — Probe-Nummernkreise stehen wieder auf 1. Jetzt kann die Rechnung scharf geschaltet werden (Einstellungen → Belege).`
        : 'Kein Testbeleg vorhanden — nichts zu löschen.',
    link: '/einstellungen/belege',
  }
}

export async function datevUebergeben(p: { von: string; bis: string }, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const r = await sql`
    update kundenrechnungen set datev_uebergeben_am = now()
    where rechnungsdatum between ${p.von}::date and ${p.bis}::date and datev_uebergeben_am is null and not probe`
  await sql`select log_event('settings', gen_random_uuid(), 'note',
    ${`DATEV: ${r.count} Kundenbeleg(e) ${p.von}–${p.bis} als übergeben markiert`}, ${ctx.actor})`
  return { text: `${r.count} Beleg(e) als an DATEV übergeben markiert.` }
}

