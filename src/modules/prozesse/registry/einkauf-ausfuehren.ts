import { sql, tx } from '@/db/client'
import { money, qty } from '@/modules/shared/format'
import { htmlSicher } from '@/modules/integrationen/mail'
import { produktAnlegen } from '@/modules/ki/produkt-anlegen'
import { partnerAufloesen, varianteAufloesen } from './aufloesen.ts'
import { type BelegBestellung, belegPositionenPruefen } from './einkauf.ts'
import type { AktionsErgebnis, AktionsKontext, PositionsZeile } from './typen.ts'

/** Ausführung der Einkaufs-Aktionen — Fachlogik unverändert aus einkauf/actions.ts. */

export async function bestellungAnlegen(p: { vendor_id: string }): Promise<AktionsErgebnis> {
  const [order] = await sql<{ id: string; number: string }[]>`
    insert into purchase_orders (number, vendor_id)
    values (next_sequence('purchase'), ${p.vendor_id}) returning id, number`
  return {
    text: `Bestellung ${order.number} angelegt.`,
    link: `/einkauf/${order.id}`,
    recordId: order.id,
  }
}

export async function positionHinzufuegen(
  p: { variant_id: string; qty: number; price_unit?: number; discount?: number },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select purchase_order_guard_editable(${orderId})`

  const [order] = await sql<{ vendor_id: string }[]>`
    select vendor_id from purchase_orders where id = ${orderId}`

  const [info] = await sql<{ purchase_uom: string; name: string; cost: number }[]>`
    select coalesce(pt.purchase_uom_id, pt.uom_id) as purchase_uom,
           variant_display_name(pv.id) as name, pt.standard_cost as cost
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`
  if (!info) throw new Error('Produkt nicht gefunden')

  // Preis + Rabatt aus der Lieferantenpreisliste, sonst Standardkosten.
  const [vendorPrice] = await sql<{ price: number | null; discount: number | null }[]>`
    select (best_vendor_price(${p.variant_id}, ${order.vendor_id}, ${p.qty})).price as price,
           (best_vendor_price(${p.variant_id}, ${order.vendor_id}, ${p.qty})).discount as discount`

  const price = p.price_unit ?? Number(vendorPrice?.price ?? info.cost ?? 0)
  const discount = p.discount ?? Number(vendorPrice?.discount ?? 0)

  await sql`
    insert into purchase_order_lines
      (order_id, sequence, variant_id, name, qty, uom_id, price_unit, discount, tax_id, tax_rate)
    select ${orderId},
           coalesce((select max(sequence) + 10 from purchase_order_lines where order_id = ${orderId}), 10),
           ${p.variant_id}, ${info.name}, ${p.qty}, ${info.purchase_uom}, ${price}, ${discount},
           pt.purchase_tax_id,
           coalesce((select amount from taxes where id = pt.purchase_tax_id), 19)
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pv.id = ${p.variant_id}`

  return { recordId: orderId }
}

/**
 * Kombi-Aktion für KI und API: Kopf + Zeilen in einem Aufruf. Komponiert
 * bestellungAnlegen + positionHinzufuegen — Lieferantenpreisliste (Staffel,
 * Rabatt), Einkaufseinheit und Steuersatz kommen dadurch gratis mit.
 */
export async function bestellungMitPositionen(
  p: { lieferant: string; positionen: PositionsZeile[]; hinweis?: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  // Alle Kennungen VOR dem Kopf-Insert auflösen — scheitert eine, entsteht
  // gar kein Beleg statt ein halber.
  const lieferant = await partnerAufloesen(sql, p.lieferant, 'lieferant')
  const varianten = []
  for (const pos of p.positionen) varianten.push(await varianteAufloesen(sql, pos.produkt))

  const kopf = await bestellungAnlegen({ vendor_id: lieferant.id })
  const orderId = kopf.recordId!
  if (p.hinweis) await sql`update purchase_orders set note = ${p.hinweis} where id = ${orderId}`

  for (const [i, pos] of p.positionen.entries()) {
    await positionHinzufuegen(
      { variant_id: varianten[i].id, qty: pos.menge, price_unit: pos.preis },
      { ...ctx, recordId: orderId },
    )
  }

  const [order] = await sql<{ number: string }[]>`
    select number from purchase_orders where id = ${orderId}`
  return {
    text: `Bestellung ${order.number} bei ${lieferant.name} mit ${p.positionen.length} Position(en) angelegt.`,
    link: `/einkauf/${orderId}`,
    recordId: orderId,
  }
}

/** Dienstleistungs-Artikel für Fracht laut Beleg (einmal angelegt, danach wiederverwendet). */
async function frachtArtikel(t: typeof sql): Promise<string> {
  const name = 'Fracht laut Beleg (Einkauf)'
  const [da] = await t<{ id: string }[]>`
    select pv.id from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pt.name = ${name} and pt.type = 'service' and pv.active
    order by pv.created_at limit 1`
  if (da) return da.id
  const [tpl] = await t<{ id: string }[]>`
    insert into product_templates (name, type, uom_id, can_be_sold, can_be_purchased)
    values (${name}, 'service', (select id from uoms where name = 'Stück' limit 1), false, true)
    returning id`
  await t`select generate_variants(${tpl.id})`
  const [v] = await t<{ id: string }[]>`select id from product_variants where template_id = ${tpl.id} limit 1`
  return v.id
}

/**
 * Bestellung aus einem Beleg (KI-Chat, 2026-10-15): eine außerhalb von KRNL
 * schon getätigte Bestellung nachträglich erfassen — Lieferant und Artikel
 * bei Bedarf mit anlegen, Fracht als Dienstleistungszeile, gleich bestätigen
 * (der Wareneingang entsteht) und die Vorkasse als bezahlt vermerken. Alles
 * in EINER Transaktion: scheitert ein Schritt, entsteht kein halber Beleg.
 */
export async function bestellungErfassen(p: BelegBestellung, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const zeilenFehler = belegPositionenPruefen(p.positionen)
  if (zeilenFehler) throw new Error(zeilenFehler)
  const waehrung = p.waehrung.toUpperCase()
  const incoterm = p.incoterm_code?.trim().toUpperCase() || null

  const erfasst = await tx(async (tr) => {
    const t = tr as unknown as typeof sql
    const [cur] = await t<{ code: string }[]>`select code from currencies where code = ${waehrung}`
    if (!cur) throw new Error(`Währung ${waehrung} ist nicht angelegt (Einstellungen → Währungen).`)
    if (incoterm) {
      const [ic] = await t<{ code: string }[]>`select code from incoterms where code = ${incoterm}`
      if (!ic) throw new Error(`Incoterm ${incoterm} ist unbekannt.`)
    }
    // Ohne hinterlegten Kurs rechnet KRNL 1:1 (exchange_rate_at) — das soll
    // niemand still übersehen, deshalb ein Hinweis im Ergebnis.
    const [kurs] = waehrung === 'EUR'
      ? [{ da: true }]
      : await t<{ da: boolean }[]>`select exists (select 1 from exchange_rates where currency = ${waehrung}) as da`
    const hinweise: string[] = []
    if (!kurs?.da) hinweise.push(`kein ${waehrung}-Kurs hinterlegt — Beträge zählen vorerst 1:1 in Euro (EZB-Kurse holen)`)

    // Lieferant: vorhandener gewinnt, neu nur wenn erlaubt und noch nicht da.
    let lieferant: { id: string; name: string }
    let neuerLieferant = false
    try {
      lieferant = await partnerAufloesen(t, p.lieferant, 'lieferant')
    } catch (err) {
      if (!p.lieferant_neu || !/nicht gefunden/.test(err instanceof Error ? err.message : '')) throw err
      const land = p.lieferant_land?.toUpperCase()
      if (!land) throw new Error('Für einen neuen Lieferanten bitte lieferant_land (ISO-2, z. B. CN) angeben.')
      const [neu] = await t<{ id: string; name: string }[]>`
        insert into partners (name, is_company, is_vendor, is_customer, email, country_code, standard_waehrung, standard_incoterm)
        values (${p.lieferant.trim()}, true, true, false, ${p.lieferant_email ?? null}, ${land}, ${waehrung}, ${incoterm})
        returning id, name`
      lieferant = neu
      neuerLieferant = true
      await t`select log_event('partner', ${neu.id}, 'note', 'Aus Beleg angelegt (KI-Chat)', ${ctx.actor})`
    }

    // Artikel: vorhandene auflösen, neue Kaufteile anlegen (SKU zuerst prüfen —
    // ein Beleg zum zweiten Mal darf keinen zweiten Artikel erzeugen).
    const zeilen: { variantId: string; menge: number; preis: number }[] = []
    const neueArtikel: string[] = []
    for (const pos of p.positionen) {
      const preis = pos.preis ?? 0
      if (pos.produkt?.trim()) {
        const v = await varianteAufloesen(t, pos.produkt.trim())
        zeilen.push({ variantId: v.id, menge: pos.menge, preis })
        continue
      }
      const sku = pos.sku_neu?.trim() || undefined
      const [da] = sku
        ? await t<{ id: string }[]>`select id from product_variants where lower(sku) = lower(${sku}) and active limit 1`
        : []
      if (da) {
        zeilen.push({ variantId: da.id, menge: pos.menge, preis })
        continue
      }
      const [k] = await t<{ kurs: number }[]>`select exchange_rate_at(${waehrung}, current_date) as kurs`
      const neu = await produktAnlegen(
        t,
        {
          name: pos.artikel_neu!.trim(),
          sku,
          einkaufbar: true,
          verkaufbar: false,
          route: 'kaufen',
          einstandspreis: Math.round(preis * Number(k?.kurs ?? 1) * 100) / 100,
        },
        ctx.actor,
      )
      const [v] = await t<{ id: string }[]>`
        select id from product_variants where template_id = ${neu.templateId} order by created_at limit 1`
      zeilen.push({ variantId: v.id, menge: pos.menge, preis })
      neueArtikel.push(pos.artikel_neu!.trim())
    }

    const note = [p.hinweis?.trim(), p.referenz ? `Beleg: ${p.referenz.trim()}` : null, 'Aus Beleg erfasst (KI-Chat)']
      .filter(Boolean)
      .join('\n')
    const [po] = await t<{ id: string; number: string }[]>`
      insert into purchase_orders (number, vendor_id, currency, incoterm_code, vendor_reference, note, expected_arrival, user_id)
      values (next_sequence('purchase'), ${lieferant.id}, ${waehrung}, ${incoterm}, ${p.referenz?.trim() || null}, ${note},
              ${p.eta ? t`${p.eta}::date` : null}, ${ctx.userId ?? null})
      returning id, number`

    let sequence = 10
    const zeile = async (variantId: string, menge: number, preis: number, name?: string) => {
      await t`
        insert into purchase_order_lines
          (order_id, sequence, variant_id, name, qty, uom_id, price_unit, discount, tax_id, tax_rate)
        select ${po.id}, ${sequence}, ${variantId}, ${name ?? t`variant_display_name(pv.id)`}, ${menge},
               coalesce(pt.purchase_uom_id, pt.uom_id), ${preis}, 0,
               pt.purchase_tax_id, coalesce((select amount from taxes where id = pt.purchase_tax_id), 19)
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${variantId}`
      sequence += 10
    }
    for (const z of zeilen) await zeile(z.variantId, z.menge, z.preis)
    if (p.versandkosten && p.versandkosten > 0) {
      await zeile(await frachtArtikel(t), 1, p.versandkosten, `Fracht laut Beleg${incoterm ? ` (${incoterm})` : ''}`)
    }

    if (p.bestaetigen) {
      await t`select confirm_purchase_order(${po.id}, ${ctx.actor})`
      if (p.bestelldatum) {
        await t`update purchase_orders set confirmed_at = ${p.bestelldatum}::date where id = ${po.id}`
      }
    } else if (p.bestelldatum) {
      await t`update purchase_orders set order_deadline = ${p.bestelldatum}::date where id = ${po.id}`
    }

    let zahlung: string | null = null
    if (p.bezahlt) {
      const [rate] = await t<{ id: string }[]>`
        insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, betrag, ausloeser)
        values (${po.id}, 10, 'Vorkasse 100 %', ${p.bezahlt_betrag ? null : 100}, ${p.bezahlt_betrag ?? null}, 'bestellung')
        returning id`
      const [summe] = await t<{ betrag: number }[]>`
        select round(coalesce(${p.bezahlt_betrag ?? null}::numeric, (select gross from purchase_order_total(${po.id}))), 2) as betrag`
      const betrag = Number(summe.betrag)
      if (!(betrag > 0)) throw new Error('Die Bestellsumme ist 0 — bezahlt_betrag angeben.')
      await t`
        select zahlung_erfassen('aus', ${betrag}, ${waehrung},
                                ${p.bezahlt_am ? t`${p.bezahlt_am}::date` : t`current_date`}, null,
                                'po_rate', ${rate.id}, ${`Vorkasse ${po.number}${p.referenz ? ` · ${p.referenz.trim()}` : ''}`}, ${ctx.actor})`
      zahlung = `${betrag.toFixed(2)} ${waehrung}${p.bezahlt_am ? ` am ${p.bezahlt_am}` : ''}`
    }

    await t`select log_event('purchase_order', ${po.id}, 'note',
      ${`Aus Beleg erfasst (KI-Chat)${p.referenz ? ` — ${p.referenz.trim()}` : ''}`}, ${ctx.actor})`
    return { po, lieferant, neuerLieferant, neueArtikel, zahlung, hinweise }
  })

  const { po, lieferant, neuerLieferant, neueArtikel, zahlung, hinweise } = erfasst
  const teile = [
    `Bestellung ${po.number} bei ${lieferant.name} erfasst (${p.positionen.length} Position(en), ${waehrung})`,
    p.bestaetigen ? 'bestätigt — der Wareneingang wird erwartet' : 'als Entwurf',
    zahlung ? `Vorkasse ${zahlung} vermerkt` : null,
    neuerLieferant ? `Lieferant neu angelegt` : null,
    neueArtikel.length ? `neue Artikel: ${neueArtikel.join(', ')}` : null,
    ...hinweise,
  ].filter(Boolean)
  return { text: `${teile.join('; ')}.`, link: `/einkauf/${po.id}`, recordId: po.id }
}

export async function positionEntfernen(
  p: { line_id: string },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  await sql`select purchase_order_guard_editable(${orderId})`
  await sql`delete from purchase_order_lines where id = ${p.line_id} and order_id = ${orderId}`
  return { recordId: orderId }
}

export async function kopfAendern(
  p: {
    user_id?: string
    payment_term_id?: string
    incoterm_code?: string
    priority: boolean
    receipt_reminder_email: boolean
    reminder_date_before_receipt: number
    eta?: string
    eta_bestaetigt?: string
    carrier?: string
    tracking_nummer?: string
    tracking_url?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update purchase_orders set
      user_id = ${p.user_id ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      incoterm_code = ${p.incoterm_code ?? null},
      priority = ${p.priority ? '1' : '0'},
      receipt_reminder_email = ${p.receipt_reminder_email},
      reminder_date_before_receipt = ${p.reminder_date_before_receipt},
      expected_arrival = ${p.eta ?? null},
      eta_confirmed = ${p.eta_bestaetigt ?? null},
      carrier = ${p.carrier ?? null},
      tracking_number = ${p.tracking_nummer ?? null},
      tracking_url = ${p.tracking_url ?? null}
    where id = ${ctx.recordId!} and state <> 'cancel'`
  // Der Termin ist EINMAL gepflegt und wandert an die offenen
  // Wareneingangs-Transfers — der Lagerist plant nach scheduled_date.
  await sql`select purchase_order_eta_sync(${ctx.recordId!})`
  return { recordId: ctx.recordId }
}

