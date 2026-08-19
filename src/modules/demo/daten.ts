import { randomBytes, scrypt as scryptCb } from 'node:crypto'
import { promisify } from 'node:util'
import type { Sql, TransactionSql } from 'postgres'
import { baueHistorie } from './historie.ts'

// Läuft auch innerhalb einer Transaktion (Tests mit Rollback) — postgres.js
// lässt TransactionSql nicht von Sql erben, daher die Union.
type Client = Sql | TransactionSql

/**
 * Die Demodaten als importierbares Modul — genutzt vom Seed-Skript
 * (`npm run db:seed -- --demo`) UND von der Registry-Aktion
 * `einstellungen.demodaten_einspielen` (Onboarding-Weiche „Demo-Modus").
 *
 * Bewusst OHNE 'server-only' und ohne '@/'-Importe: das Modul muss unter
 * blankem Node (Skript) genauso laufen wie im Next-Server. Der sql-Client
 * wird injiziert. Beispieldaten kommen NIE automatisch — nur über das
 * Skript-Flag oder die bewusste Admin-Aktion (Wächter:
 * tests/demodaten.test.ts).
 */

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

/** Gibt es schon Produkte? Dann sind Demodaten tabu (Idempotenz-Wächter). */
export async function demodatenMoeglich(sql: Client): Promise<boolean> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from product_templates`
  return count === 0
}

/**
 * Spielt die kompletten Beispieldaten ein und liefert die Zusammenfassung
 * als Zeilenliste. Wirft, wenn bereits Produkte existieren.
 */
export async function demodatenEinspielen(sql: Client): Promise<string[]> {
  if (!(await demodatenMoeglich(sql))) {
    throw new Error(
      'Es existieren bereits Produkte — Beispieldaten werden nicht in einen laufenden Datenbestand gemischt.',
    )
  }

  const passwort = process.env.SEED_ADMIN_PASSWORD ?? 'erp-admin'

  // --- Demo-Benutzer für die Rollen ----------------------------------------
  for (const [email, name, role] of [
    ['lager@example.com', 'Lena Lager', 'lager'],
    ['fertigung@example.com', 'Fred Fertigung', 'fertigung'],
  ]) {
    await sql`
      insert into users (email, name, password_hash, role)
      values (${email}, ${name}, ${await hashPassword(passwort)}, ${role}::user_role)
      on conflict (email) do nothing`
  }

  // --- Stammdaten -----------------------------------------------------------
  const [stueck] = await sql<{ id: string }[]>`select id from uoms where name = 'Stück'`
  const [dutzend] = await sql<{ id: string }[]>`select id from uoms where name = 'Dutzend'`

  const [vendor] = await sql<{ id: string }[]>`
    insert into partners (name, is_company, is_vendor, email, street, house_number, zip, city, country_code)
    values ('Komponenten Handels GmbH', true, true, 'bestellung@komponenten.example',
            'Industriestraße', '7', '90402', 'Nürnberg', 'DE')
    returning id`

  const [customer] = await sql<{ id: string }[]>`
    insert into partners (name, is_company, is_customer, email, street, house_number, zip, city, country_code)
    values ('Max Mustermann', false, true, 'max@example.com',
            'Musterweg', '12a', '10115', 'Berlin', 'DE')
    returning id`

  // --- Attribut Farbe -------------------------------------------------------
  const [farbe] = await sql<{ id: string }[]>`
    insert into product_attributes (name, display_type) values ('Farbe', 'color') returning id`
  const farbwerte = await sql<{ id: string; name: string }[]>`
    insert into product_attribute_values (attribute_id, name, html_color, sequence)
    values (${farbe.id}, 'Weiß', '#ffffff', 10),
           (${farbe.id}, 'Schwarz', '#1a1a1a', 20),
           (${farbe.id}, 'Blau', '#2f5fa8', 30)
    returning id, name`
  void farbwerte

  // --- Komponenten ----------------------------------------------------------
  interface Comp {
    name: string
    qty: number
    cost: number
    weight: number
    color?: string
    uom?: string
    stock: number
    manual?: boolean // muss bei der Fertigmeldung erfasst werden
    packaging?: boolean // gehört ins Verpackungsset (Phantom-Baugruppe)
  }

  const components: Comp[] = [
    { name: 'Gehäuse weiß', qty: 1, cost: 18.5, weight: 420, color: 'Weiß', stock: 40 },
    { name: 'Gehäuse schwarz', qty: 1, cost: 18.5, weight: 420, color: 'Schwarz', stock: 35 },
    { name: 'Gehäuse blau', qty: 1, cost: 19.9, weight: 420, color: 'Blau', stock: 20 },
    { name: 'Keycap-Set weiß', qty: 1, cost: 24.0, weight: 180, color: 'Weiß', stock: 30 },
    { name: 'Keycap-Set schwarz', qty: 1, cost: 24.0, weight: 180, color: 'Schwarz', stock: 28 },
    { name: 'Keycap-Set blau', qty: 1, cost: 26.0, weight: 180, color: 'Blau', stock: 15 },
    { name: 'PCB Hauptplatine', qty: 1, cost: 32.0, weight: 90, stock: 60, manual: true },
    { name: 'Controller MCU', qty: 1, cost: 6.4, weight: 3, stock: 120 },
    { name: 'Mechanischer Switch', qty: 87, cost: 0.35, weight: 4, uom: 'Stück', stock: 9000 },
    { name: 'Stabilisator-Set', qty: 1, cost: 8.9, weight: 25, stock: 80 },
    { name: 'Schaumstoff-Dämmung', qty: 1, cost: 3.2, weight: 40, stock: 90 },
    { name: 'Stahlplatte', qty: 1, cost: 14.0, weight: 350, stock: 50 },
    { name: 'Schraube M2x6', qty: 12, cost: 0.04, weight: 1, stock: 4000 },
    { name: 'Gummifuß', qty: 4, cost: 0.12, weight: 2, stock: 900 },
    { name: 'USB-C-Kabel', qty: 1, cost: 4.5, weight: 60, stock: 150 },
    { name: 'Daughterboard USB-C', qty: 1, cost: 3.8, weight: 8, stock: 140 },
    { name: 'Flachbandkabel', qty: 1, cost: 1.1, weight: 5, stock: 200 },
    { name: 'Dämpfungsband', qty: 1, cost: 2.4, weight: 15, stock: 110 },
    { name: 'Verpackungskarton', qty: 1, cost: 1.8, weight: 220, stock: 250, packaging: true },
    { name: 'Handbuch', qty: 1, cost: 0.35, weight: 30, stock: 300, packaging: true },
  ]

  const compIds = new Map<string, string>()
  for (const c of components) {
    const [tpl] = await sql<{ id: string }[]>`
      insert into product_templates (
        name, uom_id, purchase_uom_id, standard_cost, weight_g, can_be_sold,
        can_be_purchased, route_buy)
      values (${c.name}, ${stueck.id}, ${c.name === 'Schraube M2x6' ? dutzend.id : stueck.id},
              ${c.cost}, ${c.weight}, false, true, true)
      returning id`
    await sql`select generate_variants(${tpl.id})`
    const [variant] = await sql<{ id: string }[]>`
      select id from product_variants where template_id = ${tpl.id} limit 1`
    await sql`update product_variants
              set sku = ${'K-' + String(compIds.size + 1).padStart(3, '0')},
                  barcode = ${'4260' + String(compIds.size + 1).padStart(9, '0')}
              where id = ${variant.id}`
    compIds.set(c.name, variant.id)

    await sql`
      insert into vendor_prices (vendor_id, template_id, price, lead_time_days, min_qty)
      values (${vendor.id}, ${tpl.id}, ${c.cost}, 7, 0)`

    // Anfangsbestand über eine Inventurbuchung (der saubere Weg).
    const [loc] = await sql<{ id: string }[]>`
      select id from stock_locations where full_path = 'WH/Stock'`
    const [countRow] = await sql<{ id: string }[]>`
      insert into inventory_counts (location_id, variant_id, counted_qty, book_qty)
      values (${loc.id}, ${variant.id}, ${c.stock}, 0) returning id`
    await sql`select inventory_apply(${countRow.id}, 'seed')`
  }

  // --- Endprodukt Tastatur --------------------------------------------------
  const [keyboard] = await sql<{ id: string }[]>`
    insert into product_templates (
      name, uom_id, list_price, standard_cost, weight_g, can_be_sold,
      route_manufacture, route_mto, invoice_policy)
    -- Verkaufspreis mit Abstand zu den Herstellkosten, und die Plankosten
    -- gepflegt: ohne sie startet der gleitende Durchschnitt bei 0 und die
    -- ersten Monate zeigen erst eine Traummarge und dann einen Verlust.
    values ('Tastatur Modell One', ${stueck.id}, 329.0, 190.0, 1200, true, true, true, 'order')
    returning id`

  const [line] = await sql<{ id: string }[]>`
    insert into product_template_attribute_lines (template_id, attribute_id)
    values (${keyboard.id}, ${farbe.id}) returning id`

  const ptavs = await sql<{ id: string; value_name: string }[]>`
    insert into product_template_attribute_values (line_id, value_id, price_extra)
    select ${line.id}, id, case when name = 'Blau' then 10 else 0 end
    from product_attribute_values where attribute_id = ${farbe.id}
    returning id, (select name from product_attribute_values v where v.id = value_id) as value_name`

  await sql`select generate_variants(${keyboard.id})`

  const variants = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from product_variants where template_id = ${keyboard.id} order by display_name`
  for (const [index, v] of variants.entries()) {
    await sql`update product_variants
              set sku = ${'TAST-' + (v.display_name.includes('Weiß') ? 'W' : v.display_name.includes('Schwarz') ? 'S' : 'B')},
                  barcode = ${'42000000000' + String(index + 1).padStart(2, '0')}
              where id = ${v.id}`
  }

  // --- Stückliste mit variantenabhängigen Positionen ------------------------
  const [bom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id, consumption)
    values (${keyboard.id}, 1, ${stueck.id}, 'warning') returning id`

  let sequence = 10
  for (const c of components) {
    // Verpackungsteile stecken in der Baugruppe weiter unten.
    if (c.packaging) continue
    const [bomLine] = await sql<{ id: string }[]>`
      insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
      values (${bom.id}, ${sequence}, ${compIds.get(c.name) ?? ''}, ${c.qty}, ${stueck.id},
              ${c.manual ? 'manual' : 'backflush'}::component_issue_method)
      returning id`
    sequence += 10

    // Das ist der Kern: farbabhängige Positionen nur für die passende Variante.
    if (c.color) {
      const ptav = ptavs.find((p) => p.value_name === c.color)
      if (ptav) {
        await sql`insert into bom_line_variant_filters (bom_line_id, ptav_id)
                  values (${bomLine.id}, ${ptav.id})`
      }
    }
  }

  // --- Phantom-Baugruppe "Verpackungsset" -----------------------------------
  // Das Set liegt nie im Regal: In Fertigungsaufträgen und Lieferungen
  // treten immer Karton und Handbuch an seine Stelle.
  const [setTpl] = await sql<{ id: string }[]>`
    insert into product_templates (name, uom_id, weight_g, can_be_sold, can_be_purchased)
    values ('Verpackungsset', ${stueck.id}, 250, false, false)
    returning id`
  await sql`select generate_variants(${setTpl.id})`
  const [setVariant] = await sql<{ id: string }[]>`
    select id from product_variants where template_id = ${setTpl.id} limit 1`
  await sql`update product_variants set sku = 'K-SET-VP' where id = ${setVariant.id}`

  const [setBom] = await sql<{ id: string }[]>`
    insert into boms (template_id, qty, uom_id, bom_type)
    values (${setTpl.id}, 1, ${stueck.id}, 'kit') returning id`
  for (const c of components.filter((x) => x.packaging)) {
    await sql`
      insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
      values (${setBom.id}, ${sequence}, ${compIds.get(c.name) ?? ''}, ${c.qty}, ${stueck.id})`
    sequence += 10
  }
  await sql`
    insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id)
    values (${bom.id}, ${sequence}, ${setVariant.id}, 1, ${stueck.id})`

  // --- Arbeitsplätze und Arbeitsgänge ---------------------------------------
  const workCenters = [
    { code: 'LOETEN', name: 'Lötplatz', rate: 55 },
    { code: 'MONTAGE', name: 'Montagetisch', rate: 45 },
    { code: 'PRUEFUNG', name: 'Prüfplatz', rate: 38 },
  ]
  const wcIds = new Map<string, string>()
  for (const w of workCenters) {
    const [row] = await sql<{ id: string }[]>`
      insert into work_centers (code, name, cost_per_hour)
      values (${w.code}, ${w.name}, ${w.rate}) returning id`
    wcIds.set(w.code, row.id)
  }

  const operations = [
    { seq: 10, name: 'Switches löten', wc: 'LOETEN', minutes: 18, setup: 10 },
    { seq: 20, name: 'Gehäuse montieren', wc: 'MONTAGE', minutes: 25, setup: 5 },
    { seq: 30, name: 'Endprüfung und Verpacken', wc: 'PRUEFUNG', minutes: 9, setup: 0 },
  ]
  for (const o of operations) {
    await sql`
      insert into bom_operations (bom_id, sequence, name, work_center_id,
                                  duration_minutes, setup_minutes)
      values (${bom.id}, ${o.seq}, ${o.name}, ${wcIds.get(o.wc) ?? ''}, ${o.minutes}, ${o.setup})`
  }

  // --- Personal -------------------------------------------------------------
  const team = [
    { name: 'Fred Fertigung', job: 'Montage', dept: 'Fertigung', cost: 38.5, badge: 'MA-001', login: 'fertigung@example.com' },
    { name: 'Lena Lager', job: 'Wareneingang', dept: 'Lager', cost: 35.0, badge: 'MA-002', login: 'lager@example.com' },
    { name: 'Tom Löter', job: 'Löten und Prüfen', dept: 'Fertigung', cost: 41.0, badge: 'MA-003', login: null },
  ]
  for (const m of team) {
    const [u] = m.login
      ? await sql<{ id: string }[]>`select id from users where email = ${m.login}`
      : [undefined]
    await sql`
      insert into employees (number, name, user_id, barcode, job_title, department,
                             hourly_cost, weekly_hours, hire_date)
      values (next_sequence('employee'), ${m.name}, ${u?.id ?? null}, ${m.badge},
              ${m.job}, ${m.dept}, ${m.cost}, 40, current_date - 400)`
  }

  // --- Beispielauftrag ------------------------------------------------------
  const weiss = variants.find((v) => v.display_name.includes('Weiß'))!
  const [order] = await sql<{ id: string }[]>`
    insert into sales_orders (
      number, partner_id, ship_name, ship_street, ship_house_number,
      ship_zip, ship_city, ship_country_code, ship_email)
    values (next_sequence('sale'), ${customer.id}, 'Max Mustermann', 'Musterweg', '12a',
            '10115', 'Berlin', 'DE', 'max@example.com')
    returning id`
  await sql`
    insert into sales_order_lines (order_id, variant_id, name, qty, uom_id, price_unit)
    values (${order.id}, ${weiss.id}, 'Tastatur Modell One (Farbe: Weiß)', 2, ${stueck.id}, 189)`

  await sql`update settings set value = ${sql.json({
    name: 'Meine Tastatur GmbH',
    street: 'Werkstraße',
    house: '3',
    zip: '90402',
    city: 'Nürnberg',
    country: 'DEU',
    email: 'info@example.com',
    phone: '+49 911 1234567',
  })} where key = 'company'`

  // Anfangsbestand bewerten, damit Bestandswert und Marge von Beginn an stimmen.
  await sql`select valuation_initialize(null, 'seed')`

  // Betriebshistorie: ohne sie zeigen alle Verlaufsauswertungen einen
  // einzigen Balken. Läuft über die echten Buchungsfunktionen.
  const historie = await baueHistorie(sql)

  // --- Finanzen: Konten, Verträge, Zahlplan, Darlehen, Steuern, Plan --------
  // Alles über die echten SQL-Funktionen, damit das Cockpit ab dem ersten
  // Login ein vollständiges Bild zeigt (Saldo, Band, Fremdkapitalbedarf).
  const [konto] = await sql<{ id: string }[]>`
    insert into bankkonten (name, iban, waehrung)
    values ('Geschäftskonto Sparkasse', 'DE89 7605 0101 0000 1234 56', 'EUR') returning id`
  const [tagesgeld] = await sql<{ id: string }[]>`
    insert into bankkonten (name, waehrung)
    values ('Tagesgeld-Rücklage', 'EUR') returning id`
  await sql`insert into kontostaende (bankkonto_id, stichtag, saldo, notiz, erfasst_von)
            values (${konto.id}, current_date - 25, 84200, 'Anker aus Kontoauszug', 'seed'),
                   (${tagesgeld.id}, current_date - 25, 40000, 'Rücklage', 'seed')`

  // Fixkosten als Verträge — Miete/Lizenzen/Personal, mit echten Fristen.
  const vertraege: {
    name: string; kategorie: string; betrag: number; zahltag: number
    beginnMonate: number; laufzeit: number | null; frist: number
  }[] = [
    { name: 'Miete Lager & Büro Werkstraße', kategorie: 'miete', betrag: 2400, zahltag: 1, beginnMonate: 14, laufzeit: 36, frist: 3 },
    { name: 'Sendcloud Versandlizenz', kategorie: 'lizenzen', betrag: 89, zahltag: 15, beginnMonate: 8, laufzeit: 12, frist: 1 },
    { name: 'Replo Addon (Shopify-Storefront)', kategorie: 'lizenzen', betrag: 49, zahltag: 15, beginnMonate: 6, laufzeit: null, frist: 0 },
    { name: 'Gehälter Team', kategorie: 'personal', betrag: 14500, zahltag: 28, beginnMonate: 14, laufzeit: null, frist: 0 },
    { name: 'Aushilfen (Minijobs)', kategorie: 'personal', betrag: 1560, zahltag: 28, beginnMonate: 5, laufzeit: null, frist: 0 },
  ]
  for (const v of vertraege) {
    await sql`
      insert into vertraege (nummer, name, kategorie, betrag, intervall, zahltag,
                             beginn, laufzeit_monate, kuendigungsfrist_monate, status)
      values (next_sequence('vertrag'), ${v.name}, ${v.kategorie}, ${v.betrag}, 'monatlich',
              ${v.zahltag}, (date_trunc('month', current_date) - (${v.beginnMonate} || ' months')::interval)::date,
              ${v.laufzeit}, ${v.frist}, 'aktiv')`
  }

  // Offene Containerbestellung mit 30/70-Zahlplan: die Anzahlung ist raus,
  // der Rest hängt an der Verschiffung (ETA bestätigt, Transit aus settings).
  const [containerPo] = await sql<{ id: string }[]>`
    insert into purchase_orders (number, vendor_id, eta_confirmed)
    values (next_sequence('purchase'), ${vendor.id}, current_date + 40) returning id`
  await sql`
    insert into purchase_order_lines (order_id, variant_id, name, qty, uom_id, price_unit, tax_rate)
    values (${containerPo.id}, ${compIds.get('Gehäuse schwarz') ?? ''}, 'Gehäuse schwarz (Container)', 400, ${stueck.id}, 16.9, 0),
           (${containerPo.id}, ${compIds.get('Keycap-Set schwarz') ?? ''}, 'Keycap-Set schwarz (Container)', 400, ${stueck.id}, 21.5, 0)`
  await sql`select confirm_purchase_order(${containerPo.id}, 'seed')`
  const [anzahlung] = await sql<{ id: string }[]>`
    insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
    values (${containerPo.id}, 10, 'Anzahlung 30 %', 30, 'bestellung') returning id`
  await sql`
    insert into zahlplan_raten (purchase_order_id, sequence, bezeichnung, anteil_pct, ausloeser)
    values (${containerPo.id}, 20, 'Rest bei Verschiffung', 70, 'verschiffung')`
  await sql`
    select zahlung_erfassen('aus', (select zahlplan_betrag(r) from zahlplan_raten r where r.id = ${anzahlung.id}),
                            'EUR', current_date - 20, ${konto.id}, 'po_rate', ${anzahlung.id},
                            'Anzahlung Containerbestellung', 'seed')`

  // Annuitätendarlehen, seit drei Monaten laufend — die ersten Raten sind
  // bezahlt, der Rest steht im Tilgungsplan und in der Prognose.
  const [darlehen] = await sql<{ id: string }[]>`
    insert into darlehen (nummer, name, betrag, zinssatz_pct, art, auszahlung_am,
                          laufzeit_monate, zahltag, bankkonto_id)
    values (next_sequence('darlehen'), 'Betriebsmitteldarlehen Hausbank', 90000, 6.5,
            'annuitaet', current_date - 100, 48, 1, ${konto.id}) returning id`
  await sql`select darlehen_auszahlen(${darlehen.id}, current_date - 100, 'seed')`
  const faelligeRaten = await sql<{ id: string; faellig_am: string }[]>`
    select id, faellig_am::text from darlehen_raten
    where darlehen_id = ${darlehen.id} and faellig_am < current_date order by nr`
  for (const rate of faelligeRaten) {
    await sql`select darlehen_rate_zahlen(${rate.id}, ${rate.faellig_am}, ${konto.id}, 'seed')`
  }

  // Steuern: USt-Vorschlag für den Vormonat + Umsatzplan über den Tageslauf
  // (idempotent), dazu eine manuelle GewSt-Vorauszahlung als Termin.
  await sql`select finanz_tageslauf('seed')`
  await sql`
    insert into steuerzahlungen (art, zeitraum_von, zeitraum_bis, bezeichnung, betrag, faellig_am)
    values ('gewst', date_trunc('quarter', current_date)::date,
            (date_trunc('quarter', current_date) + interval '3 months')::date - 1,
            'GewSt-Vorauszahlung', 1850,
            (date_trunc('month', current_date) + interval '2 months')::date + 14)`

  return [
    '20 Komponenten mit Anfangsbestand, Barcodes und Lieferantenpreisen',
    'Tastatur mit 3 Farbvarianten',
    'Stückliste mit 19 Positionen, davon 6 farbabhängig gefiltert',
    'Phantom-Baugruppe "Verpackungsset" (Karton + Handbuch), die beim Fertigen aufgelöst wird',
    '3 Arbeitsplätze mit Stundensatz und 3 Arbeitsgänge (52 Min. je Tastatur)',
    '3 Mitarbeiter mit Ausweis-Barcode (MA-001 bis MA-003) und Personalkostensatz',
    'Ein Angebot über 2 weiße Tastaturen (noch nicht bestätigt)',
    'Demo-Benutzer lager@example.com und fertigung@example.com (Passwort wie Admin-Seed)',
    'Anfangsbestand zum Einstandspreis bewertet',
    'Finanzen: 2 Bankkonten mit Anker, 5 Fixkosten-Verträge, Containerbestellung mit 30/70-Zahlplan (Anzahlung bezahlt), Annuitätendarlehen (90.000 €, läuft), USt-Vorschlag + GewSt-Termin, Umsatzplan gefüllt',
    ...historie,
  ]
}
