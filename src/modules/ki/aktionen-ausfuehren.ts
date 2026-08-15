import type { Sql } from 'postgres'
import { sql } from '@/db/client'
import { type AktionErgebnis, type AktionName, UUID_MUSTER } from './aktionen'
import { type ProduktEingabe, produktAnlegen } from './produkt-anlegen'

/**
 * Die Ausführung der Katalogaktionen — getrennt vom Katalog, weil nur dieser
 * Teil die Datenbank braucht. Aufgerufen wird sie ausschließlich von
 * /api/ki/aktion, also nach Rechteprüfung und Bestätigung durch den Benutzer.
 *
 * Angelegt wird immer über dieselben Wege wie in der Oberfläche: Nummernkreise
 * über next_sequence, Fertigungsaufträge über create_manufacturing_order. Kein
 * Sonderweg für die KI — sonst gälten für ihre Datensätze andere Regeln.
 */

// --- Auflösung von Bezeichnern ---------------------------------------------

/** Findet eine Variante über UUID, SKU, Barcode oder Anzeigename. */
async function variante(db: Sql, kennung: string): Promise<{ id: string; name: string }> {
  const alsUuid = UUID_MUSTER.test(kennung) ? kennung : null
  const [row] = await db<{ id: string; name: string }[]>`
    select pv.id, variant_display_name(pv.id) as name
    from product_variants pv
    join product_templates pt on pt.id = pv.template_id
    where pv.active and (
      pv.id = ${alsUuid}::uuid
      or lower(pv.sku) = lower(${kennung})
      or pv.barcode = ${kennung}
      or lower(coalesce(pv.display_name, pt.name)) = lower(${kennung})
    )
    limit 1`
  if (!row) throw new Error(`Produkt „${kennung}" nicht gefunden`)
  return row
}

/** Findet einen Kontakt über UUID, Referenz oder Namen. */
async function partner(db: Sql, kennung: string, art: 'kunde' | 'lieferant') {
  const alsUuid = UUID_MUSTER.test(kennung) ? kennung : null
  const [row] = await db<{ id: string; name: string }[]>`
    select id, name from partners
    where active
      and (id = ${alsUuid}::uuid or lower(ref) = lower(${kennung}) or lower(name) = lower(${kennung}))
      and (${art === 'kunde'}::boolean and is_customer or ${art === 'lieferant'}::boolean and is_vendor)
    limit 1`
  if (!row) {
    throw new Error(`${art === 'kunde' ? 'Kunde' : 'Lieferant'} „${kennung}" nicht gefunden`)
  }
  return row
}

async function stueck(db: Sql): Promise<string> {
  const [row] = await db<{ id: string }[]>`select id from uoms where name = 'Stück' limit 1`
  return row.id
}

// --- Ausführung -------------------------------------------------------------

type Werte = Record<string, unknown>
type Position = { produkt: string; menge: number; preis?: number }

