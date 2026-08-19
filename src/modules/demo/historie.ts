import type { Sql, TransactionSql } from 'postgres'

// Läuft auch innerhalb einer Transaktion (Tests mit Rollback).
type Client = Sql | TransactionSql

/**
 * Baut eine Betriebshistorie über die letzten Monate auf.
 *
 * Warum nicht einfach Zeilen einfügen? Weil dann nichts zusammenpasst:
 * Bestände, Wertschichten, Belegstatus und Kennzahlen leiten sich alle
 * voneinander ab. Deshalb laufen hier dieselben Funktionen wie in der
 * Oberfläche — Bestellung bestätigen, Wareneingang buchen, fertigen,
 * ausliefern —, und erst *danach* werden die entstandenen Datensätze in die
 * Vergangenheit geschoben. Ergebnis: eine Historie, die jede Prüfung besteht,
 * einschließlich der Ledger-Invariante.
 *
 * Die Zufallszahlen sind bewusst reproduzierbar (fester Startwert): zweimal
 * aufgebaut heißt zweimal dieselben Zahlen — sonst wäre kein Screenshot und
 * kein Vergleich etwas wert.
 */

const MONATE = 14

/** Kleiner deterministischer Generator — dieselbe Historie bei jedem Lauf. */
function zufall(startwert: number) {
  let s = startwert
  return {
    /** Gleichverteilt in [0,1). */
    zahl(): number {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    },
    /** Ganzzahl in [min, max]. */
    ganz(min: number, max: number): number {
      return min + Math.floor(this.zahl() * (max - min + 1))
    },
    /** Trifft mit Wahrscheinlichkeit p zu. */
    trifft(p: number): boolean {
      return this.zahl() < p
    },
    /** Ein Element aus der Liste. */
    aus<T>(liste: T[]): T {
      return liste[Math.floor(this.zahl() * liste.length)]
    },
  }
}

/**
 * Zeitstempel aller Tabellen, die eine Historie tragen. Wird eine Tabelle
 * vergessen, steht ihr Datensatz nachher in der Gegenwart und die Auswertung
 * stimmt nicht — deshalb die Liste vollständig und an einer Stelle.
 */
const ZEITSPALTEN: Record<string, string[]> = {
  stock_moves: ['date_done', 'created_at', 'updated_at'],
  stock_pickings: ['scheduled_date', 'date_done', 'created_at', 'updated_at'],
  sales_orders: ['order_date', 'confirmed_at', 'created_at', 'updated_at'],
  sales_order_lines: ['created_at', 'updated_at'],
  purchase_orders: ['order_deadline', 'confirmed_at', 'created_at', 'updated_at'],
  purchase_order_lines: ['date_planned', 'created_at', 'updated_at'],
  manufacturing_orders: ['scheduled_date', 'date_start', 'date_done', 'created_at', 'updated_at'],
  mo_operations: ['date_start', 'date_done', 'created_at', 'updated_at'],
  repair_orders: ['scheduled_date', 'created_at', 'updated_at'],
  repair_parts: ['created_at', 'updated_at'],
  time_entries: ['started_at', 'ended_at', 'created_at', 'updated_at'],
  inventory_counts: ['created_at', 'applied_at'],
  stock_lots: ['created_at', 'updated_at'],
  audit_log: ['created_at'],
  stock_valuation_layers: ['created_at'],
}

/**
 * Schiebt alles, was seit `marker` entstanden ist, um `tage` zurück.
 *
 * Die Wertschichten sind durch einen Trigger gegen Änderungen geschützt —
 * genau richtig im Betrieb, hier muss er kurz weichen. Das ist der einzige
 * Ort im ganzen Projekt, der das tut, und er läuft nur beim Aufbau der
 * Beispieldaten.
 */
async function verschiebe(sql: Client, marker: string, tage: number): Promise<void> {
  await sql`alter table stock_valuation_layers disable trigger valuation_layer_immutable`
  try {
    for (const [tabelle, spalten] of Object.entries(ZEITSPALTEN)) {
      const sets = spalten
        .map((s) => `${s} = ${s} - make_interval(days => ${tage})`)
        .join(', ')
      await sql.unsafe(`update ${tabelle} set ${sets} where created_at > $1`, [marker])
    }
  } finally {
    await sql`alter table stock_valuation_layers enable trigger valuation_layer_immutable`
  }
}

