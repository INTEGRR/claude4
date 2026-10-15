import type { TransactionSql } from 'postgres'
import type { ShopifyOrder } from '../integrationen/shopify.ts'
import { NACHFRAGE_PRAEFIX, externVersandAusShop, externVersandText, fertigungsNachfrage, nachfrageNummern } from './extern-versand-logik.ts'
import type { Sql } from 'postgres'

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

/**
 * Fertigungsauftrag fertig gemeldet oder storniert: die Nachfrage „Extern
 * versendet: Fertigung … noch durchführen?" ist damit beantwortet — sie
 * wird abgehakt, sobald ALLE darin genannten Aufträge fertig oder
 * storniert sind (die Antwort steht als Notiz). Niemand muss die Aufgabe
 * zusätzlich von Hand schließen.
 */
export async function fertigungsNachfrageAbhaken(
  db: Sql | TransactionSql,
  moId: string,
  actor: string,
  antwort: 'fertig gemeldet' | 'storniert',
): Promise<string[]> {
  const [mo] = await db<{ number: string }[]>`select number from manufacturing_orders where id = ${moId}`
  if (!mo) return []
  const offen = await db<{ id: string; titel: string }[]>`
    select id, titel from aufgaben
    where status = 'offen' and rolle = 'fertigung' and titel like ${`${NACHFRAGE_PRAEFIX}%`}
      and titel like ${`%${mo.number}%`}`
  const erledigt: string[] = []
  for (const a of offen) {
    const nummern = nachfrageNummern(a.titel)
    if (!nummern.includes(mo.number)) continue
    const [{ offen: nochOffen }] = await db<{ offen: number }[]>`
      select count(*)::int as offen from manufacturing_orders
      where number = any(${nummern}) and state not in ('done', 'cancel')`
    if (Number(nochOffen) > 0) continue
    const notiz = `Fertigungsauftrag ${mo.number} ${antwort}`
    const [fertig] = await db<{ id: string }[]>`
      update aufgaben set status = 'erledigt', erledigt_am = now(), erledigt_von = ${actor}, notiz = ${notiz}
      where id = ${a.id} and status = 'offen' returning id`
    if (!fertig) continue
    await db`select log_event('aufgabe', ${a.id}, 'info', ${`Erledigt: ${a.titel} — ${notiz}`}, ${actor})`
    erledigt.push(a.titel)
  }
  return erledigt
}

/**
 * Nachfragen sind eine Projektion aus den Belegen (2026-10-15): extern
 * versendete Lieferung + noch offener Fertigungsauftrag ⇒ es muss eine
 * offene Nachfrage geben. Wurde sie ohne Buchung geschlossen (alte Fassung
 * „Abhaken"), legt der Abgleich sie wieder an — die Frage ist erst
 * beantwortet, wenn der Fertigungsauftrag fertig oder storniert ist.
 */
export async function fertigungsNachfragenNachziehen(db: Sql | TransactionSql): Promise<number> {
  const faelle = await db<{ id: string; number: string; shopify_order_name: string | null; mo_ids: string[]; mo_nummern: string[] }[]>`
    select so.id, so.number, so.shopify_order_name,
           array_agg(m.id order by m.number) as mo_ids, array_agg(m.number order by m.number) as mo_nummern
    from sales_orders so
    join manufacturing_orders m on m.sales_order_id = so.id and m.state not in ('done', 'cancel')
    where exists (select 1 from stock_pickings p
                  where p.origin_model = 'sales_order' and p.origin_id = so.id
                    and p.extern_versand is not null and p.state = 'done')
    group by so.id, so.number, so.shopify_order_name`
  let neu = 0
  for (const f of faelle) {
    const mos = f.mo_ids.map((id, i) => ({ id, number: f.mo_nummern[i] }))
    const { titel, beschreibung } = fertigungsNachfrage({ id: f.id, number: f.number, shopify_order_name: f.shopify_order_name }, mos)
    const [row] = await db<{ id: string }[]>`
      insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von)
      select ${titel}, ${beschreibung}, 'fertigung', (now() at time zone 'Europe/Berlin')::date, 'shopify'
      where not exists (select 1 from aufgaben where titel = ${titel} and status = 'offen')
      returning id`
    if (!row) continue
    neu++
    await db`select log_event('sales_order', ${f.id}, 'error',
      ${`Fertigung ${mos.map((m) => m.number).join(', ')} noch offen — Nachfrage ans Team Fertigung erneut angelegt (die vorige war ohne Buchung geschlossen).`}, 'shopify')`
  }
  return neu
}