const AUSFUEHRUNG: Record<AktionName, (p: never, actor: string) => Promise<AktionErgebnis>> = {
  kontakt_anlegen: async (p: Werte) => {
    const [row] = await sql<{ id: string }[]>`
      insert into partners (name, is_company, is_customer, is_vendor, email, phone,
                            street, house_number, zip, city, country_code)
      values (${p.name as string}, ${p.firma as boolean}, ${p.kunde as boolean},
              ${p.lieferant as boolean}, ${(p.email as string) ?? null},
              ${(p.telefon as string) ?? null}, ${(p.strasse as string) ?? null},
              ${(p.hausnummer as string) ?? null}, ${(p.plz as string) ?? null},
              ${(p.ort as string) ?? null}, ${((p.land as string) ?? 'DE').toUpperCase()})
      returning id`
    return { text: `Kontakt „${p.name as string}" angelegt.`, link: `/kontakte/${row.id}` }
  },

  verkaufsauftrag_anlegen: async (p: Werte, actor) => {
    const kunde = await partner(sql, p.kunde as string, 'kunde')
    const uom = await stueck(sql)
    const [order] = await sql<{ id: string; number: string }[]>`
      insert into sales_orders (number, partner_id, note)
      values (next_sequence('sale'), ${kunde.id}, ${(p.hinweis as string) ?? null})
      returning id, number`

    for (const [i, pos] of (p.positionen as Position[]).entries()) {
      const v = await variante(sql, pos.produkt)
      await sql`
        insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
        select ${order.id}, ${(i + 1) * 10}, ${v.id}, ${v.name}, ${pos.menge}, ${uom},
               coalesce(${pos.preis ?? null}::numeric, pt.list_price + coalesce(pv.price_extra, 0))
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${v.id}`
    }

    await sql`select log_event('sales_order', ${order.id}, 'note',
      ${'Über die KI-Analyse angelegt'}, ${actor})`
    return { text: `Angebot ${order.number} angelegt.`, link: `/verkauf/${order.id}` }
  },

  bestellung_anlegen: async (p: Werte, actor) => {
    const lieferant = await partner(sql, p.lieferant as string, 'lieferant')
    const uom = await stueck(sql)
    const [order] = await sql<{ id: string; number: string }[]>`
      insert into purchase_orders (number, vendor_id, note)
      values (next_sequence('purchase'), ${lieferant.id}, ${(p.hinweis as string) ?? null})
      returning id, number`

    for (const [i, pos] of (p.positionen as Position[]).entries()) {
      const v = await variante(sql, pos.produkt)
      await sql`
        insert into purchase_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit)
        select ${order.id}, ${(i + 1) * 10}, ${v.id}, ${v.name}, ${pos.menge}, ${uom},
               coalesce(${pos.preis ?? null}::numeric, pt.standard_cost)
        from product_variants pv join product_templates pt on pt.id = pv.template_id
        where pv.id = ${v.id}`
    }

    await sql`select log_event('purchase_order', ${order.id}, 'note',
      ${'Über die KI-Analyse angelegt'}, ${actor})`
    return { text: `Bestellung ${order.number} angelegt.`, link: `/einkauf/${order.id}` }
  },

  fertigungsauftrag_anlegen: async (p: Werte, actor) => {
    const v = await variante(sql, p.produkt as string)
    const [row] = await sql<{ id: string }[]>`
      select create_manufacturing_order(${v.id}, ${p.menge as number}, null, null, ${actor}) as id`
    const [mo] = await sql<{ number: string }[]>`
      select number from manufacturing_orders where id = ${row.id}`
    return {
      text: `Fertigungsauftrag ${mo.number} für ${v.name} angelegt.`,
      link: `/fertigung/${row.id}`,
    }
  },

  produkt_anlegen: async (p: Werte, actor) => {
    const ergebnis = await produktAnlegen(sql, p as unknown as ProduktEingabe, actor)
    return {
      text:
        `Produkt „${p.name as string}" mit ${ergebnis.varianten} Variante(n) angelegt` +
        (p.sku ? `, davon ${ergebnis.benannt} mit Artikelnummer` : '') +
        '. Stückliste und Bestände bitte in der Oberfläche ergänzen.',
      link: `/produkte/${ergebnis.templateId}`,
    }
  },

  meldebestand_anlegen: async (p: Werte) => {
    const v = await variante(sql, p.produkt as string)
    const [loc] = await sql<{ id: string }[]>`
      select id from stock_locations where full_path = 'WH/Stock'`
    const [vorhanden] = await sql<{ id: string }[]>`
      select id from stock_orderpoints where variant_id = ${v.id} and location_id = ${loc.id}`
    if (vorhanden) {
      throw new Error(`Für ${v.name} gibt es bereits einen Meldebestand — bitte dort ändern`)
    }
    await sql`
      insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, route)
      values (${v.id}, ${loc.id}, ${p.minimum as number}, ${p.maximum as number},
              ${(p.route as string) ?? null})`
    return { text: `Meldebestand für ${v.name} angelegt.`, link: '/lager/beschaffung' }
  },

  arbeitsplatz_anlegen: async (p: Werte) => {
    await sql`
      insert into work_centers (code, name, cost_per_hour, time_efficiency)
      values (${(p.kuerzel as string).toUpperCase()}, ${p.name as string},
              ${p.stundensatz as number}, ${(p.leistung as number) ?? 100})`
    return {
      text: `Arbeitsplatz ${(p.kuerzel as string).toUpperCase()} angelegt.`,
      link: '/fertigung/arbeitsplaetze',
    }
  },

  mitarbeiter_anlegen: async (p: Werte) => {
    const [row] = await sql<{ id: string; number: string }[]>`
      insert into employees (number, name, job_title, department, hourly_cost, barcode, weekly_hours)
      values (next_sequence('employee'), ${p.name as string}, ${(p.funktion as string) ?? null},
              ${(p.abteilung as string) ?? null}, ${(p.kostensatz as number) ?? 0},
              ${(p.ausweis as string) ?? null}, ${(p.wochenstunden as number) ?? 40})
      returning id, number`
    return { text: `Mitarbeiter ${row.number} angelegt.`, link: `/personal/${row.id}` }
  },

  notiz_anlegen: async (p: Werte, actor) => {
    await sql`select log_event(${p.model as string}, ${p.record_id as string}::uuid, 'note',
      ${p.text as string}, ${actor})`
    return { text: 'Notiz hinterlegt.' }
  },
}

export async function aktionAusfuehren(
  name: AktionName,
  werte: Record<string, unknown>,
  actor: string,
): Promise<AktionErgebnis> {
  return AUSFUEHRUNG[name](werte as never, actor)
}