export async function bestellungFreigeben(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select purchase_order_approve(${ctx.recordId!}, ${ctx.actor})`
  return { text: 'Bestellung freigegeben.', recordId: ctx.recordId }
}

export async function bestaetigen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select confirm_purchase_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function stornieren(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select cancel_purchase_order(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function sperren(
  p: { locked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select ${p.locked ? sql`purchase_order_lock` : sql`purchase_order_unlock`}(
    ${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

/** Stellt die Bestellung als E-Mail mit Positionsliste in die Outbox. */
export async function emailSenden(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const orderId = ctx.recordId!
  // Seit 0094: mit angebundenem Einkaufspostfach entsteht ein Entwurf mit
  // Bestell-PDF in der Sprache des Lieferanten — gegenlesen, freigeben,
  // gesendet wird im Thread. Ohne Postfach bleibt der bisherige Weg (Resend).
  const { postfachKonfiguriert, driveKonfiguriert } = await import('@/modules/google/auth')
  if (postfachKonfiguriert() && driveKonfiguriert()) {
    const { entwurfAnlegen } = await import('./einkauf-mailversand-ausfuehren.ts')
    const r = await entwurfAnlegen(
      { purchase_order_id: orderId, vorlage: 'bestellung', bestell_pdf: true, anhang_dokument_ids: [] },
      ctx,
    )
    return { ...r, text: 'Entwurf mit Bestell-PDF angelegt — gegenlesen und freigeben.' }
  }
  const [order] = await sql<
    { number: string; vendor: string; email: string | null }[]
  >`
    select po.number, p.name as vendor, p.email
    from purchase_orders po join partners p on p.id = po.vendor_id where po.id = ${orderId}`
  if (!order) throw new Error('Bestellung nicht gefunden')
  if (!order.email) throw new Error(`Für ${order.vendor} ist keine E-Mail-Adresse hinterlegt`)

  const lines = await sql<{ name: string; qty: number; uom: string; price_unit: number }[]>`
    select l.name, l.qty, u.name as uom, l.price_unit
    from purchase_order_lines l join uoms u on u.id = l.uom_id
    where l.order_id = ${orderId} order by l.sequence`

  const [company] = await sql<{ name: string }[]>`
    select value ->> 'name' as name from settings where key = 'company'`

  const rows = lines
    .map(
      (l) =>
        `<tr><td>${htmlSicher(l.name)}</td><td align="right">${qty(l.qty)} ${l.uom}</td>` +
        `<td align="right">${money(l.price_unit)}</td></tr>`,
    )
    .join('')

  const html =
    `<p>Guten Tag,</p><p>anbei unsere Bestellung <strong>${order.number}</strong>.</p>` +
    `<table cellpadding="6" border="1" style="border-collapse:collapse">` +
    `<tr><th align="left">Position</th><th align="right">Menge</th><th align="right">Preis</th></tr>` +
    `${rows}</table>` +
    `<p>Mit freundlichen Grüßen<br>${htmlSicher(company?.name ?? '')}</p>`

  await sql`select enqueue_job('send_po_email',
    ${sql.json({ purchase_order_id: orderId, html })}, ${`po-email:${orderId}:${Date.now()}`})`
  await sql`select log_event('purchase_order', ${orderId}, 'email',
    ${`E-Mail an ${order.email} eingereiht`}, ${ctx.actor})`

  return { text: `E-Mail an ${order.email} eingereiht.`, recordId: orderId }
}

// --- Rechnungen ------------------------------------------------------------

export async function rechnungErstellen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  const [row] = await sql<{ create_vendor_bill: string }[]>`
    select create_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return {
    text: 'Rechnung im Entwurf erstellt.',
    link: `/einkauf/rechnungen/${row.create_vendor_bill}`,
    recordId: row.create_vendor_bill,
  }
}

