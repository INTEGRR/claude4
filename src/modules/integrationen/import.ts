import 'server-only'
import type { TransactionSql } from 'postgres'
import { sql, tx } from '@/db/client'
import { splitStreet } from '@/modules/shared/address'
import { externVersandNachziehen } from '@/modules/verkauf/extern-versand'
import { stornoNachlauf } from '@/modules/verkauf/storno-nachlauf'
import { ShopifyError, fetchOrder, fetchOrders, type ShopifyOrder } from './shopify'
import { haltNachziehen, shopHaltLesen } from './shop-halt'
import { listenpreisNetto, positionsName, rechnungsanschrift, zahlungsartText } from './bestellung-felder'
import { netto, positionNetto, runden, satzAusSteuerzeilen } from './shopify-preise'
import { plural } from '@/modules/shared/format'

export { splitStreet }
export { listenpreisNetto, positionsName, rechnungsanschrift, zahlungsartText }

/**
 * Überverkaufs-Wächter (S5, 0136): Ist die eben bestätigte Bestellung voll
 * gedeckt? Geprüft werden die Teile ihrer Fertigungsaufträge und die
 * Lagerware ihrer Lieferung (auftragsgefertigte Positionen warten ohnehin
 * auf die Fertigung). Fehlt etwas, steht es am Auftrag und geht per
 * Telegram hinaus — einmal je Bestellung. Nur im Modus „schreiben": solange
 * KRNL die Shop-Mengen nicht führt, ist eine Lücke kein Befund.
 */
async function ueberverkaufPruefen(t: TransactionSql, auftragId: string, name: string): Promise<string | null> {
  const { shopifyModus } = await import('./shopify-modus')
  if ((await shopifyModus(t)) !== 'schreiben') return null
  const fehlt = await t<{ teil: string; fehlt: number }[]>`
    select coalesce(nullif(pv.sku, ''), pv.display_name) as teil, sum(m.qty - m.reserved_qty)::float as fehlt
    from stock_moves m
    join stock_locations l on l.id = m.src_location_id and l.type = 'internal'
    join product_variants pv on pv.id = m.variant_id
    where m.state not in ('done', 'cancel', 'draft') and m.qty > m.reserved_qty
      and (m.production_id in (select id from manufacturing_orders
                               where sales_order_id = ${auftragId} and state not in ('done', 'cancel'))
           or (m.picking_id in (select p.id from stock_pickings p
                                join operation_types ot on ot.id = p.operation_type_id and ot.kind = 'delivery'
                                where p.origin_model = 'sales_order' and p.origin_id = ${auftragId})
               and not ist_made_to_order(m.variant_id)))
    group by 1 order by 1`
  if (fehlt.length === 0) return null
  const liste = fehlt.map((f) => `${f.fehlt} × ${f.teil}`).join(', ')
  await t`select log_event('sales_order', ${auftragId}, 'error',
    ${`Nicht voll gedeckt — es fehlen: ${liste}. Die Bestellung wartet auf Ware.`}, 'shopify')`
  const { einreihen } = await import('./benachrichtigungen')
  await einreihen(t, 'ueberverkauf', `ueberverkauf:${auftragId}`,
    `⚠️ <b>Überverkauf</b>: Bestellung ${name} ist nicht voll gedeckt — es fehlen: ${liste}.`)
  return `nicht voll gedeckt (${liste})`
}

/**
 * Import-Pipeline: aus einer Shopify-Order wird ein Verkaufsauftrag.
 *
 * Verarbeitung läuft bewusst getrennt vom Webhook-Empfang - der Endpunkt
 * speichert nur und antwortet sofort (Shopify bricht nach 5 s ab).
 */

