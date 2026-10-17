import type { TransactionSql } from 'postgres'
import type { ShopifyOrder } from '../integrationen/shopify.ts'
import { NACHFRAGE_PRAEFIXE, externVersandAusShop, externVersandText, fertigungsNachfrage, nachfrageNummern } from './extern-versand-logik.ts'
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
    where status = 'offen' and rolle = 'fertigung' and titel like any(${NACHFRAGE_PRAEFIXE.map((p) => `${p}%`)})
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

/** Ab hier zählt auch die von Hand gebuchte Lieferung (Einführung, Entscheidungslog 2026-10-17). */
export const NACHFRAGE_KRNL_AB = '2026-10-17'

/**
 * Nachfragen sind eine Projektion aus den Belegen (2026-10-15): versendete
 * Lieferung + noch offener Fertigungsauftrag ⇒ es muss eine offene
 * Nachfrage geben. Wurde sie ohne Buchung geschlossen (alte Fassung
 * „Abhaken"), legt der Abgleich sie wieder an — die Frage ist erst
 * beantwortet, wenn der Fertigungsauftrag fertig oder storniert ist.
 *
 * Seit 2026-10-17 zählt auch die in KRNL von Hand gebuchte Lieferung — aber
 * nur, wenn keine Lieferung des Auftrags mehr offen ist (sonst gehört der
 * offene Fertigungsauftrag zur Restlieferung, und es gibt nichts zu fragen).
 * `nurAuftrag` grenzt auf einen Auftrag ein (direkt nach dem Warenausgang).
 */
export async function fertigungsNachfragenNachziehen(db: Sql | TransactionSql, nurAuftrag: string | null = null): Promise<number> {
  const faelle = await db<{ id: string; number: string; shopify_order_name: string | null; extern: boolean; mo_ids: string[]; mo_nummern: string[] }[]>`
    select so.id, so.number, so.shopify_order_name,
           exists (select 1 from stock_pickings p
                   where p.origin_model = 'sales_order' and p.origin_id = so.id
                     and p.extern_versand is not null and p.state = 'done') as extern,
           array_agg(m.id order by m.number) as mo_ids, array_agg(m.number order by m.number) as mo_nummern
    from sales_orders so
    join manufacturing_orders m on m.sales_order_id = so.id and m.state not in ('done', 'cancel')
    where (${nurAuftrag}::uuid is null or so.id = ${nurAuftrag}::uuid)
      -- Extern versendet: immer; von Hand gebucht: erst ab Einführung —
      -- kein rückwirkender Schwall an Nachfragen für Altfälle.
      and exists (select 1 from stock_pickings p
                  where p.origin_model = 'sales_order' and p.origin_id = so.id and p.state = 'done'
                    and (p.extern_versand is not null or p.date_done >= ${NACHFRAGE_KRNL_AB}::date))
      and not exists (select 1 from stock_pickings p
                      where p.origin_model = 'sales_order' and p.origin_id = so.id
                        and p.state not in ('done', 'cancel'))
    group by so.id, so.number, so.shopify_order_name`
  let neu = 0
  for (const f of faelle) {
    const mos = f.mo_ids.map((id, i) => ({ id, number: f.mo_nummern[i] }))
    const { titel, beschreibung } = fertigungsNachfrage({ id: f.id, number: f.number, shopify_order_name: f.shopify_order_name }, mos, f.extern)
    const quelle = f.extern ? 'shopify' : 'system'
    const [row] = await db<{ id: string }[]>`
      insert into aufgaben (titel, beschreibung, rolle, faellig_am, erstellt_von)
      select ${titel}, ${beschreibung}, 'fertigung', (now() at time zone 'Europe/Berlin')::date, ${quelle}
      where not exists (select 1 from aufgaben where titel = ${titel} and status = 'offen')
      returning id`
    if (!row) continue
    neu++
    const nummern = mos.map((m) => m.number).join(', ')
    await db`select log_event('sales_order', ${f.id}, 'error',
      ${f.extern
        ? `Fertigung ${nummern} noch offen — Nachfrage ans Team Fertigung erneut angelegt (die vorige war ohne Buchung geschlossen).`
        : `Lieferung gebucht, Fertigung ${nummern} aber noch offen — Nachfrage ans Team Fertigung angelegt (Aufgabe).`}, ${quelle})`
  }
  return neu
}

/**
 * Direkt nach einem Warenausgang in KRNL (Lager, Packtisch): war es die
 * letzte offene Lieferung eines Verkaufsauftrags und ist dessen Fertigung
 * noch offen, entsteht sofort die Nachfrage — nicht erst beim nächsten
 * Shop-Abgleich. Darf den Warenausgang nie blockieren.
 */
export async function fertigungsNachfrageNachLieferung(db: Sql | TransactionSql, pickingId: string): Promise<void> {
  const [p] = await db<{ origin_id: string }[]>`
    select origin_id from stock_pickings
    where id = ${pickingId} and origin_model = 'sales_order' and state = 'done'`
  if (p) await fertigungsNachfragenNachziehen(db, p.origin_id)
}
