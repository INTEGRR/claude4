/**
 * Fertigprodukt-Bestand aus Odoo zurücknehmen (Entscheidungslog 2026-09-30,
 * „Fertigprodukte ohne Odoo-Bestand").
 *
 * In Odoo stehen Tastaturen und Switch-Tester mit Bestand, obwohl sie
 * verkauft und verschickt sind — die Lieferungen wurden dort nicht
 * ausgebucht. Die Übernahme vom 2026-09-30 09:11 hat diesen Bestand
 * gebucht. Tatsächlich sind alle Fertigprodukte bei 0.
 *
 * Fertigprodukt = Variante einer Vorlage mit aktiver Odoo-Stückliste, die
 * selbst keine Komponente einer aktiven Stückliste ist (Halbfabrikate wie
 * der 3D-Druck des Switch-Testers bleiben). Zurückgenommen wird nur, wo der
 * Bestand ausschließlich aus Zählungen der Odoo-Übernahme besteht (Notiz
 * „Odoo-Übernahme …", ältere Läufe per 0099 nachgetragen) — hat die
 * Variante andere Buchungen (Eingang, Fertigmeldung, Lieferung, eine von
 * Hand gezählte Inventur), ist der Bestand womöglich echt: dann nichts tun
 * und melden. So bleibt der Knopf dauerhaft gefahrlos.
 *
 * Je Lagerort: erst Reservierungen wartender Bewegungen lösen (sonst stünde
 * eine Lieferung auf „bereit" ohne Ware), dann per Inventurzählung auf 0 —
 * damit bewertet und nachvollziehbar wie jede Inventur.
 *
 * Danach in derselben Transaktion: Fertigung nachziehen. Offene
 * Verkaufsaufträge, die vor den Stücklisten/Routen bestätigt wurden, haben
 * keinen Fertigungsauftrag — ohne Bestand würden sie nie geliefert. Je
 * offener Menge (bestellt − geliefert − schon in Fertigung) entsteht ein
 * bestätigter Fertigungsauftrag wie bei der Auftragsbestätigung (Route
 * Fertigen + Auf Auftrag, Stückliste vorhanden).
 */
import { sql, tx } from '@/db/client'
import type { TransactionSql } from 'postgres'

/** Notiz der eigenen Korrekturzählung — zählt wie eine Übernahme-Zählung, nicht als echte Buchung. */
const NOTIZ = 'Odoo-Fertigbestand zurückgenommen'

export interface FertigbestandKandidat {
  variantId: string
  sku: string | null
  name: string
  menge: number
  reserviert: number
  /** Erledigte Bewegungen, die keine Zählung der Odoo-Übernahme sind (dann bleibt der Bestand). */
  echteBewegungen: number
}

export async function fertigbestandKandidaten(
  ziel: typeof sql | TransactionSql = sql,
): Promise<FertigbestandKandidat[]> {
  const rows = await ziel<
    { variant_id: string; sku: string | null; name: string; menge: number; reserviert: number; echte: number }[]
  >`
    select pv.id as variant_id, pv.sku, pv.display_name as name,
           sum(q.on_hand)::float as menge, sum(q.reserved)::float as reserviert,
           (select count(*)::int from stock_moves m
             left join inventory_counts ic on ic.id = m.inventory_id
             where m.variant_id = pv.id and m.state = 'done'
               and (ic.id is null or ic.note is null
                    or (ic.note not like 'Odoo-Übernahme%' and ic.note not like ${`${NOTIZ}%`}))) as echte
    from product_variants pv
    join stock_quants q on q.variant_id = pv.id
    join stock_locations l on l.id = q.location_id and l.type = 'internal'
    where exists (select 1 from boms b
                  where b.template_id = pv.template_id and b.active and b.herkunft = 'odoo')
      and not exists (select 1 from bom_lines bl join boms b on b.id = bl.bom_id and b.active
                      where bl.component_variant_id = pv.id)
    group by pv.id, pv.sku, pv.display_name
    having sum(q.on_hand) > 0
    order by pv.sku nulls last, pv.display_name`
  return rows.map((r) => ({
    variantId: r.variant_id,
    sku: r.sku,
    name: r.name,
    menge: Number(r.menge),
    reserviert: Number(r.reserviert),
    echteBewegungen: r.echte,
  }))
}

export interface FertigungsLuecke {
  orderId: string
  nummer: string
  variantId: string
  sku: string | null
  fehlt: number
}