export async function rechnungDetails(
  p: {
    bill_date?: string
    vendor_bill_reference?: string
    payment_term_id?: string
    payment_reference?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    update vendor_bills set
      bill_date = ${p.bill_date ?? null}::date,
      vendor_bill_reference = ${p.vendor_bill_reference ?? null},
      payment_term_id = ${p.payment_term_id ?? null},
      payment_reference = ${p.payment_reference ?? null}
    where id = ${ctx.recordId!} and state = 'draft'`
  return { recordId: ctx.recordId }
}

export async function rechnungPruefen(
  p: { checked: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`update vendor_bills set checked = ${p.checked} where id = ${ctx.recordId!}`
  await sql`select log_event('vendor_bill', ${ctx.recordId!}, 'note',
    ${p.checked ? 'Als geprüft markiert' : 'Prüfmarkierung entfernt'}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select post_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungZahlen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select pay_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function rechnungStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [row] = await sql<{ cancel_vendor_bill: string | null }[]>`
    select cancel_vendor_bill(${ctx.recordId!}, ${ctx.actor})`
  if (row.cancel_vendor_bill) {
    return {
      text: 'Stornorechnung erstellt.',
      link: `/einkauf/rechnungen/${row.cancel_vendor_bill}`,
      recordId: row.cancel_vendor_bill,
    }
  }
  return { recordId: ctx.recordId }
}

// --- Einstandsnebenkosten + Kurse ------------------------------------------

export async function nebenkostenErfassen(
  p: {
    amount: number
    currency: string
    cost_type: string
    basis: string
    is_estimate: boolean
    vendor_id?: string
    note?: string
  },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`
    insert into landed_costs
      (number, picking_id, cost_type, basis, amount, currency, exchange_rate,
       is_estimate, vendor_id, note)
    values (
      next_sequence('landed'), ${ctx.recordId!},
      ${p.cost_type}::landed_cost_type, ${p.basis}::landed_cost_basis,
      ${p.amount}, ${p.currency},
      exchange_rate_at(${p.currency}, current_date),
      ${p.is_estimate}, ${p.vendor_id ?? null}, ${p.note ?? null})`
  return { recordId: ctx.recordId }
}

export async function nebenkostenBuchen(_p: object, ctx: AktionsKontext): Promise<AktionsErgebnis> {
  await sql`select landed_cost_post(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function nebenkostenStornieren(
  _p: object,
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  await sql`select landed_cost_cancel(${ctx.recordId!}, ${ctx.actor})`
  return { recordId: ctx.recordId }
}

export async function wechselkursErfassen(p: {
  currency: string
  rate: number
  valid_from?: string
}): Promise<AktionsErgebnis> {
  await sql`
    insert into exchange_rates (currency, rate, valid_from, source)
    values (${p.currency}, ${p.rate}, coalesce(${p.valid_from ?? null}::date, current_date), 'manuell')
    on conflict (currency, valid_from) do update
      set rate = excluded.rate, source = 'manuell'`
  return { text: `Kurs ${p.currency} = ${p.rate} erfasst.` }
}