async function upsertCustomer(t: TransactionSql, order: ShopifyOrder): Promise<string> {
  const addr = order.shippingAddress
  const name =
    addr?.name ||
    [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') ||
    order.email ||
    'Unbekannter Kunde'
  const { street, houseNumber } = splitStreet(addr?.address1)
  const shopifyCustomerId = order.customer?.id ?? null
  const email = order.customer?.defaultEmailAddress?.emailAddress ?? order.email

  if (shopifyCustomerId) {
    const [existing] = await t<{ id: string }[]>`
      select id from partners where shopify_customer_id = ${shopifyCustomerId}`
    if (existing) {
      // Nur Lücken füllen (0089): was im ERP steht, bleibt — sonst schrieb
      // eine alte Bestellung (Erstübernahme läuft ältestes zuerst) eine
      // veraltete Adresse über die aktuelle. Die Lieferadresse steht ohnehin
      // eingefroren am Auftrag.
      await t`
        update partners set
          email = coalesce(email, ${email ?? null}),
          street = coalesce(street, ${street}),
          house_number = coalesce(house_number, ${houseNumber}),
          street2 = coalesce(street2, ${addr?.address2 ?? null}),
          zip = coalesce(zip, ${addr?.zip ?? null}),
          city = coalesce(city, ${addr?.city ?? null}),
          country_code = coalesce(country_code, ${addr?.countryCodeV2 ?? null}),
          phone = coalesce(phone, ${addr?.phone ?? null}),
          is_customer = true
        where id = ${existing.id}`
      return existing.id
    }
  }

  // on conflict (0135/S4): zwei gleichzeitige Erstbestellungen desselben
  // Kunden legen ihn nicht doppelt an — die zweite wartet und nimmt ihn.
  const [created] = await t<{ id: string }[]>`
    insert into partners (
      name, is_customer, email, street, house_number, street2, zip, city,
      country_code, phone, shopify_customer_id)
    values (
      ${name}, true, ${email ?? null}, ${street}, ${houseNumber},
      ${addr?.address2 ?? null}, ${addr?.zip ?? null}, ${addr?.city ?? null},
      ${addr?.countryCodeV2 ?? 'DE'}, ${addr?.phone ?? null}, ${shopifyCustomerId})
    on conflict (shopify_customer_id) do update set is_customer = true
    returning id`
  return created.id
}

/** Findet die Variante über die Shopify-Varianten-ID oder die SKU. */
async function matchVariant(
  t: TransactionSql,
  sku: string | null,
  variantGid: string | null,
): Promise<string | null> {
  if (variantGid) {
    const [byGid] = await t<{ id: string }[]>`
      select id from product_variants where shopify_variant_id = ${variantGid} and active`
    if (byGid) return byGid.id
  }
  if (sku) {
    const [bySku] = await t<{ id: string }[]>`
      select id from product_variants where sku = ${sku} and active`
    if (bySku) {
      // Zuordnung merken, damit der nächste Import ohne SKU-Suche auskommt.
      if (variantGid) {
        await t`update product_variants set shopify_variant_id = ${variantGid}
                where id = ${bySku.id} and shopify_variant_id is null`
      }
      return bySku.id
    }
  }
  return null
}

type Position = ShopifyOrder['lineItems']['nodes'][number]

/** Netto-Stückpreis nach Rabatt und Steuersatz einer Shopify-Position (0089). */
export function positionsPreis(
  item: Position,
  taxesIncluded: boolean | null | undefined,
): { stueckNetto: number; steuersatz: number } {
  return positionNetto(
    {
      menge: item.currentQuantity ?? item.quantity,
      listenpreis: Number(item.originalUnitPriceSet.shopMoney.amount),
      nachRabatt: item.discountedUnitPriceAfterAllDiscountsSet
        ? Number(item.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount)
        : null,
      satz: item.taxLines ? satzAusSteuerzeilen(item.taxLines) : null,
    },
    taxesIncluded,
  )
}

/**
 * Zahlstatus nachziehen (0130, Entscheidungslog 2026-10-17): der Import hat
 * den offenen Betrag laut Shopify schon am Auftrag gespeichert;
 * kundenrechnung_shop_abgleich verteilt ihn auf offene Shop-Rechnungen und
 * schließt, was jetzt bezahlt ist.
 */
async function zahlstatusNachziehen(t: TransactionSql, auftragId: string): Promise<string | null> {
  const [{ bezahlt }] = await t<{ bezahlt: number }[]>`
    select kundenrechnung_shop_abgleich(${auftragId}, 'shopify') as bezahlt`
  return Number(bezahlt) > 0
    ? `${plural(Number(bezahlt), 'Rechnung', 'Rechnungen')} laut Shopify bezahlt`
    : null
}

/**
 * Erstattung zu offenen Retouren (0119, Entscheidungslog 2026-10-17): die
 * Erstattung bleibt im Shopify-Admin, KRNL liest sie ab. Erstattet heißt:
 * der Shop meldet die Bestellung ganz erstattet, oder ihr Gesamtbetrag
 * (currentTotalPriceSet, zählt Erstattungen ab) liegt unter dem Stand bei
 * der Anfrage. Ohne diesen Stand (vor 0117 importiert) genügt „teilweise
 * erstattet". Eine geprüfte Retoure schließt retoure_erstattet sofort ab —
 * samt Fertigung schließen. Sind mehrere Retouren derselben Bestellung
 * gleichzeitig offen, gelten alle als erstattet (selten; von Hand korrigierbar
 * ist nur die Fertigung, die Retoure selbst bleibt dokumentiert).
 */
async function retourenErstattungNachziehen(
  t: TransactionSql,
  auftragId: string,
  order: ShopifyOrder,
): Promise<string | null> {
  const offen = await t<{ id: string; nummer: string; shop_brutto_vorher: number | null }[]>`
    select id, nummer, shop_brutto_vorher from retouren
    where sales_order_id = ${auftragId} and erstattet_am is null
      and status in ('angefragt', 'genehmigt', 'eingegangen', 'geprueft')
    order by created_at`
  if (offen.length === 0) return null
  const finanz = order.displayFinancialStatus
  const brutto = shopBrutto(order)
  const meldungen: string[] = []
  for (const r of offen) {
    const erstattet =
      finanz === 'REFUNDED' ||
      (r.shop_brutto_vorher !== null && brutto !== null
        ? brutto < Number(r.shop_brutto_vorher) - 0.005
        : finanz === 'PARTIALLY_REFUNDED')
    if (!erstattet) continue
    await t`select retoure_erstattet(${r.id}, 'shopify')`
    const [n] = await t<{ status: string }[]>`select status::text as status from retouren where id = ${r.id}`
    meldungen.push(`Retoure ${r.nummer} erstattet${n?.status === 'abgeschlossen' ? ' und abgeschlossen' : ''}`)
  }
  return meldungen.join(' · ') || null
}

/** Gesamtbetrag der Bestellung laut Shop (brutto inkl. Versand), nach Änderungen der aktuelle Stand. */
export function shopBrutto(order: Pick<ShopifyOrder, 'totalPriceSet' | 'currentTotalPriceSet'>): number | null {
  const roh = order.currentTotalPriceSet?.shopMoney.amount ?? order.totalPriceSet?.shopMoney.amount
  const wert = Number(roh)
  return roh != null && Number.isFinite(wert) ? Math.round(wert * 100) / 100 : null
}

/**
 * Offener Betrag laut Shopify (0130): ein Aufpreis nach einer Bestelländerung,
 * den der Kunde noch nicht gezahlt hat (PARTIALLY_PAID). null = unbekannt
 * (ältere Antworten, Attrappen) — dann gilt das bisherige „Shop hat bezahlt".
 */
export function shopOffen(order: Pick<ShopifyOrder, 'totalOutstandingSet'>): number | null {
  const roh = order.totalOutstandingSet?.shopMoney.amount
  const wert = Number(roh)
  return roh != null && Number.isFinite(wert) ? Math.max(0, Math.round(wert * 100) / 100) : null
}

/** Versandkosten netto nach Rabatt (0 ohne Versandzeile). */
export function versandNetto(order: ShopifyOrder): number {
  const zeile = order.shippingLine
  if (!zeile) return 0
  return runden(
    netto(
      Number(zeile.discountedPriceSet.shopMoney.amount),
      satzAusSteuerzeilen(zeile.taxLines),
      Boolean(order.taxesIncluded),
    ),
    2,
  )
}

export interface ImportResult {
  salesOrderId: string | null
  created: boolean
  unmatched: number
  message: string
}

/**
 * Legt aus einer Shopify-Order einen Verkaufsauftrag an (idempotent über
 * shopify_order_id). Bezahlte Orders werden direkt bestätigt, wodurch
 * Lieferung und Fertigungsaufträge entstehen.
 */
export async function importShopifyOrder(
  order: ShopifyOrder,
  eventId: string | null = null,
  opts: { haltFrisch?: boolean } = {},
): Promise<ImportResult> {
  // Fulfillment-Halt (0134): vor der Transaktion lesen — ein Shop-Aufruf
  // gehört nicht in eine offene Transaktion. undefined = nichts zu prüfen.
  const halt = await shopHaltLesen(order, opts.haltFrisch)
  // Storno führt Shopify (2026-10-02): storniert der Shop einen bestehenden
  // Auftrag, zieht KRNL nach der Transaktion noch die DHL-Labels nach.
  let storniert: string | null = null
  const ergebnis = await tx(async (t): Promise<ImportResult> => {
    // Eine Bestellung zur Zeit (S4): Shopify schickt zu jedem Kauf mehrere
    // Ereignisse gleichzeitig (create + updated). Die Sperre gilt bis zum
    // Ende der Transaktion — das zweite Ereignis sieht den fertigen Auftrag,
    // statt an der Eindeutigkeit der Bestellnummer zu scheitern.
    await t`select pg_advisory_xact_lock(hashtextextended(${order.id}, 0))`
    const [existing] = await t<{ id: string; state: string; delivery_status: string }[]>`
      select id, state, delivery_status from sales_orders where shopify_order_id = ${order.id}`

    // Storniert ODER voll erstattet: bei uns heißt beides Storno. Der Storno
    // gibt Reservierungen frei und räumt nicht begonnene Fertigung mit ab
    // (cancel_sales_order); bereits versandte Ware bleibt Sache der Retoure.
    const erstattet = order.displayFinancialStatus === 'REFUNDED'
    const beendet = Boolean(order.cancelledAt) || erstattet
    const grund = order.cancelledAt ? 'storniert' : 'erstattet'

    if (beendet && existing) {
      if (existing.state === 'cancel') {
        const retoure = await retourenErstattungNachziehen(t, existing.id, order)
        return { salesOrderId: existing.id, created: false, unmatched: 0,
          message: [`${order.name} ist ${grund} - war bereits storniert`, retoure].filter(Boolean).join(' · ') }
      }
      // Retoure (0119): die Erstattung schließt eine geprüfte Retoure ab.
      const retoureMeldung = await retourenErstattungNachziehen(t, existing.id, order)
      await t`select cancel_sales_order(${existing.id}, 'shopify')`
      storniert = existing.id
      // Buch (0136): Shopify lagert beim Storno in der Regel zurück — die
      // Menge zählt wieder zum Angebot. Hat der Shop nicht zurückgelagert,
      // zeigt er weniger als das Buch (die sichere Seite); der Abgleich heilt es.
      for (const item of order.lineItems?.nodes ?? []) {
        await t`select shop_buch_bestellung(${item.variant?.id ?? null}, ${-item.quantity}, ${order.createdAt})`
      }
      if (erstattet) {
        await t`select log_event('sales_order', ${existing.id}, 'note',
          'In Shopify erstattet — Auftrag storniert.', 'shopify')`
      }
      // Rechnungen zum Auftrag (0115): der Shop hat erstattet — jede noch
      // gültige Rechnung bekommt ihre Storno-Gutschrift, nichts bleibt offen.
      const gutgeschrieben: string[] = []
      for (const k of await t<{ id: string; nummer: string }[]>`
        select id, nummer from kundenrechnungen
        where sales_order_id = ${existing.id} and art = 'rechnung' and status <> 'storniert' order by created_at`) {
        // Erst stornieren, dann lesen — eine volatile Funktion im WHERE
        // liefe je gelesener Zeile und sähe die neue Gutschrift nicht.
        const [{ gutschrift }] = await t<{ gutschrift: string }[]>`
          select kundenrechnung_stornieren(${k.id}, ${`Bestellung ${order.name} im Shop ${grund}`}, 'shopify') as gutschrift`
        const [g] = await t<{ nummer: string }[]>`select nummer from kundenrechnungen where id = ${gutschrift}`
        gutgeschrieben.push(`${k.nummer} → ${g?.nummer ?? '?'}`)
      }
      // partial/full = Ware (teilweise) beim Kunden. Der frühere Vergleich
      // mit 'none' (kein Enum-Wert) war immer wahr und warnte bei jedem
      // Shop-Storno; 'started' heißt nur reserviert und ist unkritisch.
      const [{ hatRetoure }] = await t<{ hatRetoure: boolean }[]>`
        select exists(select 1 from retouren where sales_order_id = ${existing.id}
                      and status not in ('abgelehnt', 'storniert')) as "hatRetoure"`
      if (['partial', 'full'].includes(existing.delivery_status) && !hatRetoure) {
        await t`select log_event('sales_order', ${existing.id}, 'error',
          'Ware war bereits (teilweise) versandt — für die Rückabwicklung eine Retoure bzw. Reparatur/RMA anlegen.',
          'shopify')`
      }
      return {
        salesOrderId: existing.id,
        created: false,
        unmatched: 0,
        message: `Auftrag zu ${order.name} ${erstattet ? 'wegen Erstattung ' : ''}storniert${
          gutgeschrieben.length ? ` — Gutschrift ${gutgeschrieben.join(', ')}` : ''}${retoureMeldung ? ` · ${retoureMeldung}` : ''}`,
      }
    }

    if (existing) {
      // Zahlstatus laut Shopify (0130) zuerst: eine Rechnung, die in diesem
      // Lauf aus einer Lieferung entsteht, liest ihn schon.
      await t`update sales_orders
                 set shopify_zahlstatus = ${order.displayFinancialStatus ?? null},
                     shopify_offen = coalesce(${shopOffen(order)}, shopify_offen),
                     shopify_stand_at = greatest(shopify_stand_at, ${order.updatedAt ?? null}::timestamptz)
               where id = ${existing.id}`
      // Fulfillment-Halt (0134) VOR allem, was ausbucht: ein aufgehobener
      // Halt muss weg sein, bevor ein Versand im Shop nachgezogen wird.
      const haltMeldung = await haltNachziehen(t, existing.id, halt)
      // Nachzügler-Heilung für noch unbestätigte Shop-Aufträge: inzwischen
      // aufgelöste Klärzeilen als Positionen nachziehen (echter Preis aus
      // der Bestellung) und — wenn nichts mehr offen ist und bezahlt wurde —
      // bestätigen. Deckt auch „erst importiert, später bezahlt" ab.
      if (existing.state !== 'draft') {
        // Bestellung im Shop geändert (0115): Positionen, Lieferung und
        // Fertigung folgen — nach der Rechnung mit Korrekturbelegen.
        const geaendert = await bestellaenderungNachziehen(t, existing.id, order)
        // Versand außerhalb von KRNL (Sendcloud → Shopify, 2026-10-15): der
        // Shop meldet FULFILLED, KRNL hat keine Sendung — nachziehen.
        const extern = await externVersandNachziehen(t, existing.id, order)
        // Retoure (0119): Erstattung im Shop erkannt → Retoure erstattet/abgeschlossen.
        const retoure = await retourenErstattungNachziehen(t, existing.id, order)
        // Zahlstatus (0130): offene Shop-Rechnungen schließen, sobald Shopify nichts mehr offen meldet.
        const zahlung = await zahlstatusNachziehen(t, existing.id)
        return {
          salesOrderId: existing.id,
          created: false,
          unmatched: 0,
          message: [haltMeldung && `${order.name} ${haltMeldung}`, geaendert, extern, retoure, zahlung].filter(Boolean).join(' · ') || `${order.name} war bereits importiert`,
        }
      }

      const aufgeloest = await t<
        { id: string; sku: string | null; variant_gid: string | null; title: string | null; qty: number;
          resolved_variant: string }[]
      >`
        select id, sku, variant_gid, title, qty, resolved_variant
        from shopify_unmatched_lines
        where shopify_order_id = ${order.id}
          and resolved_at is not null and attached_at is null
          and resolved_variant is not null`

      let nachgezogen = 0
      for (const zeile of aufgeloest) {
        const item = order.lineItems.nodes.find(
          (i) =>
            (zeile.variant_gid && i.variant?.id === zeile.variant_gid) ||
            (zeile.sku && i.sku === zeile.sku) ||
            // Position ganz ohne Shop-Variante und ohne Artikelnummer
            // (eigene Position im Shop): nur der Titel verbindet sie.
            (!zeile.variant_gid && !zeile.sku && !i.variant?.id && !i.sku && Boolean(zeile.title) && i.title === zeile.title),
        )
        if (!item) continue // Zeile gehört zu einer älteren Fassung der Bestellung

        const [uomRow] = await t<{ uom_id: string }[]>`
          select pt.uom_id from product_variants pv
          join product_templates pt on pt.id = pv.template_id
          where pv.id = ${zeile.resolved_variant}`
        const preis = positionsPreis(item, order.taxesIncluded)
        await t`
          insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id,
                                         price_unit, tax_rate, listenpreis)
          values (
            ${existing.id},
            coalesce((select max(sequence) + 10 from sales_order_lines
                      where order_id = ${existing.id}), 10),
            ${zeile.resolved_variant}, ${positionsName(item)}, ${zeile.qty},
            ${uomRow.uom_id}, ${preis.stueckNetto}, ${preis.steuersatz}, ${listenpreisNetto(item, order.taxesIncluded)})`
        await t`update shopify_unmatched_lines set attached_at = now() where id = ${zeile.id}`
        nachgezogen++
      }
      if (nachgezogen > 0) {
        await t`select log_event('sales_order', ${existing.id}, 'note',
          ${`${plural(nachgezogen, 'geklärte Position', 'geklärte Positionen')} aus der Klärliste nachgezogen.`}, 'shopify')`
      }

      const [{ offen }] = await t<{ offen: number }[]>`
        select count(*)::int as offen from shopify_unmatched_lines
        where shopify_order_id = ${order.id} and resolved_at is null`
      const [{ zeilen }] = await t<{ zeilen: number }[]>`
        select count(*)::int as zeilen from sales_order_lines where order_id = ${existing.id}`

      // Reservieren beim Eingang (0135): auch unbezahlt wird bestätigt —
      // versandt wird erst nach Zahlung (shipping_ready, Trigger).
      let bestaetigt = false
      let luecke: string | null = null
      if (Number(offen) === 0 && Number(zeilen) > 0) {
        await t`select confirm_sales_order(${existing.id}, 'shopify')`
        bestaetigt = true
        luecke = await ueberverkaufPruefen(t, existing.id, order.name)
      }

      return {
        salesOrderId: existing.id,
        created: false,
        unmatched: Number(offen),
        message:
          nachgezogen > 0 || bestaetigt
            ? `${order.name}: ${plural(nachgezogen, 'Position', 'Positionen')} nachgezogen${bestaetigt ? ', Auftrag bestätigt' : ''}${luecke ? ` — ${luecke}` : ''}`
            : haltMeldung
              ? `${order.name} ${haltMeldung}`
              : `${order.name} war bereits importiert`,
      }
    }

    const partnerId = await upsertCustomer(t, order)
    const addr = order.shippingAddress
    const { street, houseNumber } = splitStreet(addr?.address1)

    const [created] = await t<{ id: string }[]>`
      insert into sales_orders (
        number, partner_id, source, shopify_order_id, shopify_order_name,
        order_date, currency, versandkosten, shopify_brutto, shopify_zahlstatus, shopify_offen, shopify_stand_at,
        ship_name, ship_street, ship_house_number, ship_street2,
        ship_zip, ship_city, ship_country_code, ship_phone, ship_email,
        rechnungsanschrift, zahlungsart)
      values (
        next_sequence('sale'), ${partnerId}, 'shopify', ${order.id}, ${order.name},
        ${order.createdAt}, ${order.totalPriceSet.shopMoney.currencyCode}, ${versandNetto(order)}, ${shopBrutto(order)},
        ${order.displayFinancialStatus ?? null}, ${shopOffen(order)}, ${order.updatedAt ?? null},
        ${addr?.name ?? null}, ${street}, ${houseNumber}, ${addr?.address2 ?? null},
        ${addr?.zip ?? null}, ${addr?.city ?? null}, ${addr?.countryCodeV2 ?? 'DE'},
        ${addr?.phone ?? null}, ${order.email ?? null},
        ${rechnungsanschrift(order) ? t.json(rechnungsanschrift(order) as never) : null}, ${zahlungsartText(order)})
      returning id`

    let sequence = 10
    let unmatched = 0

    for (const item of order.lineItems.nodes) {
      const qty = item.currentQuantity ?? item.quantity
      if (qty <= 0) continue

      // Buch (0136): Shopify hat diese Menge beim Kauf von seinem Angebot
      // abgezogen — genau einmal, hier, zählt sie auch gegen das Buch. Nicht
      // bei Bestellungen, die schon storniert ankommen.
      if (!beendet) {
        await t`select shop_buch_bestellung(${item.variant?.id ?? null}, ${qty}, ${order.createdAt})`
      }

      const variantId = await matchVariant(t, item.sku, item.variant?.id ?? null)
      if (!variantId) {
        // Ohne Produktzuordnung keine Position - stattdessen Klärfall anlegen.
        await t`
          insert into shopify_unmatched_lines (
            event_id, shopify_order_id, order_name, sku, title, variant_gid, qty)
          values (${eventId}, ${order.id}, ${order.name}, ${item.sku},
                  ${item.title}, ${item.variant?.id ?? null}, ${qty})`
        unmatched++
        continue
      }

      const [uomRow] = await t<{ uom_id: string }[]>`
        select pt.uom_id from product_variants pv
        join product_templates pt on pt.id = pv.template_id where pv.id = ${variantId}`

      const preis = positionsPreis(item, order.taxesIncluded)
      await t`
        insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id,
                                       price_unit, tax_rate, listenpreis)
        values (${created.id}, ${sequence}, ${variantId}, ${positionsName(item)}, ${qty},
                ${uomRow.uom_id}, ${preis.stueckNetto}, ${preis.steuersatz}, ${listenpreisNetto(item, order.taxesIncluded)})`
      sequence += 10
    }

    if (unmatched > 0) {
      await t`select log_event('sales_order', ${created.id}, 'error',
        ${`${plural(unmatched, 'Position', 'Positionen')} konnten keinem Produkt zugeordnet werden und fehlen im Auftrag.`},
        'shopify')`
    }

    // Stornierte/erstattete Orders ohne Beleg: als stornierten Beleg
    // übernehmen — der Umsatzverlauf bleibt vollständig, aber es entsteht
    // keinerlei Logistik (der Beleg war nie bestätigt).
    if (beendet) {
      await t`select cancel_sales_order(${created.id}, 'shopify')`
      await t`select log_event('sales_order', ${created.id}, 'note',
        ${`In Shopify ${grund} — als stornierter Beleg übernommen.`}, 'shopify')`
      return {
        salesOrderId: created.id,
        created: true,
        unmatched,
        message: `${order.name} als ${grund}er Beleg übernommen`,
      }
    }

    // In Shopify bereits vollständig versandte Orders sind Historie: als
    // Beleg übernehmen, aber KEINE Lieferung und keine Fertigung anstoßen —
    // sonst erzeugte eine Erstübernahme hunderte offene Vorgänge für Ware,
    // die längst beim Kunden ist.
    if (order.displayFulfillmentStatus === 'FULFILLED') {
      await t`update sales_orders
              set state = 'sale', delivery_status = 'full', historisch = true,
                  confirmed_at = ${order.createdAt}
              where id = ${created.id}`
      await t`update sales_order_lines set qty_delivered = qty
              where order_id = ${created.id} and variant_id is not null`
      await t`select log_event('sales_order', ${created.id}, 'note',
        'Historisch übernommen — in Shopify bereits versandt, keine Lieferung erzeugt.',
        'shopify')`
      return {
        salesOrderId: created.id,
        created: true,
        unmatched,
        message: `${order.name} historisch übernommen (bereits versandt)`,
      }
    }

    // Fulfillment-Halt (0134): schon beim Anlegen angehalten (z. B. Betrugsprüfung).
    const haltNeu = await haltNachziehen(t, created.id, halt)

    // Sofort bestätigen — auch unbezahlt (0135, Entscheidungslog 2026-11-27):
    // Shopify hat seinen Bestand beim Kauf heruntergezählt, KRNL reserviert
    // im selben Zug (Lieferung + Fertigungsaufträge). Unbezahltes geht nicht
    // raus: die Lieferung ist erst nach Zahlung versandbereit.
    const bezahlt = order.displayFinancialStatus === 'PAID'
    const bestaetigen = unmatched === 0
    let luecke: string | null = null
    if (bestaetigen) {
      await t`select confirm_sales_order(${created.id}, 'shopify')`
      luecke = await ueberverkaufPruefen(t, created.id, order.name)
      if (!bezahlt) {
        await t`select log_event('sales_order', ${created.id}, 'note',
          ${`Zahlung laut Shopify offen (${order.displayFinancialStatus ?? 'unbekannt'}) — reserviert, Versand erst nach Zahlungseingang.`},
          'shopify')`
      }
    }

    return {
      salesOrderId: created.id,
      created: true,
      unmatched,
      message:
        `${order.name} importiert` +
        (bestaetigen ? (bezahlt ? ' und bestätigt' : ' und bestätigt (Zahlung offen)') : '') +
        (unmatched > 0 ? ` (${plural(unmatched, 'Position', 'Positionen')} offen)` : '') +
        (haltNeu ? ` — ${haltNeu}` : '') +
        (luecke ? ` — ${luecke}` : ''),
    }
  })
  if (storniert) await stornoNachlauf(storniert, 'shopify')
  return ergebnis
}

/**
 * Bestellung im Shop geändert (0115, Entscheidungslog 2026-10-16): der Soll-
 * Stand ist die Bestellung, wie Shopify sie JETZT liefert (currentQuantity
 * zählt Änderungen und Erstattungen schon ab). Zeilen folgen: Menge und
 * Preis angleichen, neue Artikel aufnehmen, entfernte Zeilen löschen — nie
 * unter die gelieferte Menge. Danach zieht sales_order_lieferung_angleichen
 * offene Lieferung und nicht begonnene Fertigung nach; was schon berechnet
 * war und zurückgenommen wurde, bekommt eine Gutschrift. Rückgabe: Meldung
 * für den Webhook, null wenn nichts zu tun war.
 */
export async function bestellaenderungNachziehen(
  t: TransactionSql,
  auftragId: string,
  order: ShopifyOrder,
): Promise<string | null> {
  const [so] = await t<{ state: string; historisch: boolean; versandkosten: number; shopify_brutto: number | null }[]>`
    select state::text as state, historisch, versandkosten, shopify_brutto from sales_orders where id = ${auftragId}`
  if (!so || so.state !== 'sale' || so.historisch) return null
  // Gesamtbetrag laut Shop immer nachführen (Vergleichsbasis des Rechnungs-Probelaufs, 0117) — auch ohne Positionsänderung.
  const brutto = shopBrutto(order)
  if (brutto !== null && (so.shopify_brutto === null || Math.abs(brutto - Number(so.shopify_brutto)) >= 0.005)) {
    await t`update sales_orders set shopify_brutto = ${brutto} where id = ${auftragId}`
  }

  const soll = new Map<string, { qty: number; preis: number; steuer: number; name: string; listenpreis: number | null }>()
  for (const item of order.lineItems.nodes) {
    const qty = item.currentQuantity ?? item.quantity
    if (qty <= 0) continue
    const variantId = await matchVariant(t, item.sku, item.variant?.id ?? null)
    if (!variantId) continue // nicht zuordenbare Zeilen bleiben Klärfälle des Imports
    const preis = positionsPreis(item, order.taxesIncluded)
    const bisher = soll.get(variantId)
    soll.set(variantId, {
      qty: (bisher?.qty ?? 0) + qty,
      preis: preis.stueckNetto,
      steuer: preis.steuersatz,
      name: positionsName(item),
      listenpreis: listenpreisNetto(item, order.taxesIncluded),
    })
  }

  const ist = await t<
    { id: string; variant_id: string; name: string; qty: number; qty_delivered: number; qty_invoiced: number; price_unit: number }[]
  >`
    select id, variant_id, name, qty, qty_delivered, qty_invoiced, price_unit
    from sales_order_lines where order_id = ${auftragId} and variant_id is not null order by sequence`

  const aenderungen: string[] = []
  const gutschriften: { variant: string; menge: number }[] = []
  for (const zeile of ist) {
    const s = soll.get(zeile.variant_id)
    const geliefert = Number(zeile.qty_delivered)
    const berechnet = Number(zeile.qty_invoiced)
    if (!s) {
      if (geliefert > 0) {
        // Geliefertes bleibt Auftragsmenge — der Shop nimmt nur die Forderung zurück.
        const gekuerzt = Number(zeile.qty) !== geliefert
        if (gekuerzt) await t`update sales_order_lines set qty = ${geliefert} where id = ${zeile.id}`
        if (berechnet > 0) gutschriften.push({ variant: zeile.variant_id, menge: berechnet })
        if (gekuerzt || berechnet > 0) {
          aenderungen.push(`${zeile.name} im Shop zurückgenommen (${geliefert} bereits geliefert${berechnet > 0 ? ', berechnet → Gutschrift' : ''})`)
        }
      } else {
        await t`delete from sales_order_lines where id = ${zeile.id}`
        aenderungen.push(`${zeile.name} entfernt`)
      }
      continue
    }
    soll.delete(zeile.variant_id)
    const neueMenge = Math.max(s.qty, geliefert)
    const preisGeaendert = Math.abs(s.preis - Number(zeile.price_unit)) >= 0.005
    if (neueMenge !== Number(zeile.qty) || preisGeaendert) {
      await t`update sales_order_lines
              set qty = ${neueMenge}, price_unit = ${s.preis}, listenpreis = ${s.listenpreis}
              where id = ${zeile.id}`
      aenderungen.push(
        `${zeile.name}: ${Number(zeile.qty)} → ${neueMenge}${preisGeaendert ? ` (Preis ${Number(zeile.price_unit).toFixed(2)} → ${s.preis.toFixed(2)})` : ''}`,
      )
    }
    if (s.qty < berechnet) {
      // Weniger als berechnet: die Differenz wird gutgeschrieben (Rechnung bleibt).
      gutschriften.push({ variant: zeile.variant_id, menge: berechnet - s.qty })
      aenderungen.push(`${zeile.name}: im Shop auf ${s.qty} verringert, ${berechnet - s.qty} berechnet → Gutschrift`)
    }
  }
  for (const [variantId, s] of soll) {
    const [uomRow] = await t<{ uom_id: string }[]>`
      select pt.uom_id from product_variants pv join product_templates pt on pt.id = pv.template_id where pv.id = ${variantId}`
    await t`
      insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit, tax_rate, listenpreis)
      values (${auftragId},
              coalesce((select max(sequence) + 10 from sales_order_lines where order_id = ${auftragId}), 10),
              ${variantId}, ${s.name}, ${s.qty}, ${uomRow.uom_id}, ${s.preis}, ${s.steuer}, ${s.listenpreis})`
    aenderungen.push(`${s.name} neu (${s.qty})`)
  }

  const versand = versandNetto(order)
  if (Math.abs(versand - Number(so.versandkosten)) >= 0.005) {
    await t`update sales_orders set versandkosten = ${versand} where id = ${auftragId}`
    aenderungen.push(`Versand ${Number(so.versandkosten).toFixed(2)} → ${versand.toFixed(2)}`)
  }
  if (aenderungen.length === 0) return null

  await t`select sales_order_lieferung_angleichen(${auftragId}, 'shopify')`
  let anzahlGutschriften = 0
  for (const g of gutschriften) {
    const [r] = await t<{ n: number }[]>`
      select kundenrechnung_aenderung_gutschreiben(${auftragId}, ${g.variant}, ${g.menge},
        ${`Bestellung ${order.name} im Shop geändert`}, 'shopify') as n`
    anzahlGutschriften += Number(r.n)
  }
  await t`select log_event('sales_order', ${auftragId}, 'note',
    ${`Bestellung im Shop geändert: ${aenderungen.join('; ')}${anzahlGutschriften ? ` — ${plural(anzahlGutschriften, 'Gutschrift', 'Gutschriften')} erzeugt` : ''}`.slice(0, 1000)},
    'shopify')`
  return `${order.name}: Bestellung im Shop geändert (${aenderungen.join('; ')})`
}

// --- Erstübernahme -----------------------------------------------------------

export interface UebernahmeStand {
  importiert: number
  fertig: boolean
}

async function schreibeStand(key: string, stand: UebernahmeStand): Promise<void> {
  await sql`
    insert into shopify_sync_state (key, value)
    values (${key}, ${sql.json({ ...stand })})
    on conflict (key) do update set value = excluded.value, updated_at = now()`
}

async function leseStand(key: string): Promise<UebernahmeStand> {
  const [row] = await sql<{ value: UebernahmeStand }[]>`
    select value from shopify_sync_state where key = ${key}`
  return row?.value ?? { importiert: 0, fertig: false }
}

/**
 * Ein Häppchen Kundenübernahme (100 Stück). Gibt den Cursor für die nächste
 * Seite zurück; null heißt fertig. Bestehende Kontakte werden ergänzt, nie
 * überschrieben — im ERP gepflegte Daten schlagen den Shop-Stand.
 */
export async function importCustomersChunk(
  cursor: string | null,
): Promise<{ imported: number; nextCursor: string | null }> {
  const { fetchCustomersPage } = await import('./shopify')
  const { customers, endCursor } = await fetchCustomersPage(cursor)

  let imported = 0
  for (const k of customers) {
    const email = k.defaultEmailAddress?.emailAddress ?? null
    const telefon = k.defaultPhoneNumber?.phoneNumber ?? null
    const name =
      [k.firstName, k.lastName].filter(Boolean).join(' ') || email || 'Unbekannt'
    const a = k.defaultAddress
    const { street, houseNumber } = splitStreet(a?.address1)
    const ergebnis = await sql`
      insert into partners (
        name, is_company, is_customer, email, phone, street, house_number,
        street2, zip, city, country_code, shopify_customer_id)
      values (
        ${name}, ${Boolean(a?.company)}, true, ${email}, ${telefon ?? a?.phone ?? null},
        ${street}, ${houseNumber}, ${a?.address2 ?? null}, ${a?.zip ?? null},
        ${a?.city ?? null}, ${a?.countryCodeV2 ?? 'DE'}, ${k.id})
      on conflict (shopify_customer_id) do update set
        -- nur Lücken füllen: was im ERP steht, bleibt
        email = coalesce(partners.email, excluded.email),
        phone = coalesce(partners.phone, excluded.phone),
        street = coalesce(partners.street, excluded.street),
        house_number = coalesce(partners.house_number, excluded.house_number),
        zip = coalesce(partners.zip, excluded.zip),
        city = coalesce(partners.city, excluded.city),
        is_customer = true
      returning (xmax = 0) as neu`
    if ((ergebnis[0] as { neu?: boolean } | undefined)?.neu) imported++
  }

  const stand = await leseStand('backfill_customers')
  await schreibeStand('backfill_customers', {
    importiert: stand.importiert + imported,
    fertig: endCursor === null,
  })
  return { imported, nextCursor: endCursor }
}

/**
 * Ein Häppchen Bestellübernahme (50 Stück) für eine beliebige
 * Shopify-Suchanfrage (z. B. "status:open" oder "created_at:>'2024-01-01'").
 * Bereits importierte Orders werden erkannt und übersprungen — die Übernahme
 * darf beliebig oft und überlappend laufen.
 */
export async function backfillOrdersChunk(
  q: string,
  cursor: string | null,
): Promise<{ imported: number; nextCursor: string | null }> {
  const { fetchOrdersPage } = await import('./shopify')
  const { orders, endCursor } = await fetchOrdersPage(q, cursor)

  let imported = 0
  for (const order of orders) {
    const result = await importShopifyOrder(order)
    if (result.created) imported++
  }

  const stand = await leseStand('backfill_orders')
  await schreibeStand('backfill_orders', {
    importiert: stand.importiert + imported,
    fertig: endCursor === null,
  })
  return { imported, nextCursor: endCursor }
}

// --- Webhook-Verarbeitung --------------------------------------------------

export interface ProcessResult {
  processed: number
  failed: number
}

/** Arbeitet die gespeicherten Webhook-Events ab. */
export async function processPendingWebhooks(limit = 25): Promise<ProcessResult> {
  // Exklusiv greifen (S4): jeder Lauf nimmt sich seine Ereignisse und setzt
  // eine Frist von zwei Minuten — parallele Läufe (jeder Webhook startet
  // einen) überspringen sie; stirbt ein Lauf, kommt das Ereignis nach der
  // Frist von selbst zurück. Bestellungen zuerst: ein Bestands-Echo des
  // Shops darf nie vor der Bestellung stehen, die es ausgelöst hat.
  const gegriffen = await sql<
    { id: string; topic: string; shopify_order_id: string | null; payload: Record<string, unknown>; received_at: Date }[]
  >`
    update shopify_webhook_events e
    set next_attempt_at = now() + interval '2 minutes'
    where e.id in (
      select id from shopify_webhook_events
      where status = 'pending' and attempts < 5 and next_attempt_at <= now()
      order by (topic like 'inventory_levels/%'), received_at
      limit ${limit}
      for update skip locked)
    returning e.id, e.topic, e.shopify_order_id, e.payload, e.received_at`
  const echo = (topic: string) => (topic.startsWith('inventory_levels/') ? 1 : 0)
  // Früher doppelt verpackt gespeicherte Payloads (JSON-Text in jsonb) auspacken.
  for (const e of gegriffen) {
    if (typeof e.payload === 'string') {
      try {
        e.payload = JSON.parse(e.payload) as Record<string, unknown>
      } catch {
        e.payload = {}
      }
    }
  }
  const events = [...gegriffen].sort(
    (a, b) => echo(a.topic) - echo(b.topic) || a.received_at.getTime() - b.received_at.getTime(),
  )

  let processed = 0
  let failed = 0
  let bestellungen = 0
  // Mehrere Ereignisse derselben Bestellung in einem Lauf: einmal holen,
  // einmal einlesen — die übrigen gelten als miterledigt.
  const erledigt = new Map<string, string>()

  // Echos ohne Abruf erledigen (0138): trägt das Ereignis einen Stand, den
  // KRNL schon eingelesen hat, gibt es nichts zu holen. Stornos nie — die
  // sollen immer durch den vollen Weg.
  const mitStand = events.filter(
    (e) => e.topic.startsWith('orders/') && e.topic !== 'orders/cancelled' && e.shopify_order_id &&
      typeof (e.payload as { updated_at?: unknown }).updated_at === 'string',
  )
  const bekannt = new Map<string, Date>()
  if (mitStand.length > 0) {
    const zeilen = await sql<{ shopify_order_id: string; stand: Date }[]>`
      select shopify_order_id, shopify_stand_at as stand from sales_orders
      where shopify_order_id = any(${mitStand.map((e) => e.shopify_order_id!)}::text[]) and shopify_stand_at is not null`
    for (const z of zeilen) bekannt.set(z.shopify_order_id, z.stand)
  }
  const istEcho = (e: (typeof events)[number]): boolean => {
    const stand = e.shopify_order_id ? bekannt.get(e.shopify_order_id) : undefined
    const gemeldet = new Date(String((e.payload as { updated_at?: unknown }).updated_at ?? ''))
    return Boolean(stand) && mitStand.includes(e) && !Number.isNaN(gemeldet.getTime()) && gemeldet.getTime() <= stand!.getTime()
  }

  // Alle Bestellungen des Stapels in EINEM Abruf (S4) — scheitert er
  // (Drosselung), fällt jedes Ereignis einzeln auf fetchOrder zurück.
  const zuHolen = [...new Set(events
    .filter((e) => e.topic.startsWith('orders/') && e.shopify_order_id && !istEcho(e))
    .map((e) => e.shopify_order_id!))]
  let geholt: Map<string, ShopifyOrder> | null = null
  let stapelFehler: unknown = null
  if (zuHolen.length > 1) {
    try {
      geholt = await fetchOrders(zuHolen)
    } catch (err) {
      stapelFehler = err
    }
  }

  for (const event of events) {
    try {
      if (istEcho(event)) {
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(), error = 'Stand schon eingelesen — kein Abruf nötig'
                  where id = ${event.id}`
        processed++
        continue
      }
      if (stapelFehler && event.topic.startsWith('orders/')) throw stapelFehler
      if (event.topic.startsWith('orders/') && event.shopify_order_id && erledigt.has(event.shopify_order_id)) {
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(),
                      error = ${`Miterledigt: ${erledigt.get(event.shopify_order_id)}`}
                  where id = ${event.id}`
        processed++
        continue
      }
      // Produktänderungen aus dem Shop: frisch holen und abgleichen.
      if (event.topic.startsWith('products/')) {
        const rohId = (event.payload as { admin_graphql_api_id?: string; id?: number | string })
        const gid = rohId.admin_graphql_api_id ??
          (rohId.id != null ? `gid://shopify/Product/${String(rohId.id)}` : null)
        const { aktualisiereProduktAusShopify } = await import('./produkt-import')
        const meldung = gid
          ? await aktualisiereProduktAusShopify(gid)
          : 'Kein Produkt-Identifier im Payload — übersprungen'
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(), error = ${meldung}
                  where id = ${event.id}`
        processed++
        continue
      }

      // Bestandsmeldungen tragen keine Order-ID — eigener Zweig vor der
      // Order-Verarbeitung, sonst würden sie als "ohne Order-ID" übersprungen.
      if (event.topic.startsWith('inventory_levels/')) {
        const { verarbeiteInventarWebhook } = await import('./inventar')
        const meldung = await verarbeiteInventarWebhook(event.payload)
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(), error = ${meldung}
                  where id = ${event.id}`
        processed++
        continue
      }

      // Fulfillment-Halt (0134): der Webhook nennt nur den Fulfillment-Auftrag —
      // die Bestellung dazu frisch holen und den Halt nachziehen.
      if (event.topic.startsWith('fulfillment_orders/')) {
        const roh = (event.payload as { fulfillment_order?: { id?: string | number } }).fulfillment_order?.id
        const foGid = roh == null ? null
          : String(roh).startsWith('gid://') ? String(roh) : `gid://shopify/FulfillmentOrder/${String(roh)}`
        const { fetchOrderGidZuFulfillmentOrder } = await import('./shopify')
        const orderGid = foGid ? await fetchOrderGidZuFulfillmentOrder(foGid) : null
        const bestellung = orderGid ? await fetchOrder(orderGid) : null
        if (!bestellung) {
          await sql`update shopify_webhook_events
                    set status = 'skipped', processed_at = now(),
                        error = 'Keine Bestellung zum Fulfillment-Auftrag gefunden'
                    where id = ${event.id}`
          continue
        }
        const r = await importShopifyOrder(bestellung, event.id, { haltFrisch: true })
        await sql`update shopify_webhook_events
                  set status = 'done', processed_at = now(), error = ${r.message},
                      shopify_order_id = ${bestellung.id}
                  where id = ${event.id}`
        processed++
        continue
      }

      const gid = event.shopify_order_id
      if (!gid) {
        await sql`update shopify_webhook_events
                  set status = 'skipped', processed_at = now(),
                      error = 'Keine Order-ID im Payload'
                  where id = ${event.id}`
        continue
      }

      // Immer den aktuellen Stand von Shopify holen: Webhooks können veraltet
      // oder in falscher Reihenfolge ankommen.
      const order = geholt ? (geholt.get(gid) ?? null) : await fetchOrder(gid)
      if (!order) {
        await sql`update shopify_webhook_events
                  set status = 'skipped', processed_at = now(),
                      error = 'Order in Shopify nicht gefunden'
                  where id = ${event.id}`
        continue
      }

      const result = await importShopifyOrder(order, event.id)
      await sql`
        update shopify_webhook_events
        set status = 'done', processed_at = now(), error = ${result.message}
        where id = ${event.id}`
      erledigt.set(gid, result.message)
      processed++
      bestellungen++
    } catch (err) {
      failed++
      // Drosselung (S4): kein Fehler der Bestellung — in fünf Sekunden noch
      // einmal, ohne einen Versuch zu verbrauchen (sonst wartete sie Minuten).
      if (err instanceof ShopifyError && err.retryable && /thrott|429/i.test(err.message)) {
        await sql`
          update shopify_webhook_events
          set error = 'Shop drosselt — neuer Anlauf in fünf Sekunden', next_attempt_at = now() + interval '5 seconds'
          where id = ${event.id}`
        continue
      }
      // Gleiche Backoff-Staffel wie die Job-Queue statt Sofort-Wiederholung.
      await sql`
        update shopify_webhook_events
        set attempts = attempts + 1,
            error = ${err instanceof Error ? err.message : String(err)},
            status = case when attempts + 1 >= 5 then 'failed'::webhook_status
                          else 'pending'::webhook_status end,
            next_attempt_at = now() + make_interval(
              mins => (array[1, 5, 15, 60, 180])[least(attempts + 1, 5)])
        where id = ${event.id}`
    }
  }

  // Jede Bestellung (auch Storno) ändert, was baubar bzw. frei ist — sofort
  // abgleichen, nicht erst im Cron: bei Releases zählt jede Sekunde. Der
  // Webhook arbeitet den Job direkt danach ab (runDueJobs in after()).
  if (bestellungen > 0) {
    const { ausloeserAktiv, shopifyModus } = await import('./shopify-modus')
    if (ausloeserAktiv(await shopifyModus(sql))) await sql`select inventar_abgleich_anstossen()`
  }

  return { processed, failed }
}

/** Stellt ein fehlgeschlagenes Webhook-Event zur erneuten Verarbeitung ein. */
export async function retryWebhookEvent(eventId: string): Promise<void> {
  await sql`
    update shopify_webhook_events
    set status = 'pending', attempts = 0, error = null, next_attempt_at = now()
    where id = ${eventId} and status in ('failed', 'skipped')`
}

/**
 * Abgleich mit Shopify als Sicherheitsnetz: holt geänderte Orders und legt
 * fehlende an. Fängt Webhooks ab, die nie ankamen.
 */
export async function reconcileOrders(): Promise<{
  checked: number
  imported: number
  mehr: boolean
  versand: Awaited<ReturnType<typeof versandAbgleichen>>
}> {
  const [state] = await sql<{ value: string }[]>`
    select value #>> '{}' as value from shopify_sync_state where key = 'last_reconciliation_at'`
  const since = new Date(state?.value ?? Date.now() - 24 * 60 * 60 * 1000)
  const beginn = new Date()

  const { fetchOrdersUpdatedSince } = await import('./shopify')
  const { orders, mehr } = await fetchOrdersUpdatedSince(since)

  let imported = 0
  for (const order of orders) {
    const result = await importShopifyOrder(order)
    if (result.created) imported++
  }

  // Marke: bei weiteren Seiten nur bis zur letzten gelesenen Änderung
  // (aufsteigend sortiert) — der nächste Lauf macht dort weiter. Sonst bis
  // zum Beginn dieses Laufs, damit nichts zwischen Abfrage und Marke fällt.
  const letzte = orders.at(-1)?.updatedAt
  const marke = mehr && letzte ? letzte : beginn.toISOString()
  await sql`
    insert into shopify_sync_state (key, value)
    values ('last_reconciliation_at', to_jsonb(${marke}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()`

  // Sicherheitsnetz für den Versand außerhalb von KRNL (2026-10-15): ein
  // Stapel offener Shop-Aufträge je Lauf, reihum — fängt alles, was der
  // Abgleich nach updated_at nie sieht (vor der Umstellung versendet).
  const versand = await versandAbgleichen(10)

  return { checked: orders.length, imported, mehr, versand }
}

/**
 * Versand-Abgleich offener Shop-Aufträge (2026-10-15): jeder Auftrag mit
 * offener Lieferung und ohne eigene Sendung wird einzeln frisch aus dem
 * Shop geholt — hat der Shop ihn inzwischen versendet (Sendcloud), zieht
 * importShopifyOrder nach (Warenausgang, Nachfrage an die Fertigung).
 * Reihum über einen Cursor (shopify_sync_state 'versand_abgleich_cursor'),
 * damit der Cron mit kleinem Stapel alle erreicht; „Versand offener
 * Shop-Aufträge prüfen" im Monitor nimmt alle auf einmal.
 */
export async function versandAbgleichen(
  limit = 10,
): Promise<{ geprueft: number; nachgezogen: number; fehler: number; nachfragen: number; meldungen: string[] }> {
  const [cursorRow] = await sql<{ value: string | null }[]>`
    select value #>> '{}' as value from shopify_sync_state where key = 'versand_abgleich_cursor'`
  const cursor = cursorRow?.value ?? ''
  const offene = (ab: string) => sql<{ id: string; number: string; shopify_order_id: string }[]>`
    select so.id, so.number, so.shopify_order_id
    from sales_orders so
    where so.shopify_order_id is not null and so.state not in ('draft', 'cancel')
      and exists (select 1 from stock_pickings p
                  where p.origin_model = 'sales_order' and p.origin_id = so.id and p.state not in ('done', 'cancel'))
      and not exists (select 1 from shipments s join stock_pickings sp on sp.id = s.picking_id
                      where sp.origin_model = 'sales_order' and sp.origin_id = so.id and s.state <> 'cancelled')
      and so.number > ${ab}
    order by so.number
    limit ${limit}`
  let stapel = await offene(cursor)
  // Ende der Runde erreicht: von vorn — derselbe Lauf nimmt den Anfang mit.
  if (stapel.length === 0 && cursor) stapel = await offene('')

  const { fetchOrder } = await import('./shopify')
  let nachgezogen = 0
  let fehler = 0
  const meldungen: string[] = []
  for (const so of stapel) {
    try {
      const order = await fetchOrder(so.shopify_order_id)
      if (!order) continue
      const r = await importShopifyOrder(order)
      if (/im Shop versendet/.test(r.message)) {
        nachgezogen++
        meldungen.push(r.message)
      }
    } catch (err) {
      fehler++
      meldungen.push(`${so.number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const neuerCursor = stapel.length < limit ? '' : (stapel.at(-1)?.number ?? '')
  await sql`
    insert into shopify_sync_state (key, value)
    values ('versand_abgleich_cursor', to_jsonb(${neuerCursor}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()`
  // Nachfragen ans Team Fertigung sind eine Projektion aus den Belegen —
  // ohne Buchung geschlossene werden hier wieder angelegt.
  const { fertigungsNachfragenNachziehen } = await import('@/modules/verkauf/extern-versand')
  const nachfragen = await fertigungsNachfragenNachziehen(sql)
  return { geprueft: stapel.length, nachgezogen, fehler, nachfragen, meldungen }
}

/** Holt genau eine Bestellung frisch von Shopify und importiert sie. */
export async function importOrderByGid(gid: string): Promise<ImportResult> {
  const { fetchOrder } = await import('./shopify')
  const order = await fetchOrder(gid)
  if (!order) {
    return { salesOrderId: null, created: false, unmatched: 0,
      message: 'Bestellung in Shopify nicht gefunden' }
  }
  return importShopifyOrder(order)
}
