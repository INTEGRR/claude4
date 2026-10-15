import type { TransactionSql } from 'postgres'
import type { ShopifyOrder } from '../integrationen/shopify.ts'
import { externVersandAusShop, externVersandText, fertigungsNachfrage } from './extern-versand-logik.ts'

/**
 * Versand außerhalb von KRNL nachziehen (2026-10-15): Sendcloud läuft
 * parallel — die Sendung entsteht dort, Shopify meldet FULFILLED, und in
 * KRNL stand der Auftrag auf „unfertig". Läuft im Shop-Import innerhalb
 * derselben Transaktion:
 *
 *  - nur, wenn KRNL selbst KEINE Sendung zum Auftrag hat (sonst meldet
 *    Shopify bloß unsere eigene Rückmeldung zurück);
 *  - offene Lieferungen werden mit den Trackingdaten versehen und als
 *    Warenausgang gebucht (picking_validate, kein Rückstand) — der Auftrag
 *    ist damit geliefert, die Shop-Rückmeldung entfällt;
 *  - offene Druckaufträge zur Lieferung werden zurückgezogen;
 *  - ein noch offener Fertigungsauftrag wird zur Nachfrage ans Team
 *    Fertigung (Aufgabe, Doppel-Schutz über den Titel): bauen mit
 *    Materialverbrauch oder stornieren und Bestand korrigieren. Bis dahin
 *    steht das Erzeugnis mit negativem Bestand im Lager — sichtbar, nicht
 *    versteckt.
 */
export async function externVersandNachziehen(
  t: TransactionSql,
  auftragId: string,
  order: ShopifyOrder,
): Promise<string | null> {
  const extern = externVersandAusShop(order)
  if (!extern) return null

  const offen = await t<{ id: string; number: string }[]>`
    select id, number from stock_pickings
    where origin_model = 'sales_order' and origin_id = ${auftragId} and state not in ('done', 'cancel')
    order by number`
  if (offen.length === 0) return null

  const [eigene] = await t<{ n: number }[]>`
    select count(*)::int as n
    from shipments s join stock_pickings sp on sp.id = s.picking_id
    where sp.origin_model = 'sales_order' and sp.origin_id = ${auftragId} and s.state <> 'cancelled'`
  if (Number(eigene.n) > 0) return null

  const [auftrag] = await t<{ number: string; shopify_order_name: string | null }[]>`
    select number, shopify_order_name from sales_orders where id = ${auftragId}`
  const spur = externVersandText(extern)

  for (const p of offen) {
    await t`update stock_pickings set extern_versand = ${t.json(extern as never)} where id = ${p.id}`
    await t`update druckauftraege set status = 'fehler', fehler = 'Extern versendet — nicht gedruckt'
            where status = 'offen' and picking_id = ${p.id}`
    await t`select picking_validate(${p.id}, '{}'::jsonb, false)`
    await t`select log_event('stock_picking', ${p.id}, 'state',
      ${`Im Shop als versendet gemeldet (${spur}) — Warenausgang gebucht, keine eigene Shop-Rückmeldung.`}, 'shopify')`
  }
  const lieferungen = offen.map((p) => p.number).join(', ')
  await t`select log_event('sales_order', ${auftragId}, 'state',
    ${`Versand außerhalb von KRNL (${spur}): ${lieferungen} als Warenausgang gebucht.`}, 'shopify')`

  const mos = await t<{ id: string; number: string }[]>`
    select id, number from manufacturing_orders
    where sales_order_id = ${auftragId} and state not in ('done', 'cancel')
    order by number`
  let nachfrage = ''
  if (mos.length > 0) {
    const { titel, beschreibung } = fertigungsNachfrage({ id: auftragId, ...auftrag }, mos)
    const [neu] = await t<{ id: string }[]>`
      insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von)
      select ${titel}, ${beschreibung}, 'fertigung', (now() at time zone 'Europe/Berlin')::date, 'shopify'
      where not exists (select 1 from aufgaben where titel = ${titel} and status = 'offen')
      returning id`
    const nummern = mos.map((m) => m.number).join(', ')
    if (neu) {
      await t`select log_event('sales_order', ${auftragId}, 'error',
        ${`Fertigung ${nummern} noch offen — Nachfrage ans Team Fertigung angelegt (Aufgabe).`}, 'shopify')`
    }
    nachfrage = `; Fertigung ${nummern} offen — Nachfrage als Aufgabe`
  }
  return `${auftrag.number}: im Shop versendet (${spur}) — ${lieferungen} gebucht${nachfrage}`
}