async function jetzt(sql: Client): Promise<string> {
  const [row] = await sql<{ now: string }[]>`select now()::text as now`
  return row.now
}

// --- Aufbau -----------------------------------------------------------------

export async function baueHistorie(sql: Client): Promise<string[]> {
  const r = zufall(20260808)
  const bericht: string[] = []

  const [vorhanden] = await sql<{ c: number }[]>`
    select count(*)::int as c from sales_orders where order_date < current_date - 40`
  if (vorhanden.c > 0) return ['Historie besteht bereits — übersprungen']

  // --- Stammdaten einsammeln ------------------------------------------------
  const varianten = await sql<{ id: string; name: string; sku: string | null }[]>`
    select pv.id, coalesce(pv.display_name, pt.name) as name, pv.sku
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pt.name like 'Tastatur%' and pv.active`
  if (varianten.length === 0) return ['Keine Endprodukte gefunden — Historie übersprungen']

  const komponenten = await sql<{ id: string; template_id: string; name: string }[]>`
    select pv.id, pv.template_id, coalesce(pv.display_name, pt.name) as name
    from product_variants pv join product_templates pt on pt.id = pv.template_id
    where pt.route_buy and pv.active`

  const [lieferant] = await sql<{ id: string }[]>`
    select id from partners where is_vendor and active limit 1`
  const mitarbeiter = await sql<{ id: string; name: string }[]>`
    select id, name from employees where active order by number`
  const [uom] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`

  // Zusätzliche Kunden, damit die Auswertungen nicht auf einem Namen stehen
  const kundenNamen = [
    'Keyboard Kontor Hamburg', 'TypeLab Berlin', 'Mechanik & Tasten München',
    'Nordic Keys AB', 'Clack Supply Köln', 'Studio Ergonomie Wien',
    'Retro Compute Leipzig', 'Bürowelt Rhein-Main',
  ]
  const staedte = [
    ['20095', 'Hamburg', 'DE'], ['10115', 'Berlin', 'DE'], ['80331', 'München', 'DE'],
    ['11122', 'Stockholm', 'SE'], ['50667', 'Köln', 'DE'], ['1010', 'Wien', 'AT'],
    ['04109', 'Leipzig', 'DE'], ['60311', 'Frankfurt', 'DE'],
  ]
  const kunden: string[] = []
  for (const [i, name] of kundenNamen.entries()) {
    const [ort] = [staedte[i]]
    const [row] = await sql<{ id: string }[]>`
      insert into partners (name, is_company, is_customer, street, house_number, zip, city, country_code)
      values (${name}, true, true, 'Musterweg', ${String(i + 1)}, ${ort[0]}, ${ort[1]}, ${ort[2]})
      returning id`
    kunden.push(row.id)
  }
  const [altkunde] = await sql<{ id: string }[]>`
    select id from partners where is_customer and active and id <> all(${kunden}) limit 1`
  if (altkunde) kunden.push(altkunde.id)

  // Anfangsbestand an Fertigware, bewertet zu den Plankosten. Ohne ihn
  // verkauft der erste Monat aus dünnem Bestand: der gleitende Durchschnitt
  // hat dann kaum Substanz und die Marge springt zwischen Traum und Verlust,
  // obwohl an Preis und Kosten nichts Ungewöhnliches ist.
  const [lager] = await sql<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  for (const v of varianten) {
    const [zaehlung] = await sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${lager.id}, ${v.id}, 45, 0) returning id`
    await sql`select inventory_apply(${zaehlung.id}, 'demo')`
  }
  await sql`select valuation_initialize(null, 'demo')`

  let auftraege = 0
  let bestellungen = 0
  let fertigungen = 0
  let reparaturen = 0

  // --- Monat für Monat ------------------------------------------------------
  for (let m = MONATE; m >= 1; m--) {
    const marker = await jetzt(sql)
    const tageZurueck = Math.round(m * 30.4)

    // Wachstum über die Zeit plus Weihnachtsgeschäft im November/Dezember
    const monatIndex = new Date(Date.now() - tageZurueck * 86400_000).getMonth()
    const saison = monatIndex === 10 || monatIndex === 11 ? 1.8 : 1
    const wachstum = 0.6 + ((MONATE - m) / MONATE) * 0.8

    // 1. Einkauf: Komponenten nachbestellen
    for (let i = 0; i < r.ganz(1, 3); i++) {
      const [po] = await sql<{ id: string }[]>`
        insert into purchase_orders (number, vendor_id)
        values (next_sequence('purchase'), ${lieferant.id}) returning id`
      const auswahl = [...komponenten].sort(() => r.zahl() - 0.5).slice(0, r.ganz(3, 7))
      for (const [j, k] of auswahl.entries()) {
        await sql`
          insert into purchase_order_lines (order_id, sequence, variant_id, name, qty, uom_id,
                                            price_unit, date_planned)
          select ${po.id}, ${(j + 1) * 10}, ${k.id}, ${k.name}, ${r.ganz(20, 200)}, ${uom.id},
                 pt.standard_cost, now() + make_interval(days => ${r.ganz(5, 20)})
          from product_templates pt where pt.id = ${k.template_id}`
      }
      const [picking] = await sql<{ confirm_purchase_order: string }[]>`
        select confirm_purchase_order(${po.id}, 'demo')`
      // Die meisten Lieferungen kommen an, ein Teil bleibt offen (Liefertreue)
      if (r.trifft(0.85)) {
        await sql`select picking_validate(${picking.confirm_purchase_order}, '{}'::jsonb, false)`
      }
      bestellungen++
    }

    // 2. Fertigung inklusive Arbeitszeit
    for (let i = 0; i < Math.round(r.ganz(2, 4) * wachstum); i++) {
      const v = r.aus(varianten)
      const menge = r.ganz(3, 12)
      let moId: string
      try {
        const [mo] = await sql<{ id: string }[]>`
          select create_manufacturing_order(${v.id}, ${menge}, null, null, 'demo') as id`
        moId = mo.id
        await sql`select mo_confirm(${moId}, 'demo')`
      } catch {
        continue // kein Bestand für die Komponenten — dann eben nicht
      }

      // Arbeitsgänge mit erfasster Zeit eines Mitarbeiters
      const gaenge = await sql<{ id: string; duration_expected: number }[]>`
        select id, duration_expected from mo_operations where mo_id = ${moId} order by sequence`
      for (const g of gaenge) {
        const person = r.aus(mitarbeiter)
        if (!person) break
        const minuten = Math.max(1, Math.round(Number(g.duration_expected) * (0.8 + r.zahl() * 0.5)))
        const [eintrag] = await sql<{ id: string }[]>`
          select time_entry_start(${person.id}, 'production', ${g.id}, 'demo') as id`
        await sql`update time_entries set started_at = now() - make_interval(mins => ${minuten})
                  where id = ${eintrag.id}`
        await sql`select time_entry_stop(${eintrag.id}, null, 'demo')`
      }

      const komponentenBedarf = await sql<{ id: string; issue_method: string }[]>`
        select id, issue_method::text from stock_moves
        where production_id = ${moId} and reference = 'Komponentenverbrauch'`
      const verbrauch: Record<string, number> = {}
      for (const k of komponentenBedarf) {
        if (k.issue_method === 'manual') {
          const [soll] = await sql<{ qty: number }[]>`select qty from stock_moves where id = ${k.id}`
          verbrauch[k.id] = Number(soll.qty)
        }
      }
      try {
        await sql`select mo_produce(${moId}, ${menge}, ${sql.json(verbrauch)}, true, 'demo')`
        fertigungen++
      } catch {
        // Materialmangel: der Auftrag bleibt offen stehen, das kommt vor
      }
    }

    // 3. Verkauf mit Auslieferung
    const anzahl = Math.max(1, Math.round(r.ganz(6, 12) * wachstum * saison))
    for (let i = 0; i < anzahl; i++) {
      const [so] = await sql<{ id: string }[]>`
        insert into sales_orders (number, partner_id, order_date)
        values (next_sequence('sale'), ${r.aus(kunden)}, now()) returning id`
      for (let j = 0; j < r.ganz(1, 3); j++) {
        const v = r.aus(varianten)
        await sql`
          insert into sales_order_lines (order_id, sequence, variant_id, name, qty, uom_id, price_unit, discount)
          select ${so.id}, ${(j + 1) * 10}, ${v.id}, ${v.name}, ${r.ganz(1, 4)}, ${uom.id},
                 pt.list_price + coalesce(pv.price_extra, 0), ${r.trifft(0.15) ? r.ganz(5, 15) : 0}
          from product_variants pv join product_templates pt on pt.id = pv.template_id
          where pv.id = ${v.id}`
      }
      let picking: string | null = null
      try {
        const [res] = await sql<{ confirm_sales_order: string | null }[]>`
          select confirm_sales_order(${so.id}, 'demo')`
        picking = res.confirm_sales_order
      } catch {
        continue
      }
      auftraege++

      // Die meisten Aufträge gehen raus; ein Rest bleibt offen
      if (picking && r.trifft(0.88)) {
        try {
          await sql`select picking_validate(${picking}, '{}'::jsonb, false)`
          // Gelegentlich kommt etwas zurück
          if (r.trifft(0.06)) {
            const [ret] = await sql<{ picking_return: string }[]>`select picking_return(${picking})`
            const [move] = await sql<{ id: string }[]>`
              select id from stock_moves where picking_id = ${ret.picking_return} limit 1`
            if (move) {
              await sql`select picking_validate(${ret.picking_return}, ${sql.json({ [move.id]: 1 })}, false)`
            }
          }
        } catch {
          // Bestand reichte nicht — der Auftrag bleibt in Lieferung offen
        }
      }
    }

    // 4. Reparaturen
    for (let i = 0; i < (r.trifft(0.55) ? r.ganz(1, 2) : 0); i++) {
      const v = r.aus(varianten)
      const [rep] = await sql<{ id: string }[]>`
        insert into repair_orders (number, partner_id, variant_id, qty, under_warranty, note)
        values (next_sequence('repair'), ${r.aus(kunden)}, ${v.id}, 1, ${r.trifft(0.6)},
                ${r.aus(['Taste klemmt', 'USB-Buchse wackelt', 'Beleuchtung teilweise aus',
                         'Gehäuse gerissen', 'Anschlagfehler bei mehreren Tasten'])})
        returning id`
      reparaturen++
      if (r.trifft(0.8)) {
        try {
          await sql`select repair_confirm(${rep.id}, 'demo')`
          await sql`select repair_start(${rep.id}, 'demo')`
          if (r.trifft(0.85)) await sql`select repair_end(${rep.id}, 'demo')`
        } catch {
          // Ohne Bestand für Ersatzteile bleibt die Reparatur offen
        }
      }
    }

    // 5. Anwesenheit: rund 20 Arbeitstage je Mitarbeiter
    for (const person of mitarbeiter) {
      for (let tag = 0; tag < 20; tag++) {
        const minuten = r.ganz(430, 500)
        await sql`
          insert into time_entries (employee_id, kind, started_at, ended_at, break_minutes,
                                    minutes, hourly_cost)
          select ${person.id}, 'attendance',
                 now() - make_interval(days => ${tag}, mins => ${minuten + 30}),
                 now() - make_interval(days => ${tag}),
                 30, ${minuten}, e.hourly_cost
          from employees e where e.id = ${person.id}`
      }
    }

    await verschiebe(sql, marker, tageZurueck)
  }

  // Was in der Zwischenzeit an Beständen entstanden ist, sauber bewerten
  await sql`select valuation_initialize(null, 'demo')`
  await sql`select refresh_analytics('demo')`

  bericht.push(
    `${MONATE} Monate Historie: ${auftraege} Verkaufsaufträge, ${bestellungen} Bestellungen, ` +
      `${fertigungen} Fertigungsaufträge, ${reparaturen} Reparaturen`,
  )
  return bericht
}