/** Offene Verkaufsmengen mit Route Fertigen + Auf Auftrag, die noch keinen Fertigungsauftrag haben. */
export async function fertigungsLuecken(ziel: typeof sql | TransactionSql = sql): Promise<FertigungsLuecke[]> {
  const rows = await ziel<{ order_id: string; nummer: string; variant_id: string; sku: string | null; fehlt: number }[]>`
    select so.id as order_id, so.number as nummer, sol.variant_id, pv.sku,
           (sum(sol.qty - sol.qty_delivered)
            - coalesce((select sum(mo.qty_to_produce) from manufacturing_orders mo
                        where mo.sales_order_id = so.id and mo.variant_id = sol.variant_id
                          and mo.state <> 'cancel'), 0))::float as fehlt
    from sales_orders so
    join sales_order_lines sol on sol.order_id = so.id and sol.display_type is null and sol.qty > sol.qty_delivered
    join product_variants pv on pv.id = sol.variant_id
    join product_templates pt on pt.id = pv.template_id
    where so.state = 'sale' and pt.route_manufacture and pt.route_mto
      and resolve_bom(sol.variant_id) is not null
    group by so.id, so.number, sol.variant_id, pv.sku
    having sum(sol.qty - sol.qty_delivered)
           > coalesce((select sum(mo.qty_to_produce) from manufacturing_orders mo
                       where mo.sales_order_id = so.id and mo.variant_id = sol.variant_id
                         and mo.state <> 'cancel'), 0)
    order by so.number, pv.sku`
  return rows.map((r) => ({ orderId: r.order_id, nummer: r.nummer, variantId: r.variant_id, sku: r.sku, fehlt: Number(r.fehlt) }))
}

export interface FertigbestandBericht {
  varianten: number
  menge: number
  reservierungenGeloest: number
  uebersprungen: { sku: string | null; name: string; menge: number }[]
  /** Nachgezogene Fertigungsaufträge: Auftragsnummer, SKU, Menge. */
  fertigungsauftraege: { nummer: string; sku: string | null; menge: number }[]
}

export async function fertigbestandZuruecknehmen(von: string): Promise<FertigbestandBericht> {
  return tx(async (t) => {
    const bericht: FertigbestandBericht = {
      varianten: 0, menge: 0, reservierungenGeloest: 0, uebersprungen: [], fertigungsauftraege: [],
    }
    for (const k of await fertigbestandKandidaten(t)) {
      if (k.echteBewegungen > 0) {
        bericht.uebersprungen.push({ sku: k.sku, name: k.name, menge: k.menge })
        continue
      }
      const orte = await t<{ location_id: string; on_hand: number }[]>`
        select q.location_id, q.on_hand::float as on_hand
        from stock_quants q join stock_locations l on l.id = q.location_id and l.type = 'internal'
        where q.variant_id = ${k.variantId} and q.on_hand > 0
        for update of q`
      for (const ort of orte) {
        // Reservierungen wartender Bewegungen lösen — sie warten danach wieder.
        const reserviert = await t<{ id: string; picking_id: string | null }[]>`
          select id, picking_id from stock_moves
          where variant_id = ${k.variantId} and src_location_id = ${ort.location_id}
            and state in ('confirmed', 'assigned') and reserved_qty > 0`
        for (const m of reserviert) {
          await t`select move_unreserve(${m.id})`
          await t`update stock_moves set state = 'confirmed' where id = ${m.id} and state = 'assigned'`
        }
        for (const picking of new Set(reserviert.map((m) => m.picking_id).filter((p): p is string => p !== null))) {
          await t`select picking_recompute_state(${picking})`
        }
        bericht.reservierungenGeloest += reserviert.length

        const [zaehlung] = await t<{ id: string }[]>`
          insert into inventory_counts (location_id, variant_id, counted_qty, book_qty, note)
          values (${ort.location_id}, ${k.variantId}, 0, ${ort.on_hand},
                  ${`${NOTIZ} (in Odoo nicht ausgebucht)`})
          returning id`
        await t`select inventory_apply(${zaehlung.id}, ${von})`
      }
      bericht.varianten++
      bericht.menge += k.menge
    }

    // Fertigung nachziehen — wie confirm_sales_order bei Route Fertigen + Auf Auftrag.
    for (const l of await fertigungsLuecken(t)) {
      const [{ mo }] = await t<{ mo: string }[]>`
        select create_manufacturing_order(${l.variantId}, ${l.fehlt}, ${l.orderId}, null, ${von}) as mo`
      await t`update manufacturing_orders set origin = ${l.nummer} where id = ${mo}`
      await t`select mo_confirm(${mo}, ${von})`
      await t`select log_event('sales_order', ${l.orderId}, 'note',
        ${`Fertigungsauftrag nachgezogen (${l.fehlt} × ${l.sku ?? 'Artikel'}) — Odoo-Fertigbestand war falsch`}, ${von})`
      bericht.fertigungsauftraege.push({ nummer: l.nummer, sku: l.sku, menge: l.fehlt })
    }

    await t`select log_event('odoo', gen_random_uuid(), 'note',
      ${`Odoo-Fertigbestand zurückgenommen: ${bericht.varianten} Variante(n), ${bericht.menge} Stück, ` +
        `${bericht.reservierungenGeloest} Reservierung(en) gelöst; ${bericht.uebersprungen.length} übersprungen; ` +
        `${bericht.fertigungsauftraege.length} Fertigungsauftrag/-aufträge nachgezogen` +
        (bericht.fertigungsauftraege.length
          ? ` (${bericht.fertigungsauftraege.map((f) => `${f.nummer} ${f.menge}× ${f.sku ?? ''}`.trim()).join(', ')})`
          : '')},
      ${von})`
    return bericht
  })
}
