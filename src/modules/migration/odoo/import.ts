/**
 * Die Phasen der Odoo-Übernahme: liest die Staging-DB (quelle.ts), formt um
 * (mapper.ts) und schreibt die Ziel-KRNL-DB — idempotent über den
 * Mapping-Anker `odoo_verweise` (0073): jeder Lauf ist ein Upsert, ein
 * zweiter Lauf mit demselben Dump ist ein No-Op.
 *
 * Bauform wie src/modules/demo/daten.ts: kein 'server-only', keine
 * `@/`-Importe, beide sql-Clients werden injiziert — damit läuft dasselbe
 * Modul als CLI (scripts/odoo-import.ts), im Dry-Run (Transaktion +
 * Rollback) und im Test.
 *
 * Grundsatz aus dem Entscheidungslog 2026-08-25: Bestand und Wert werden
 * NIE direkt geschrieben — Phase 5/6 laufen über inventory_apply() und
 * valuation_initialize(). Die Phasen hier (0–2) sind reine Stammdaten.
 */

import type { Sql, TransactionSql } from 'postgres'
import { splitStreet } from '../../shared/address.ts'
import {
  attributAnzeige,
  bestellGid,
  billBezahlt,
  billState,
  billingStatus,
  bomTyp,
  bomVerbrauch,
  faelligkeitsTyp,
  firmenwert,
  htmlZuText,
  invoiceStatus,
  istShopifyRef,
  kgZuGramm,
  kundenGid,
  moState,
  nameTeilen,
  purchaseState,
  repairState,
  saleState,
  uebersetzung,
  uomRatio,
  variantenSchluessel,
} from './mapper.ts'
import * as quelle from './quelle.ts'

export type Ziel = Sql | TransactionSql

export interface Lauf {
  quelle: quelle.OdooSql
  ziel: Ziel
  /** Label des Importlaufs — landet in odoo_verweise.lauf ('probe-1', Stichtag). */
  label: string
  warnungen: string[]
  meldung: (text: string) => void
}

// --- Mapping-Anker ----------------------------------------------------------

/** Alle bekannten Zuordnungen einer Odoo-Tabelle: odoo_id → krnl_id. */
export async function verweisKarte(ziel: Ziel, odooTabelle: string): Promise<Map<number, string>> {
  const zeilen = await ziel<{ odoo_id: number; krnl_id: string }[]>`
    select odoo_id, krnl_id from odoo_verweise where odoo_tabelle = ${odooTabelle}`
  return new Map(zeilen.map((z) => [Number(z.odoo_id), z.krnl_id]))
}

async function merken(
  lauf: Lauf,
  odooTabelle: string,
  odooId: number,
  krnlTabelle: string,
  krnlId: string,
): Promise<void> {
  await lauf.ziel`
    insert into odoo_verweise (odoo_tabelle, odoo_id, krnl_tabelle, krnl_id, lauf)
    values (${odooTabelle}, ${odooId}, ${krnlTabelle}, ${krnlId}, ${lauf.label})
    on conflict (odoo_tabelle, odoo_id) do update set krnl_id = excluded.krnl_id`
}

function warnen(lauf: Lauf, text: string): void {
  lauf.warnungen.push(text)
}

// --- Phase 0: Vorbedingungen ------------------------------------------------

/**
 * Wächter vor jedem Lauf: Die Staging-DB muss vollständig geladen sein, die
 * Studio-BoM-Experimente leer, und die Ziel-DB darf keine FREMDEN Produkte
 * tragen (Analogie demodatenMoeglich() — Odoo-Daten werden nicht in einen
 * gewachsenen Bestand gemischt; eigene frühere Läufe sind über den Anker
 * erkannt und in Ordnung).
 */
export async function phaseVorbedingung(lauf: Lauf): Promise<void> {
  const zahlen = await quelle.kernzahlen(lauf.quelle)
  for (const [tabelle, anzahl] of Object.entries(zahlen)) {
    if (anzahl === 0 && tabelle !== 'repair_order') {
      throw new Error(`Staging-DB unvollständig: ${tabelle} ist leer — Dump neu laden.`)
    }
  }
  lauf.meldung(
    `Quelle: ${zahlen.res_partner} Partner, ${zahlen.product_product} Varianten, ` +
      `${zahlen.sale_order} Verkaufsaufträge, ${zahlen.mrp_production} Fertigungen.`,
  )

  const studioZeilen = await quelle.studioBomRelZeilen(lauf.quelle)
  if (studioZeilen > 0) {
    throw new Error(
      `Die Studio-BoM-Zuordnungstabellen (x_mrp_bom_*) tragen ${studioZeilen} Zeilen — ` +
        'das Mapping kennt sie nicht. Bitte prüfen, was ANVIL dort gebaut hat.',
    )
  }

  const [fremd] = await lauf.ziel<{ anzahl: number }[]>`
    select count(*)::int as anzahl from product_templates t
    where not exists (select 1 from odoo_verweise v
                      where v.krnl_tabelle = 'product_templates' and v.krnl_id = t.id)`
  if (fremd.anzahl > 0) {
    throw new Error(
      `Die Ziel-DB trägt ${fremd.anzahl} Produkte ohne Odoo-Herkunft — Odoo-Daten werden ` +
        'nicht in einen gewachsenen Bestand gemischt. Ziel leerräumen (werkszustand/' +
        'demodaten_loeschen) oder frisch migrieren.',
    )
  }

  // Firmendaten aus res_company — die Instanz gehört ab jetzt ANVIL.
  const firma = await quelle.firma(lauf.quelle)
  if (firma) {
    const adresse = splitStreet(firma.street)
    await lauf.ziel`
      update settings set value = value || ${lauf.ziel.json({
        name: firma.name,
        street: adresse.street,
        house: adresse.houseNumber,
        zip: firma.zip ?? '',
        city: firma.city ?? '',
        country: firma.country_code === 'DE' ? 'DEU' : (firma.country_code ?? 'DEU'),
        email: firma.email ?? '',
        phone: firma.phone ?? '',
        vat: firma.vat ?? '',
      })} where key = 'company'`
    lauf.meldung(`Firmendaten gesetzt: ${firma.name}.`)
  }
}

// --- Phase 1: Stammdaten ----------------------------------------------------

/**
 * Einheiten-Matching: Odoo-Einheiten werden möglichst auf die
 * KRNL-Seed-Einheiten gelegt (ANVILs Eigen-Referenz „Einheiten" UND die
 * deaktivierte Odoo-Standard-Referenz „Einheit(en)" landen beide auf
 * `Stück`). Nur was kein Gegenstück hat, wird angelegt — mit
 * ratio = KRNL-ratio der Odoo-Referenz / Odoo-factor (die Referenzen
 * weichen ab: KRNL wiegt in g, Odoo in kg).
 */
const UOM_SYNONYME: Record<string, string> = {
  'einheit(en)': 'Stück',
  einheiten: 'Stück',
  units: 'Stück',
  stück: 'Stück',
  dutzende: 'Dutzend',
  dozens: 'Dutzend',
  dutzend: 'Dutzend',
  hunderte: 'Hundert',
  hundreds: 'Hundert',
  hundert: 'Hundert',
  g: 'g',
  gramm: 'g',
  kg: 'kg',
  mm: 'mm',
  m: 'm',
}

export async function phaseStammdaten(lauf: Lauf): Promise<void> {
  const { ziel } = lauf

  // -- Einheiten -------------------------------------------------------------
  const krnlUoms = await ziel<
    { id: string; name: string; ratio: number; is_reference: boolean; category_id: string; kategorie: string }[]
  >`
    select u.id, u.name, u.ratio, u.is_reference, u.category_id, c.name as kategorie
    from uoms u join uom_categories c on c.id = u.category_id`
  const krnlNachName = new Map(krnlUoms.map((u) => [u.name.toLowerCase(), u]))

  const odooKategorien = await quelle.uomKategorien(lauf.quelle)
  const odooUoms = await quelle.uoms(lauf.quelle)
  const uomKarte = new Map<number, string>()

  // Referenz je Odoo-Kategorie — sie bestimmt Ziel-Kategorie und ratio-Basis.
  const referenzJeKategorie = new Map(
    odooUoms.filter((u) => u.uom_type === 'reference').map((u) => [u.category_id, u]),
  )

  for (const odooUom of odooUoms) {
    const name = uebersetzung(odooUom.name, `Odoo-${odooUom.id}`)
    const match = krnlNachName.get((UOM_SYNONYME[name.toLowerCase()] ?? name).toLowerCase())
    if (match) {
      uomKarte.set(odooUom.id, match.id)
      await merken(lauf, 'uom_uom', odooUom.id, 'uoms', match.id)
      continue
    }

    // Kein Seed-Gegenstück: Kategorie über die Odoo-Referenz finden.
    const referenz = referenzJeKategorie.get(odooUom.category_id)
    const referenzName = referenz ? uebersetzung(referenz.name, '') : ''
    const referenzMatch = referenz
      ? krnlNachName.get((UOM_SYNONYME[referenzName.toLowerCase()] ?? referenzName).toLowerCase())
      : undefined

    let kategorieId: string
    let referenzRatio: number
    if (referenzMatch) {
      kategorieId = referenzMatch.category_id
      referenzRatio = Number(referenzMatch.ratio)
    } else {
      // Ganze Kategorie ist neu (z. B. Arbeitszeit): anlegen, Referenz zuerst.
      const kategorieName = uebersetzung(
        odooKategorien.find((k) => k.id === odooUom.category_id)?.name,
        `Odoo-Kategorie ${odooUom.category_id}`,
      )
      const [kategorie] = await ziel<{ id: string }[]>`
        insert into uom_categories (name) values (${kategorieName})
        on conflict (name) do update set name = excluded.name
        returning id`
      kategorieId = kategorie.id
      referenzRatio = 1
      if (referenz && referenz.id !== odooUom.id) {
        const [neueReferenz] = await ziel<{ id: string }[]>`
          insert into uoms (category_id, name, ratio, is_reference, rounding)
          values (${kategorieId}, ${uebersetzung(referenz.name, `Odoo-${referenz.id}`)}, 1, true, 0.01)
          on conflict (category_id, name) do update set ratio = excluded.ratio
          returning id`
        uomKarte.set(referenz.id, neueReferenz.id)
        krnlNachName.set(uebersetzung(referenz.name, '').toLowerCase(), {
          id: neueReferenz.id,
          name: uebersetzung(referenz.name, ''),
          ratio: 1,
          is_reference: true,
          category_id: kategorieId,
          kategorie: kategorieName,
        })
        await merken(lauf, 'uom_uom', referenz.id, 'uoms', neueReferenz.id)
        if (referenz.id === odooUom.id) continue
      }
    }

    if (uomKarte.has(odooUom.id)) continue
    const istNeueReferenz = !referenzMatch && odooUom.uom_type === 'reference'
    const ratio = istNeueReferenz ? 1 : uomRatio(odooUom.factor, referenzRatio)
    const [neu] = await ziel<{ id: string }[]>`
      insert into uoms (category_id, name, ratio, is_reference, rounding, active)
      values (${kategorieId}, ${name}, ${ratio}, ${istNeueReferenz}, 0.01, ${odooUom.active})
      on conflict (category_id, name) do update set ratio = excluded.ratio
      returning id`
    uomKarte.set(odooUom.id, neu.id)
    krnlNachName.set(name.toLowerCase(), {
      id: neu.id,
      name,
      ratio,
      is_reference: istNeueReferenz,
      category_id: kategorieId,
      kategorie: '',
    })
    await merken(lauf, 'uom_uom', odooUom.id, 'uoms', neu.id)
  }
  lauf.meldung(`Einheiten: ${odooUoms.length} Odoo-Einheiten zugeordnet.`)

  // -- Steuern ---------------------------------------------------------------
  const steuern = await quelle.genutzteSteuern(lauf.quelle)
  for (const steuer of steuern) {
    const name = uebersetzung(steuer.name, `Odoo-Steuer ${steuer.id}`)
    const [zeile] = await ziel<{ id: string }[]>`
      insert into taxes (name, amount, amount_type, type_tax_use, price_include, description)
      values (${name}, ${steuer.amount},
              ${steuer.amount_type === 'fixed' ? 'fixed' : 'percent'},
              ${steuer.type_tax_use === 'purchase' ? 'purchase' : 'sale'},
              ${steuer.price_include}, ${uebersetzung(steuer.description, '') || null})
      on conflict (name) do update set amount = excluded.amount
      returning id`
    await merken(lauf, 'account_tax', steuer.id, 'taxes', zeile.id)
  }
  lauf.meldung(`Steuern: ${steuern.length} genutzte übernommen.`)

  // -- Zahlungsbedingungen -----------------------------------------------------
  const bedingungen = await quelle.zahlungsbedingungen(lauf.quelle)
  const bedingungsKarte = await verweisKarte(ziel, 'account_payment_term')
  for (const bedingung of bedingungen) {
    const name = uebersetzung(bedingung.name, `Odoo-Zahlungsbedingung ${bedingung.id}`)
    if (bedingung.zeilen > 1) {
      warnen(lauf, `Zahlungsbedingung „${name}" hat ${bedingung.zeilen} Raten — übernommen wird die längste Frist.`)
    }
    const werte = {
      nb_days: bedingung.nb_days,
      delay_type: faelligkeitsTyp(bedingung.delay_type),
      early_discount: bedingung.early_discount === true,
      discount_percentage: bedingung.discount_percentage,
      discount_days: bedingung.discount_days,
      active: bedingung.active,
    }
    const vorhandene = bedingungsKarte.get(bedingung.id)
    let id: string
    if (vorhandene) {
      await ziel`update payment_terms set name = ${name}, nb_days = ${werte.nb_days},
        delay_type = ${werte.delay_type}, early_discount = ${werte.early_discount},
        discount_percentage = ${werte.discount_percentage}, discount_days = ${werte.discount_days},
        active = ${werte.active} where id = ${vorhandene}`
      id = vorhandene
    } else {
      // Namens-Match auf einen etwaigen Seed („30 Tage") vor dem Anlegen.
      const [zeile] = await ziel<{ id: string }[]>`
        select id from payment_terms where lower(name) = ${name.toLowerCase()}`
      if (zeile) {
        id = zeile.id
      } else {
        const [neu] = await ziel<{ id: string }[]>`
          insert into payment_terms (name, nb_days, delay_type, early_discount,
                                     discount_percentage, discount_days, active)
          values (${name}, ${werte.nb_days}, ${werte.delay_type}, ${werte.early_discount},
                  ${werte.discount_percentage}, ${werte.discount_days}, ${werte.active})
          returning id`
        id = neu.id
      }
    }
    await merken(lauf, 'account_payment_term', bedingung.id, 'payment_terms', id)
  }
  lauf.meldung(`Zahlungsbedingungen: ${bedingungen.length} übernommen.`)

  // -- Produktkategorien -------------------------------------------------------
  const kategorien = await quelle.produktKategorien(lauf.quelle)
  const kategorieKarte = new Map<number, string>()
  const [wurzel] = await ziel<{ id: string }[]>`
    select id from product_categories where parent_id is null order by created_at limit 1`
  // Iterativ, bis alle Eltern aufgelöst sind (5 Zeilen — zwei Runden genügen).
  let offen = [...kategorien]
  while (offen.length > 0) {
    const rest: typeof offen = []
    for (const kategorie of offen) {
      const name = uebersetzung(kategorie.name, `Odoo-Kategorie ${kategorie.id}`)
      if (kategorie.parent_id === null) {
        // Die Odoo-Wurzel („All"/„Alle") IST die KRNL-Wurzel.
        kategorieKarte.set(kategorie.id, wurzel.id)
        await merken(lauf, 'product_category', kategorie.id, 'product_categories', wurzel.id)
        continue
      }
      const eltern = kategorieKarte.get(kategorie.parent_id)
      if (!eltern) {
        rest.push(kategorie)
        continue
      }
      const [zeile] = await ziel<{ id: string }[]>`
        insert into product_categories (name, parent_id)
        values (${name}, ${eltern})
        on conflict do nothing
        returning id`
      const id =
        zeile?.id ??
        (
          await ziel<{ id: string }[]>`
            select id from product_categories where name = ${name} and parent_id = ${eltern}`
        )[0].id
      kategorieKarte.set(kategorie.id, id)
      await merken(lauf, 'product_category', kategorie.id, 'product_categories', id)
    }
    if (rest.length === offen.length) {
      throw new Error(`Produktkategorien mit unauflösbaren Eltern: ${rest.map((k) => k.id).join(', ')}`)
    }
    offen = rest
  }
  lauf.meldung(`Kategorien: ${kategorien.length} übernommen.`)

  // -- Partner ----------------------------------------------------------------
  const partner = await quelle.partner(lauf.quelle)
  const partnerKarte = await verweisKarte(ziel, 'res_partner')
  const paymentKarte = await verweisKarte(ziel, 'account_payment_term')

  // Doppelte Shopify-IDs in der Quelle (der Odoo-Connector hat Kunden
  // mehrfach angelegt): die Spalte ist unique — die Verknüpfung bekommt der
  // aktive bzw. jüngste Partner, deterministisch, damit auch der
  // Wiederholungslauf denselben wählt.
  const partnerNachId = new Map(partner.map((p) => [p.id, p]))
  const gidBesitzer = new Map<string, number>()
  let gidDoppelt = 0
  for (const p of partner) {
    if (!p.shopify_customer_id) continue
    const bisherId = gidBesitzer.get(p.shopify_customer_id)
    if (bisherId === undefined) {
      gidBesitzer.set(p.shopify_customer_id, p.id)
      continue
    }
    gidDoppelt++
    const bisher = partnerNachId.get(bisherId)
    const gewinnt =
      bisher === undefined ||
      (p.active && !bisher.active) ||
      (p.active === bisher.active && p.id > bisherId)
    if (gewinnt) gidBesitzer.set(p.shopify_customer_id, p.id)
  }
  if (gidDoppelt > 0) {
    warnen(
      lauf,
      `${gidDoppelt} Shopify-Kunden hängen an mehreren Odoo-Partnern — die Verknüpfung bekommt jeweils der aktive bzw. jüngste.`,
    )
  }

  for (const p of partner) {
    const adresse = splitStreet(p.street)
    const namen = nameTeilen(p.name, p.vorname)
    const shopifyGid =
      p.shopify_customer_id && gidBesitzer.get(p.shopify_customer_id) === p.id
        ? kundenGid(p.shopify_customer_id)
        : null
    const werte = {
      name: p.name.trim() || `Odoo-Partner ${p.id}`,
      is_company: p.is_company,
      is_customer: p.ist_kunde,
      is_vendor: p.ist_lieferant,
      email: p.email,
      phone: p.phone,
      mobile: p.mobile,
      website: p.website,
      street: adresse.street || null,
      house_number: adresse.houseNumber || null,
      street2: p.street2,
      zip: p.zip,
      city: p.city,
      country_code: p.country_code ?? 'DE',
      vat: p.vat,
      company_registry: p.company_registry,
      ref: p.ref,
      job_title: p.function,
      notes: htmlZuText(p.comment),
      vorname: namen.vorname,
      nachname: namen.nachname,
      active: p.active,
      shopify: shopifyGid,
      customer_term: firmenwert(p.payment_term)
        ? (paymentKarte.get(firmenwert(p.payment_term) as number) ?? null)
        : null,
      supplier_term: firmenwert(p.supplier_payment_term)
        ? (paymentKarte.get(firmenwert(p.supplier_payment_term) as number) ?? null)
        : null,
    }
    const vorhanden = partnerKarte.get(p.id)
    // Besitzerwechsel bei doppelten Shopify-Kunden (z. B. Duplikat wurde in
    // Odoo archiviert): der bisherige Träger räumt die unique GID, bevor der
    // Gewinner sie bekommt.
    if (werte.shopify) {
      if (vorhanden) {
        await ziel`update partners set shopify_customer_id = null
          where shopify_customer_id = ${werte.shopify} and id <> ${vorhanden}`
      } else {
        await ziel`update partners set shopify_customer_id = null
          where shopify_customer_id = ${werte.shopify}`
      }
    }
    if (vorhanden) {
      await ziel`update partners set
        name = ${werte.name}, is_company = ${werte.is_company},
        is_customer = ${werte.is_customer}, is_vendor = ${werte.is_vendor},
        email = ${werte.email}, phone = ${werte.phone}, mobile = ${werte.mobile},
        website = ${werte.website}, street = ${werte.street},
        house_number = ${werte.house_number}, street2 = ${werte.street2},
        zip = ${werte.zip}, city = ${werte.city}, country_code = ${werte.country_code},
        vat = ${werte.vat}, company_registry = ${werte.company_registry}, ref = ${werte.ref},
        job_title = ${werte.job_title}, notes = ${werte.notes},
        vorname = ${werte.vorname}, nachname = ${werte.nachname}, active = ${werte.active},
        shopify_customer_id = coalesce(${werte.shopify}, shopify_customer_id),
        customer_payment_term_id = ${werte.customer_term},
        supplier_payment_term_id = ${werte.supplier_term}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into partners (name, is_company, is_customer, is_vendor, email, phone,
          mobile, website, street, house_number, street2, zip, city, country_code,
          vat, company_registry, ref, job_title, notes, vorname, nachname, active,
          partner_type, shopify_customer_id, customer_payment_term_id, supplier_payment_term_id)
        values (${werte.name}, ${werte.is_company}, ${werte.is_customer}, ${werte.is_vendor},
          ${werte.email}, ${werte.phone}, ${werte.mobile}, ${werte.website},
          ${werte.street}, ${werte.house_number}, ${werte.street2}, ${werte.zip},
          ${werte.city}, ${werte.country_code}, ${werte.vat}, ${werte.company_registry},
          ${werte.ref}, ${werte.job_title}, ${werte.notes}, ${werte.vorname},
          ${werte.nachname}, ${werte.active}, 'contact', ${werte.shopify},
          ${werte.customer_term}, ${werte.supplier_term})
        returning id`
      partnerKarte.set(p.id, neu.id)
      await merken(lauf, 'res_partner', p.id, 'partners', neu.id)
    }
  }

  // Pass 2: Eltern-Verweise (selten — alle ANVIL-Partner sind flache Kontakte).
  for (const p of partner) {
    if (p.parent_id === null) continue
    const kind = partnerKarte.get(p.id)
    const eltern = partnerKarte.get(p.parent_id)
    if (kind && eltern) {
      await ziel`update partners set parent_id = ${eltern} where id = ${kind}`
    }
  }
  lauf.meldung(`Partner: ${partner.length} übernommen.`)
}

// --- Phase 2: Produkte ------------------------------------------------------

export async function phaseProdukte(lauf: Lauf): Promise<void> {
  const { ziel } = lauf
  const uomKarte = await verweisKarte(ziel, 'uom_uom')
  const steuerKarte = await verweisKarte(ziel, 'account_tax')
  const kategorieKarte = await verweisKarte(ziel, 'product_category')
  const partnerKarte = await verweisKarte(ziel, 'res_partner')

  const uomAufloesen = (odooId: number): string => {
    const id = uomKarte.get(odooId)
    if (!id) throw new Error(`Odoo-Einheit ${odooId} wurde in Phase 1 nicht zugeordnet.`)
    return id
  }

  // -- Attribute + Werte -------------------------------------------------------
  const attribute = await quelle.attribute(lauf.quelle)
  const attributKarte = new Map<number, string>()
  for (const attribut of attribute) {
    const name = uebersetzung(attribut.name, `Odoo-Attribut ${attribut.id}`)
    const [zeile] = await ziel<{ id: string }[]>`
      insert into product_attributes (name, display_type, sequence)
      values (${name}, ${attributAnzeige(attribut.display_type)}, ${attribut.sequence})
      on conflict (name) do update set sequence = excluded.sequence
      returning id`
    attributKarte.set(attribut.id, zeile.id)
    await merken(lauf, 'product_attribute', attribut.id, 'product_attributes', zeile.id)
  }

  const werte = await quelle.attributWerte(lauf.quelle)
  const wertKarte = new Map<number, string>()
  for (const wert of werte) {
    const attributId = attributKarte.get(wert.attribute_id)
    if (!attributId) continue
    const name = uebersetzung(wert.name, `Odoo-Wert ${wert.id}`)
    const [zeile] = await ziel<{ id: string }[]>`
      insert into product_attribute_values (attribute_id, name, html_color, sequence)
      values (${attributId}, ${name}, ${wert.html_color}, ${wert.sequence})
      on conflict (attribute_id, name) do update set sequence = excluded.sequence
      returning id`
    wertKarte.set(wert.id, zeile.id)
    await merken(lauf, 'product_attribute_value', wert.id, 'product_attribute_values', zeile.id)
  }
  lauf.meldung(`Attribute: ${attribute.length} mit ${werte.length} Werten.`)

  // -- Vorlagen ----------------------------------------------------------------
  const templates = await quelle.templates(lauf.quelle)
  const lieferantenpreise = await quelle.lieferantenpreise(lauf.quelle)
  const templateKarte = await verweisKarte(ziel, 'product_template')
  const mitLieferant = new Set(lieferantenpreise.map((l) => l.template_id))
  const [wurzelKategorie] = await ziel<{ id: string }[]>`
    select id from product_categories where parent_id is null order by created_at limit 1`

  for (const t of templates) {
    const name = uebersetzung(t.name, `Odoo-Produkt ${t.id}`)
    const uomId = uomAufloesen(t.uom_id)
    let purchaseUomId = uomAufloesen(t.uom_po_id)
    // Der KRNL-Trigger verlangt gleiche Kategorien — Odoo garantiert das
    // ebenfalls, aber ein Mapping-Fehler soll eine Warnung sein, kein Abbruch.
    const [kategorienGleich] = await ziel<{ gleich: boolean }[]>`
      select (select category_id from uoms where id = ${uomId})
           = (select category_id from uoms where id = ${purchaseUomId}) as gleich`
    if (!kategorienGleich.gleich) {
      warnen(lauf, `Produkt „${name}": Einkaufseinheit passt nicht zur Einheit — Einkaufseinheit = Einheit gesetzt.`)
      purchaseUomId = uomId
    }
    const zusatz: Record<string, unknown> = {}
    if (t.print_on_mo !== null && t.print_on_mo !== undefined) {
      zusatz.print_on_manufacturing_order = t.print_on_mo === true
    }
    if (t.out_of_stock_limit !== null && t.out_of_stock_limit !== undefined) {
      zusatz.out_of_stock_limit = Number(t.out_of_stock_limit)
    }
    const w = {
      name,
      type: t.is_storable ? 'goods' : 'service',
      uom_id: uomId,
      purchase_uom_id: purchaseUomId,
      category_id: kategorieKarte.get(t.categ_id) ?? wurzelKategorie.id,
      list_price: t.list_price ?? 0,
      weight_g: kgZuGramm(t.weight) ?? 0,
      can_be_sold: t.sale_ok,
      can_be_purchased: t.purchase_ok,
      sale_delay: t.sale_delay ?? 0,
      invoice_policy: t.invoice_policy === 'delivery' ? 'delivery' : 'order',
      bill_policy: t.purchase_method === 'purchase' ? 'ordered' : 'received',
      route_mto: t.hat_mto_route,
      route_manufacture: t.hat_bom,
      route_buy: t.purchase_ok || mitLieferant.has(t.id),
      tracking: t.tracking === 'lot' || t.tracking === 'serial' ? t.tracking : 'none',
      hs_code: t.hs_code,
      country_of_origin: t.country_of_origin_code,
      description: htmlZuText(t.description),
      description_sale: htmlZuText(t.description_sale),
      description_purchase: htmlZuText(t.description_purchase),
      description_picking: htmlZuText(t.description_picking),
      sale_tax_id: t.sale_tax_ids?.length ? (steuerKarte.get(t.sale_tax_ids[0]) ?? null) : null,
      purchase_tax_id: t.purchase_tax_ids?.length
        ? (steuerKarte.get(t.purchase_tax_ids[0]) ?? null)
        : null,
      active: t.active,
    }
    const vorhanden = templateKarte.get(t.id)
    if (vorhanden) {
      await ziel`update product_templates set
        name = ${w.name}, type = ${w.type}, uom_id = ${w.uom_id},
        purchase_uom_id = ${w.purchase_uom_id}, category_id = ${w.category_id},
        list_price = ${w.list_price}, weight_g = ${w.weight_g},
        can_be_sold = ${w.can_be_sold}, can_be_purchased = ${w.can_be_purchased},
        sale_delay = ${w.sale_delay}, invoice_policy = ${w.invoice_policy},
        bill_policy = ${w.bill_policy}, route_mto = ${w.route_mto},
        route_manufacture = ${w.route_manufacture}, route_buy = ${w.route_buy},
        tracking = ${w.tracking}, hs_code = ${w.hs_code},
        country_of_origin = ${w.country_of_origin}, description = ${w.description},
        description_sale = ${w.description_sale}, description_purchase = ${w.description_purchase},
        description_picking = ${w.description_picking}, sale_tax_id = ${w.sale_tax_id},
        purchase_tax_id = ${w.purchase_tax_id}, active = ${w.active},
        zusatz = zusatz || ${ziel.json(zusatz as never)}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into product_templates (name, type, uom_id, purchase_uom_id, category_id,
          list_price, weight_g, can_be_sold, can_be_purchased, sale_delay, invoice_policy,
          bill_policy, route_mto, route_manufacture, route_buy, tracking, hs_code,
          country_of_origin, description, description_sale, description_purchase,
          description_picking, sale_tax_id, purchase_tax_id, active, zusatz)
        values (${w.name}, ${w.type}, ${w.uom_id}, ${w.purchase_uom_id}, ${w.category_id},
          ${w.list_price}, ${w.weight_g}, ${w.can_be_sold}, ${w.can_be_purchased},
          ${w.sale_delay}, ${w.invoice_policy}, ${w.bill_policy}, ${w.route_mto},
          ${w.route_manufacture}, ${w.route_buy}, ${w.tracking}, ${w.hs_code},
          ${w.country_of_origin}, ${w.description}, ${w.description_sale},
          ${w.description_purchase}, ${w.description_picking}, ${w.sale_tax_id},
          ${w.purchase_tax_id}, ${w.active}, ${ziel.json(zusatz as never)})
        returning id`
      templateKarte.set(t.id, neu.id)
      await merken(lauf, 'product_template', t.id, 'product_templates', neu.id)
    }
  }

  // Die zwei Studio-Felder als Felddefinitionen — sichtbar, sobald eine
  // Produktmaske das Chamäleon-Modell trägt; die Werte liegen schon im zusatz.
  await ziel`
    insert into feld_definitionen (modell, name, label, typ, pflicht, sichtbar_in, sequence)
    values
      ('product_template', 'print_on_manufacturing_order', 'Auf Fertigungsauftrag drucken', 'schalter', false, array['formular'], 910),
      ('product_template', 'out_of_stock_limit', 'Ausverkauft-Grenze', 'nummer', false, array['formular'], 920)
    on conflict (modell, (coalesce(prozess_code, '')), name) do nothing`
  lauf.meldung(`Produkte: ${templates.length} Vorlagen übernommen.`)

  // -- Attributzeilen + Vorlagen-Attributwerte --------------------------------
  const zeilen = await quelle.attributZeilen(lauf.quelle)
  const zeilenKarte = new Map<number, string>()
  for (const zeile of zeilen) {
    const templateId = templateKarte.get(zeile.template_id)
    const attributId = attributKarte.get(zeile.attribute_id)
    if (!templateId || !attributId) continue
    const [neu] = await ziel<{ id: string }[]>`
      insert into product_template_attribute_lines (template_id, attribute_id)
      values (${templateId}, ${attributId})
      on conflict (template_id, attribute_id) do update set attribute_id = excluded.attribute_id
      returning id`
    zeilenKarte.set(zeile.id, neu.id)
  }

  const ptavs = await quelle.ptavs(lauf.quelle)
  const ptavKarte = new Map<number, string>()
  for (const ptav of ptavs) {
    const templateId = templateKarte.get(ptav.template_id)
    const attributId = attributKarte.get(ptav.attribute_id)
    const wertId = wertKarte.get(ptav.value_id)
    if (!templateId || !attributId || !wertId) continue
    const [zeile] = await ziel<{ id: string }[]>`
      select id from product_template_attribute_lines
      where template_id = ${templateId} and attribute_id = ${attributId}`
    if (!zeile) continue
    const [neu] = await ziel<{ id: string }[]>`
      insert into product_template_attribute_values (line_id, value_id, price_extra)
      values (${zeile.id}, ${wertId}, ${ptav.price_extra ?? 0})
      on conflict (line_id, value_id) do update set price_extra = excluded.price_extra
      returning id`
    ptavKarte.set(ptav.id, neu.id)
    await merken(lauf, 'product_template_attribute_value', ptav.id, 'product_template_attribute_values', neu.id)
  }

  // -- Varianten erzeugen und zuordnen ----------------------------------------
  for (const templateId of new Set(templateKarte.values())) {
    await ziel`select generate_variants(${templateId})`
  }

  const odooVarianten = await quelle.varianten(lauf.quelle)
  const variantenKarte = await verweisKarte(ziel, 'product_product')
  const ohnePartner: string[] = []
  const belegteSkus = new Set(
    (await ziel<{ sku: string }[]>`select sku from product_variants where sku is not null`).map(
      (z) => z.sku,
    ),
  )
  const zugeordneteKrnlIds = new Set<string>()

  for (const [odooTemplateId, krnlTemplateId] of new Map(
    templates.map((t) => [t.id, templateKarte.get(t.id) as string]),
  )) {
    const krnlVarianten = await ziel<
      { id: string; sku: string | null; werte: { attribut: string; wert: string }[] | null }[]
    >`
      select v.id, v.sku,
             (select json_agg(json_build_object('attribut', pa.name, 'wert', pav.name))
              from product_variant_attribute_values pvav
              join product_template_attribute_values ptav on ptav.id = pvav.ptav_id
              join product_template_attribute_lines l on l.id = ptav.line_id
              join product_attributes pa on pa.id = l.attribute_id
              join product_attribute_values pav on pav.id = ptav.value_id
              where pvav.variant_id = v.id) as werte
      from product_variants v where v.template_id = ${krnlTemplateId}`
    const krnlNachSchluessel = new Map(
      krnlVarianten.map((v) => [variantenSchluessel(v.werte ?? []), v]),
    )

    for (const odooVariante of odooVarianten.filter((v) => v.template_id === odooTemplateId)) {
      const schluessel = variantenSchluessel(
        (odooVariante.werte ?? []).map((w) => ({
          attribut: uebersetzung(w.attribut, ''),
          wert: uebersetzung(w.wert, ''),
        })),
      )
      let treffer = krnlNachSchluessel.get(schluessel)
      if (!treffer && !odooVariante.active && odooVariante.hat_belegbezug) {
        // Alt-Variante aus einer früheren Attribut-Generation (z. B. von
        // bevor „Keycap Set" ans Produkt kam): das kartesische Produkt kann
        // sie nie erzeugen, alte Belege referenzieren sie aber. Sie wird als
        // deaktivierte Variante OHNE Attributbindung angelegt — reines
        // FK-Ziel der Historie, taucht in keiner Maske mehr auf.
        const vorhandene = variantenKarte.get(odooVariante.id)
        if (vorhandene) {
          // Wiederholungslauf: die Archiv-Variante existiert schon — mit
          // ihrer echten SKU, sonst meldet der Duplikat-Check Phantome.
          treffer = krnlVarianten.find((v) => v.id === vorhandene) ?? {
            id: vorhandene,
            sku: null,
            werte: null,
          }
        } else {
          const [alt] = await ziel<{ id: string }[]>`
            insert into product_variants (template_id, active)
            values (${krnlTemplateId}, false)
            returning id`
          warnen(
            lauf,
            `Alt-Variante ${odooVariante.default_code ?? odooVariante.id} ohne heutige Attributkombination — als inaktive Archiv-Variante angelegt.`,
          )
          treffer = { id: alt.id, sku: null, werte: null }
        }
      }
      if (!treffer) {
        // Nur relevante Lücken melden — eine tote Odoo-Variante ohne einen
        // einzigen Beleg ist kein Migrationsverlust.
        if (odooVariante.active || odooVariante.hat_belegbezug) {
          ohnePartner.push(
            `Odoo-Variante ${odooVariante.id} (${odooVariante.default_code ?? 'ohne SKU'}): ${schluessel || 'ohne Attribute'}`,
          )
        }
        continue
      }
      zugeordneteKrnlIds.add(treffer.id)
      let sku = odooVariante.default_code?.trim() || null
      if (sku && belegteSkus.has(sku) && treffer.sku !== sku) {
        warnen(lauf, `SKU „${sku}" ist doppelt vergeben — Variante ${odooVariante.id} bleibt ohne SKU.`)
        sku = null
      }
      if (sku) belegteSkus.add(sku)
      await ziel`update product_variants set
        sku = coalesce(${sku}, sku),
        barcode = coalesce(${odooVariante.barcode?.trim() || null}, barcode),
        active = ${odooVariante.active}
        where id = ${treffer.id}`
      variantenKarte.set(odooVariante.id, treffer.id)
      await merken(lauf, 'product_product', odooVariante.id, 'product_variants', treffer.id)
    }

    // KRNL-Kombinationen ohne Odoo-Gegenstück (kartesisches Produkt erzeugt
    // mehr, als Odoo je angelegt hat): deaktivieren, nicht löschen.
    for (const v of krnlVarianten) {
      if (!zugeordneteKrnlIds.has(v.id)) {
        await ziel`update product_variants set active = false where id = ${v.id}`
      }
    }
  }

  if (ohnePartner.length > 0) {
    throw new Error(
      `${ohnePartner.length} Odoo-Varianten ohne KRNL-Gegenstück — Attributwert-Mapping prüfen:\n` +
        ohnePartner.slice(0, 10).join('\n'),
    )
  }
  lauf.meldung(`Varianten: ${variantenKarte.size} zugeordnet.`)

  // -- Lieferantenpreise -------------------------------------------------------
  const preisKarte = await verweisKarte(ziel, 'product_supplierinfo')
  for (const preis of lieferantenpreise) {
    const vendorId = partnerKarte.get(preis.partner_id)
    const templateId = templateKarte.get(preis.template_id)
    if (!vendorId || !templateId) {
      warnen(lauf, `Lieferantenpreis ${preis.id}: Lieferant oder Produkt fehlt — übersprungen.`)
      continue
    }
    const variantId = preis.variant_id ? (variantenKarte.get(preis.variant_id) ?? null) : null
    const w = {
      vendor_id: vendorId,
      template_id: templateId,
      variant_id: variantId,
      min_qty: preis.min_qty ?? 0,
      price: preis.price,
      discount: preis.discount ?? 0,
      currency: preis.waehrung ?? 'EUR',
      lead_time_days: preis.delay ?? 0,
      vendor_product_code: preis.product_code,
      product_name: preis.product_name,
      date_start: preis.date_start,
      date_end: preis.date_end,
      sequence: preis.sequence,
    }
    const vorhanden = preisKarte.get(preis.id)
    if (vorhanden) {
      await ziel`update vendor_prices set vendor_id = ${w.vendor_id},
        template_id = ${w.template_id}, variant_id = ${w.variant_id},
        min_qty = ${w.min_qty}, price = ${w.price}, discount = ${w.discount},
        currency = ${w.currency}, lead_time_days = ${w.lead_time_days},
        vendor_product_code = ${w.vendor_product_code}, product_name = ${w.product_name},
        date_start = ${w.date_start}, date_end = ${w.date_end}, sequence = ${w.sequence}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into vendor_prices (vendor_id, template_id, variant_id, min_qty, price,
          discount, currency, lead_time_days, vendor_product_code, product_name,
          date_start, date_end, sequence)
        values (${w.vendor_id}, ${w.template_id}, ${w.variant_id}, ${w.min_qty}, ${w.price},
          ${w.discount}, ${w.currency}, ${w.lead_time_days}, ${w.vendor_product_code},
          ${w.product_name}, ${w.date_start}, ${w.date_end}, ${w.sequence})
        returning id`
      await merken(lauf, 'product_supplierinfo', preis.id, 'vendor_prices', neu.id)
    }
  }
  lauf.meldung(`Lieferantenpreise: ${lieferantenpreise.length} übernommen.`)

  // -- Arbeitsplätze + Stücklisten --------------------------------------------
  const arbeitsplaetze = await quelle.arbeitsplaetze(lauf.quelle)
  const arbeitsplatzKarte = await verweisKarte(ziel, 'mrp_workcenter')
  for (const platz of arbeitsplaetze) {
    const name = uebersetzung(platz.name, `Arbeitsplatz ${platz.id}`)
    const code = platz.code?.trim() || `WC-${platz.id}`
    const vorhanden = arbeitsplatzKarte.get(platz.id)
    if (vorhanden) {
      await ziel`update work_centers set name = ${name}, code = ${code},
        cost_per_hour = ${platz.costs_hour ?? 0}, capacity = ${platz.default_capacity ?? 1},
        time_efficiency = ${platz.time_efficiency ?? 100}, active = ${platz.active}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into work_centers (name, code, cost_per_hour, capacity, time_efficiency, active)
        values (${name}, ${code}, ${platz.costs_hour ?? 0}, ${platz.default_capacity ?? 1},
                ${platz.time_efficiency ?? 100}, ${platz.active})
        on conflict (code) do update set name = excluded.name
        returning id`
      await merken(lauf, 'mrp_workcenter', platz.id, 'work_centers', neu.id)
    }
  }

  const boms = await quelle.boms(lauf.quelle)
  const bomZeilen = await quelle.bomZeilen(lauf.quelle)
  const bomKarte = await verweisKarte(ziel, 'mrp_bom')
  for (const bom of boms) {
    const templateId = templateKarte.get(bom.template_id)
    if (!templateId) {
      warnen(lauf, `Stückliste ${bom.id}: Produktvorlage fehlt — übersprungen.`)
      continue
    }
    const w = {
      template_id: templateId,
      variant_id: bom.variant_id ? (variantenKarte.get(bom.variant_id) ?? null) : null,
      code: bom.code,
      qty: bom.qty,
      uom_id: uomAufloesen(bom.uom_id),
      bom_type: bomTyp(bom.typ),
      consumption: bomVerbrauch(bom.consumption),
      active: bom.active,
    }
    let bomId = bomKarte.get(bom.id)
    if (bomId) {
      await ziel`update boms set template_id = ${w.template_id}, variant_id = ${w.variant_id},
        code = ${w.code}, qty = ${w.qty}, uom_id = ${w.uom_id}, bom_type = ${w.bom_type},
        consumption = ${w.consumption}, active = ${w.active} where id = ${bomId}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into boms (template_id, variant_id, code, qty, uom_id, bom_type, consumption, active)
        values (${w.template_id}, ${w.variant_id}, ${w.code}, ${w.qty}, ${w.uom_id},
                ${w.bom_type}, ${w.consumption}, ${w.active})
        returning id`
      bomId = neu.id
      bomKarte.set(bom.id, bomId)
      await merken(lauf, 'mrp_bom', bom.id, 'boms', bomId)
    }

    // Zeilen je Stückliste komplett neu aufbauen — einfacher und genauso
    // idempotent wie zeilenweises Upsert (nichts referenziert die Zeilen).
    await ziel`delete from bom_lines where bom_id = ${bomId}`
    for (const zeile of bomZeilen.filter((z) => z.bom_id === bom.id)) {
      const komponente = variantenKarte.get(zeile.variant_id)
      if (!komponente) {
        warnen(lauf, `Stücklistenzeile ${zeile.id}: Komponente ${zeile.variant_id} fehlt — übersprungen.`)
        continue
      }
      const [neueZeile] = await ziel<{ id: string }[]>`
        insert into bom_lines (bom_id, sequence, component_variant_id, qty, uom_id, issue_method)
        values (${bomId}, ${zeile.sequence}, ${komponente}, ${zeile.qty},
                ${uomAufloesen(zeile.uom_id)},
                ${zeile.manual_consumption ? 'manual' : 'backflush'})
        returning id`
      for (const ptavId of zeile.ptav_ids ?? []) {
        const krnlPtav = ptavKarte.get(ptavId)
        if (krnlPtav) {
          await ziel`
            insert into bom_line_variant_filters (bom_line_id, ptav_id)
            values (${neueZeile.id}, ${krnlPtav})
            on conflict do nothing`
        }
      }
    }
  }
  lauf.meldung(`Stücklisten: ${boms.length} mit ${bomZeilen.length} Zeilen, ${arbeitsplaetze.length} Arbeitsplätze.`)

  // -- Meldebestände -----------------------------------------------------------
  const meldebestaende = await quelle.meldebestaende(lauf.quelle)
  const [lagerort] = await ziel<{ id: string }[]>`
    select id from stock_locations where full_path = 'WH/Stock'`
  for (const punkt of meldebestaende) {
    const variantId = variantenKarte.get(punkt.variant_id)
    if (!variantId) {
      warnen(lauf, `Meldebestand ${punkt.id}: Variante fehlt — übersprungen.`)
      continue
    }
    const [zeile] = await ziel<{ id: string }[]>`
      insert into stock_orderpoints (variant_id, location_id, min_qty, max_qty, qty_multiple,
                                     trigger, snoozed_until, route, active)
      values (${variantId}, ${lagerort.id}, ${punkt.min_qty}, ${punkt.max_qty},
              ${punkt.qty_multiple}, ${punkt.ausloeser === 'manual' ? 'manual' : 'auto'},
              ${punkt.snoozed_until}, ${punkt.route_typ === 'manufacture' ? 'manufacture' : 'buy'},
              ${punkt.active})
      on conflict (variant_id, location_id) do update set
        min_qty = excluded.min_qty, max_qty = excluded.max_qty,
        qty_multiple = excluded.qty_multiple, trigger = excluded.trigger,
        snoozed_until = excluded.snoozed_until, route = excluded.route,
        active = excluded.active
      returning id`
    await merken(lauf, 'stock_warehouse_orderpoint', punkt.id, 'stock_orderpoints', zeile.id)
  }
  lauf.meldung(`Meldebestände: ${meldebestaende.length} übernommen.`)
}

// --- Phase 3: Belege flach (Historie) ---------------------------------------

/**
 * Der flache Schnitt (Entscheidungslog 2026-08-25): Abgeschlossenes wird im
 * Endzustand eingefügt — inklusive der Rückschreibefelder, die sonst die
 * Buchungs-Trigger pflegen würden, und OHNE Pickings/Moves. Offene Belege
 * entstehen hier nur als Entwurf mit Zeilen; Phase 7 bucht sie über die
 * echten Funktionen durch. Original-Belegnummern bleiben erhalten,
 * created_at/confirmed_at kommen direkt aus Odoo.
 */
export async function phaseBelege(lauf: Lauf): Promise<void> {
  const { ziel } = lauf
  const partnerKarte = await verweisKarte(ziel, 'res_partner')
  const variantenKarte = await verweisKarte(ziel, 'product_product')
  const uomKarte = await verweisKarte(ziel, 'uom_uom')
  const steuerKarte = await verweisKarte(ziel, 'account_tax')
  const paymentKarte = await verweisKarte(ziel, 'account_payment_term')

  // Lieferadressen werden am Beleg eingefroren — aus dem KRNL-Partner.
  const partnerDetails = new Map(
    (
      await ziel<
        {
          id: string
          name: string
          street: string | null
          house_number: string | null
          street2: string | null
          zip: string | null
          city: string | null
          country_code: string | null
          phone: string | null
          email: string | null
        }[]
      >`select id, name, street, house_number, street2, zip, city, country_code, phone, email
        from partners`
    ).map((p) => [p.id, p]),
  )

  // -- Verkauf -----------------------------------------------------------------
  const auftraege = await quelle.verkaufsauftraege(lauf.quelle)
  const zeilen = await quelle.verkaufszeilen(lauf.quelle)
  const zeilenJeAuftrag = new Map<number, quelle.OdooSaleZeile[]>()
  for (const zeile of zeilen) {
    const liste = zeilenJeAuftrag.get(zeile.order_id) ?? []
    liste.push(zeile)
    zeilenJeAuftrag.set(zeile.order_id, liste)
  }
  const soKarte = await verweisKarte(ziel, 'sale_order')
  const soZeilenKarte = await verweisKarte(ziel, 'sale_order_line')
  /** Odoo-Belegname (S00013) → KRNL-id — für MO-/Reparatur-Verknüpfungen. */
  const soNameKarte = new Map<string, string>()
  let soFlach = 0
  let soOffen = 0

  // Mehrere Odoo-Aufträge zur selben Shopify-Bestellung (Storno + Neuanlage):
  // die unique GID bekommt deterministisch der nicht-stornierte bzw. jüngste.
  const orderGidBesitzer = new Map<string, number>()
  for (const auftrag of auftraege) {
    if (!istShopifyRef(auftrag.client_order_ref)) continue
    const ref = (auftrag.client_order_ref as string).trim()
    const bisherId = orderGidBesitzer.get(ref)
    const bisher = auftraege.find((a) => a.id === bisherId)
    const gewinnt =
      bisher === undefined ||
      (auftrag.state !== 'cancel' && bisher.state === 'cancel') ||
      ((auftrag.state === 'cancel') === (bisher.state === 'cancel') && auftrag.id > bisher.id)
    if (gewinnt) orderGidBesitzer.set(ref, auftrag.id)
  }

  for (const auftrag of auftraege) {
    // Klassifikation: erledigt/storniert = flach, offen = Entwurf für Phase 7.
    const art =
      auftrag.state === 'cancel'
        ? 'cancel'
        : auftrag.state === 'sale'
          ? auftrag.delivery_status === 'pending'
            ? 'offen'
            : 'flach'
          : 'entwurf'
    if (auftrag.state === 'sale' && auftrag.delivery_status === null) {
      warnen(
        lauf,
        `Auftrag ${auftrag.name} ohne Lieferstatus (nur nicht-lagergeführte Zeilen) — flach als erledigt übernommen.`,
      )
    }
    const partnerId = partnerKarte.get(auftrag.partner_id)
    if (!partnerId) {
      warnen(lauf, `Auftrag ${auftrag.name}: Partner ${auftrag.partner_id} fehlt — übersprungen.`)
      continue
    }
    const versand = partnerDetails.get(partnerId)
    const istShopify = istShopifyRef(auftrag.client_order_ref)
    // Die unique GID nur an den Besitzer — source bleibt für alle 'shopify'.
    const shopify =
      istShopify && orderGidBesitzer.get((auftrag.client_order_ref as string).trim()) === auftrag.id
    const kopf = {
      number: auftrag.name,
      state: art === 'flach' || art === 'offen' ? (art === 'flach' ? 'sale' : 'draft') : saleState(auftrag.state),
      locked: art === 'flach' ? auftrag.locked : false,
      partner_id: partnerId,
      order_date: auftrag.date_order ?? auftrag.create_date,
      confirmed_at: art === 'flach' ? (auftrag.date_order ?? auftrag.create_date) : null,
      delivery_status: art === 'flach' ? 'full' : 'pending',
      invoice_status: art === 'flach' ? invoiceStatus(auftrag.invoice_status ?? 'no') : 'no',
      source: istShopify ? 'shopify' : 'manual',
      shopify_order_id: shopify ? bestellGid(auftrag.client_order_ref as string) : null,
      shopify_order_name: auftrag.shopify_order_name,
      client_order_ref: auftrag.client_order_ref,
      currency: auftrag.waehrung ?? 'EUR',
      note: htmlZuText(auftrag.note),
      origin: auftrag.origin,
      payment_term_id: auftrag.payment_term_id
        ? (paymentKarte.get(auftrag.payment_term_id) ?? null)
        : null,
      commitment_date: auftrag.commitment_date,
      validity_date: auftrag.validity_date,
      created_at: auftrag.create_date,
    }

    let krnlId = soKarte.get(auftrag.id)
    if (krnlId) {
      const [bestand] = await ziel<{ state: string }[]>`
        select state from sales_orders where id = ${krnlId}`
      if (art === 'offen' && bestand && bestand.state !== 'draft') {
        // Schon von Phase 7 bestätigt — hier nicht mehr anfassen.
        soNameKarte.set(auftrag.name, krnlId)
        soOffen++
        continue
      }
      await ziel`update sales_orders set
        state = ${kopf.state}, locked = ${kopf.locked}, partner_id = ${kopf.partner_id},
        order_date = ${kopf.order_date}, confirmed_at = ${kopf.confirmed_at},
        delivery_status = ${kopf.delivery_status}, invoice_status = ${kopf.invoice_status},
        source = ${kopf.source}, shopify_order_id = ${kopf.shopify_order_id},
        shopify_order_name = ${kopf.shopify_order_name}, client_order_ref = ${kopf.client_order_ref},
        currency = ${kopf.currency}, note = ${kopf.note}, origin = ${kopf.origin},
        payment_term_id = ${kopf.payment_term_id}, commitment_date = ${kopf.commitment_date},
        validity_date = ${kopf.validity_date}
        where id = ${krnlId}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into sales_orders (number, state, locked, partner_id, order_date, confirmed_at,
          delivery_status, invoice_status, source, shopify_order_id, shopify_order_name,
          client_order_ref, currency, note, origin, payment_term_id, commitment_date,
          validity_date, created_at,
          ship_name, ship_street, ship_house_number, ship_street2, ship_zip, ship_city,
          ship_country_code, ship_phone, ship_email)
        values (${kopf.number}, ${kopf.state}, ${kopf.locked}, ${kopf.partner_id},
          ${kopf.order_date}, ${kopf.confirmed_at}, ${kopf.delivery_status},
          ${kopf.invoice_status}, ${kopf.source}, ${kopf.shopify_order_id},
          ${kopf.shopify_order_name}, ${kopf.client_order_ref}, ${kopf.currency},
          ${kopf.note}, ${kopf.origin}, ${kopf.payment_term_id}, ${kopf.commitment_date},
          ${kopf.validity_date}, ${kopf.created_at},
          ${versand?.name ?? null}, ${versand?.street ?? null}, ${versand?.house_number ?? null},
          ${versand?.street2 ?? null}, ${versand?.zip ?? null}, ${versand?.city ?? null},
          ${versand?.country_code ?? null}, ${versand?.phone ?? null}, ${versand?.email ?? null})
        returning id`
      krnlId = neu.id
      soKarte.set(auftrag.id, krnlId)
      await merken(lauf, 'sale_order', auftrag.id, 'sales_orders', krnlId)
    }
    soNameKarte.set(auftrag.name, krnlId)
    if (art === 'flach') soFlach++
    if (art === 'offen') soOffen++

    for (const zeile of zeilenJeAuftrag.get(auftrag.id) ?? []) {
      const variantId = zeile.product_id ? (variantenKarte.get(zeile.product_id) ?? null) : null
      const istStruktur = zeile.display_type === 'line_section' || zeile.display_type === 'line_note'
      if (!istStruktur && zeile.product_id && !variantId) {
        warnen(lauf, `Auftragszeile ${zeile.id} (${auftrag.name}): Variante ${zeile.product_id} fehlt — übersprungen.`)
        continue
      }
      const w = {
        order_id: krnlId,
        sequence: zeile.sequence,
        display_type: istStruktur ? (zeile.display_type === 'line_section' ? 'section' : 'note') : null,
        variant_id: istStruktur ? null : variantId,
        name: uebersetzung(zeile.name, '—'),
        qty: zeile.qty,
        uom_id: zeile.uom_id ? (uomKarte.get(zeile.uom_id) ?? null) : null,
        price_unit: zeile.price_unit,
        discount: zeile.discount ?? 0,
        tax_rate: zeile.tax_amount ?? 0,
        tax_id: zeile.tax_id ? (steuerKarte.get(zeile.tax_id) ?? null) : null,
        qty_delivered: art === 'flach' ? zeile.qty_delivered : 0,
        qty_invoiced: art === 'flach' ? zeile.qty_invoiced : 0,
        qty_to_invoice: art === 'flach' ? zeile.qty_to_invoice : 0,
        invoice_status: art === 'flach' ? invoiceStatus(zeile.invoice_status ?? 'no') : 'no',
        customer_lead: zeile.customer_lead ?? 0,
      }
      const zeileVorhanden = soZeilenKarte.get(zeile.id)
      if (zeileVorhanden) {
        await ziel`update sales_order_lines set
          sequence = ${w.sequence}, display_type = ${w.display_type},
          variant_id = ${w.variant_id}, name = ${w.name}, qty = ${w.qty},
          uom_id = ${w.uom_id}, price_unit = ${w.price_unit}, discount = ${w.discount},
          tax_rate = ${w.tax_rate}, tax_id = ${w.tax_id},
          qty_delivered = ${w.qty_delivered}, qty_invoiced = ${w.qty_invoiced},
          qty_to_invoice = ${w.qty_to_invoice}, invoice_status = ${w.invoice_status},
          customer_lead = ${w.customer_lead}
          where id = ${zeileVorhanden}`
      } else {
        const [neueZeile] = await ziel<{ id: string }[]>`
          insert into sales_order_lines (order_id, sequence, display_type, variant_id,
            name, qty, uom_id, price_unit, discount, tax_rate, tax_id, qty_delivered,
            qty_invoiced, qty_to_invoice, invoice_status, customer_lead)
          values (${w.order_id}, ${w.sequence}, ${w.display_type}, ${w.variant_id},
            ${w.name}, ${w.qty}, ${w.uom_id}, ${w.price_unit}, ${w.discount},
            ${w.tax_rate}, ${w.tax_id}, ${w.qty_delivered}, ${w.qty_invoiced},
            ${w.qty_to_invoice}, ${w.invoice_status}, ${w.customer_lead})
          returning id`
        soZeilenKarte.set(zeile.id, neueZeile.id)
        await merken(lauf, 'sale_order_line', zeile.id, 'sales_order_lines', neueZeile.id)
      }
    }
  }
  lauf.meldung(
    `Verkauf: ${auftraege.length} Aufträge (${soFlach} flach erledigt, ${soOffen} offen als Entwurf für Phase 7).`,
  )

  // -- Einkauf -----------------------------------------------------------------
  const bestellungen = await quelle.bestellungen(lauf.quelle)
  const bestellzeilen = await quelle.bestellzeilen(lauf.quelle)
  const zeilenJeBestellung = new Map<number, quelle.OdooPurchaseZeile[]>()
  for (const zeile of bestellzeilen) {
    const liste = zeilenJeBestellung.get(zeile.order_id) ?? []
    liste.push(zeile)
    zeilenJeBestellung.set(zeile.order_id, liste)
  }
  const poKarte = await verweisKarte(ziel, 'purchase_order')
  const poZeilenKarte = await verweisKarte(ziel, 'purchase_order_line')
  const poNameKarte = new Map<string, string>()
  let poOffen = 0

  for (const bestellung of bestellungen) {
    const art =
      bestellung.state === 'cancel'
        ? 'cancel'
        : bestellung.state === 'purchase' || bestellung.state === 'done'
          ? bestellung.voll_empfangen
            ? 'flach'
            : 'offen'
          : 'entwurf'
    const vendorId = partnerKarte.get(bestellung.partner_id)
    if (!vendorId) {
      warnen(lauf, `Bestellung ${bestellung.name}: Lieferant fehlt — übersprungen.`)
      continue
    }
    const kopf = {
      number: bestellung.name,
      state: art === 'flach' ? purchaseState(bestellung.state) : art === 'cancel' ? 'cancel' : 'draft',
      vendor_id: vendorId,
      vendor_reference: bestellung.partner_ref,
      order_deadline: bestellung.date_order,
      expected_arrival: bestellung.date_planned,
      confirmed_at: art === 'flach' ? (bestellung.date_approve ?? bestellung.date_order) : null,
      billing_status: art === 'flach' ? billingStatus(bestellung.invoice_status ?? 'no') : 'nothing',
      currency: bestellung.waehrung ?? 'EUR',
      note: htmlZuText(bestellung.notes),
      origin: bestellung.origin,
      created_at: bestellung.create_date,
    }
    let krnlId = poKarte.get(bestellung.id)
    if (krnlId) {
      const [bestand] = await ziel<{ state: string }[]>`
        select state from purchase_orders where id = ${krnlId}`
      if (art === 'offen' && bestand && bestand.state !== 'draft') {
        poNameKarte.set(bestellung.name, krnlId)
        poOffen++
        continue
      }
      await ziel`update purchase_orders set
        state = ${kopf.state}, vendor_id = ${kopf.vendor_id},
        vendor_reference = ${kopf.vendor_reference}, order_deadline = ${kopf.order_deadline},
        expected_arrival = ${kopf.expected_arrival}, confirmed_at = ${kopf.confirmed_at},
        billing_status = ${kopf.billing_status}, currency = ${kopf.currency},
        note = ${kopf.note}, origin = ${kopf.origin}
        where id = ${krnlId}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into purchase_orders (number, state, vendor_id, vendor_reference,
          order_deadline, expected_arrival, confirmed_at, billing_status, currency,
          note, origin, created_at)
        values (${kopf.number}, ${kopf.state}, ${kopf.vendor_id}, ${kopf.vendor_reference},
          ${kopf.order_deadline}, ${kopf.expected_arrival}, ${kopf.confirmed_at},
          ${kopf.billing_status}, ${kopf.currency}, ${kopf.note}, ${kopf.origin},
          ${kopf.created_at})
        returning id`
      krnlId = neu.id
      poKarte.set(bestellung.id, krnlId)
      await merken(lauf, 'purchase_order', bestellung.id, 'purchase_orders', krnlId)
    }
    poNameKarte.set(bestellung.name, krnlId)
    if (art === 'offen') poOffen++

    for (const zeile of zeilenJeBestellung.get(bestellung.id) ?? []) {
      if (zeile.display_type) continue // Struktur-/Notizzeilen kennt der KRNL-Einkauf nicht
      const variantId = zeile.product_id ? (variantenKarte.get(zeile.product_id) ?? null) : null
      if (!variantId) {
        warnen(lauf, `Bestellzeile ${zeile.id} (${bestellung.name}): Variante fehlt — übersprungen.`)
        continue
      }
      const w = {
        order_id: krnlId,
        sequence: zeile.sequence,
        variant_id: variantId,
        name: uebersetzung(zeile.name, '—'),
        qty: zeile.qty > 0 ? zeile.qty : 1,
        uom_id: zeile.uom_id ? (uomKarte.get(zeile.uom_id) ?? null) : null,
        price_unit: zeile.price_unit,
        discount: zeile.discount ?? 0,
        tax_rate: zeile.tax_amount ?? 0,
        qty_received: art === 'flach' ? zeile.qty_received : 0,
        qty_billed: art === 'flach' ? zeile.qty_invoiced : 0,
        date_planned: zeile.date_planned,
      }
      const zeileVorhanden = poZeilenKarte.get(zeile.id)
      if (zeileVorhanden) {
        await ziel`update purchase_order_lines set
          sequence = ${w.sequence}, variant_id = ${w.variant_id}, name = ${w.name},
          qty = ${w.qty}, uom_id = ${w.uom_id}, price_unit = ${w.price_unit},
          discount = ${w.discount}, tax_rate = ${w.tax_rate},
          qty_received = ${w.qty_received}, qty_billed = ${w.qty_billed},
          date_planned = ${w.date_planned}
          where id = ${zeileVorhanden}`
      } else {
        const [neueZeile] = await ziel<{ id: string }[]>`
          insert into purchase_order_lines (order_id, sequence, variant_id, name, qty,
            uom_id, price_unit, discount, tax_rate, qty_received, qty_billed, date_planned)
          values (${w.order_id}, ${w.sequence}, ${w.variant_id}, ${w.name}, ${w.qty},
            ${w.uom_id}, ${w.price_unit}, ${w.discount}, ${w.tax_rate}, ${w.qty_received},
            ${w.qty_billed}, ${w.date_planned})
          returning id`
        poZeilenKarte.set(zeile.id, neueZeile.id)
        await merken(lauf, 'purchase_order_line', zeile.id, 'purchase_order_lines', neueZeile.id)
      }
    }
  }
  lauf.meldung(`Einkauf: ${bestellungen.length} Bestellungen (${poOffen} offen für Phase 7).`)

  // -- Fertigung (nur abgeschlossene/stornierte — offene macht Phase 7) --------
  const fertigungen = await quelle.fertigungsauftraege(lauf.quelle)
  const moKarte = await verweisKarte(ziel, 'mrp_production')
  const bomKarte = await verweisKarte(ziel, 'mrp_bom')
  let moFlach = 0
  let moOffen = 0
  for (const mo of fertigungen) {
    if (mo.state !== 'done' && mo.state !== 'cancel') {
      moOffen++
      continue
    }
    const variantId = variantenKarte.get(mo.variant_id)
    if (!variantId) {
      warnen(lauf, `Fertigung ${mo.name}: Variante fehlt — übersprungen.`)
      continue
    }
    const w = {
      number: mo.name,
      variant_id: variantId,
      bom_id: mo.bom_id ? (bomKarte.get(mo.bom_id) ?? null) : null,
      qty_to_produce: mo.qty > 0 ? mo.qty : 1,
      qty_produced: mo.state === 'done' ? mo.qty : 0,
      uom_id: uomKarte.get(mo.uom_id) ?? null,
      state: moState(mo.state),
      scheduled_date: mo.date_deadline ?? mo.date_start,
      date_start: mo.date_start,
      date_done: mo.date_finished,
      sales_order_id: mo.origin ? (soNameKarte.get(mo.origin) ?? null) : null,
      origin: mo.origin,
      created_at: mo.create_date,
    }
    const vorhanden = moKarte.get(mo.id)
    if (vorhanden) {
      await ziel`update manufacturing_orders set
        variant_id = ${w.variant_id}, bom_id = ${w.bom_id},
        qty_to_produce = ${w.qty_to_produce}, qty_produced = ${w.qty_produced},
        uom_id = ${w.uom_id}, state = ${w.state}, scheduled_date = ${w.scheduled_date},
        date_start = ${w.date_start}, date_done = ${w.date_done},
        sales_order_id = ${w.sales_order_id}, origin = ${w.origin}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into manufacturing_orders (number, variant_id, bom_id, qty_to_produce,
          qty_produced, uom_id, state, scheduled_date, date_start, date_done,
          sales_order_id, origin, created_at)
        values (${w.number}, ${w.variant_id}, ${w.bom_id}, ${w.qty_to_produce},
          ${w.qty_produced}, ${w.uom_id}, ${w.state}, ${w.scheduled_date},
          ${w.date_start}, ${w.date_done}, ${w.sales_order_id}, ${w.origin},
          ${w.created_at})
        returning id`
      await merken(lauf, 'mrp_production', mo.id, 'manufacturing_orders', neu.id)
    }
    moFlach++
  }
  lauf.meldung(`Fertigung: ${moFlach} flach übernommen, ${moOffen} offen für Phase 7.`)

  // -- Reparatur (abgeschlossene flach; Quelle führt keine Teile-Moves) --------
  const reparaturen = await quelle.reparaturen(lauf.quelle)
  const repKarte = await verweisKarte(ziel, 'repair_order')
  let repFlach = 0
  let repOffen = 0
  for (const rep of reparaturen) {
    if (rep.state !== 'done' && rep.state !== 'cancel') {
      repOffen++
      continue
    }
    const partnerId = rep.partner_id ? partnerKarte.get(rep.partner_id) : undefined
    const variantId = rep.variant_id ? variantenKarte.get(rep.variant_id) : undefined
    if (!partnerId || !variantId) {
      // ANVILs abgeschlossene Odoo-Reparaturen tragen kein Produkt — in KRNL
      // ist es Pflicht; ohne Produkt und ohne Teile gibt es nichts abzubilden.
      warnen(
        lauf,
        `Reparatur ${rep.name}: ${variantId ? 'Partner' : 'keine Produktangabe in Odoo'} — nicht abbildbar, übersprungen.`,
      )
      continue
    }
    const soId = rep.sale_order_id
      ? (soKarte.get(rep.sale_order_id) ?? null)
      : null
    const w = {
      number: rep.name,
      partner_id: partnerId,
      variant_id: variantId,
      qty: rep.qty,
      under_warranty: rep.under_warranty,
      state: repairState(rep.state),
      scheduled_date: rep.schedule_date,
      sales_order_id: soId,
      created_at: rep.create_date,
    }
    const vorhanden = repKarte.get(rep.id)
    if (vorhanden) {
      await ziel`update repair_orders set
        partner_id = ${w.partner_id}, variant_id = ${w.variant_id}, qty = ${w.qty},
        under_warranty = ${w.under_warranty}, state = ${w.state},
        scheduled_date = ${w.scheduled_date}, sales_order_id = ${w.sales_order_id}
        where id = ${vorhanden}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into repair_orders (number, partner_id, variant_id, qty, under_warranty,
          state, scheduled_date, sales_order_id, created_at)
        values (${w.number}, ${w.partner_id}, ${w.variant_id}, ${w.qty},
          ${w.under_warranty}, ${w.state}, ${w.scheduled_date}, ${w.sales_order_id},
          ${w.created_at})
        returning id`
      await merken(lauf, 'repair_order', rep.id, 'repair_orders', neu.id)
    }
    repFlach++
  }
  lauf.meldung(`Reparatur: ${repFlach} flach übernommen, ${repOffen} offen für Phase 7.`)
}

// --- Phase 4: Eingangsrechnungen --------------------------------------------

/**
 * Die vier echten Eingangsrechnungen — flach per Insert, bewusst NICHT über
 * create_vendor_bill/post_vendor_bill: qty_billed an den Bestellzeilen
 * steht schon aus Phase 3, die Funktionen würden es doppelt fortschreiben.
 */
export async function phaseRechnungen(lauf: Lauf): Promise<void> {
  const { ziel } = lauf
  const partnerKarte = await verweisKarte(ziel, 'res_partner')
  const poZeilenKarte = await verweisKarte(ziel, 'purchase_order_line')
  const billKarte = await verweisKarte(ziel, 'account_move')

  const poNachName = new Map(
    (
      await ziel<{ id: string; number: string }[]>`
        select p.id, p.number from purchase_orders p
        where exists (select 1 from odoo_verweise v
                      where v.krnl_tabelle = 'purchase_orders' and v.krnl_id = p.id)`
    ).map((p) => [p.number, p.id]),
  )

  const rechnungen = await quelle.eingangsrechnungen(lauf.quelle)
  const zeilen = await quelle.rechnungszeilen(lauf.quelle)

  let uebernommen = 0
  for (const rechnung of rechnungen) {
    const vendorId = rechnung.partner_id ? partnerKarte.get(rechnung.partner_id) : undefined
    if (!vendorId) {
      warnen(
        lauf,
        `Eingangsrechnung ${rechnung.name ?? `#${rechnung.id}`}: leerer Entwurf ohne Lieferant — übersprungen.`,
      )
      continue
    }
    const bezahlt = rechnung.state === 'posted' && billBezahlt(rechnung.payment_state)
    const w = {
      number: rechnung.name,
      vendor_id: vendorId,
      purchase_order_id: rechnung.invoice_origin
        ? (poNachName.get(rechnung.invoice_origin.trim()) ?? null)
        : null,
      state: bezahlt ? 'paid' : billState(rechnung.state),
      bill_date: rechnung.invoice_date,
      due_date: rechnung.invoice_date_due,
      vendor_bill_reference: rechnung.ref,
      paid_at: bezahlt ? (rechnung.invoice_date ?? rechnung.create_date) : null,
      created_at: rechnung.create_date,
    }
    let krnlId = billKarte.get(rechnung.id)
    if (krnlId) {
      await ziel`update vendor_bills set
        vendor_id = ${w.vendor_id}, purchase_order_id = ${w.purchase_order_id},
        state = ${w.state}, bill_date = ${w.bill_date}, due_date = ${w.due_date},
        vendor_bill_reference = ${w.vendor_bill_reference}, paid_at = ${w.paid_at}
        where id = ${krnlId}`
      await ziel`delete from vendor_bill_lines where bill_id = ${krnlId}`
    } else {
      const [neu] = await ziel<{ id: string }[]>`
        insert into vendor_bills (number, vendor_id, purchase_order_id, state, bill_date,
          due_date, vendor_bill_reference, paid_at, created_at)
        values (${w.number}, ${w.vendor_id}, ${w.purchase_order_id}, ${w.state},
          ${w.bill_date}, ${w.due_date}, ${w.vendor_bill_reference}, ${w.paid_at},
          ${w.created_at})
        returning id`
      krnlId = neu.id
      billKarte.set(rechnung.id, krnlId)
      await merken(lauf, 'account_move', rechnung.id, 'vendor_bills', krnlId)
    }

    for (const zeile of zeilen.filter((z) => z.move_id === rechnung.id)) {
      await ziel`
        insert into vendor_bill_lines (bill_id, po_line_id, name, qty, price_unit, tax_rate)
        values (${krnlId},
          ${zeile.purchase_line_id ? (poZeilenKarte.get(zeile.purchase_line_id) ?? null) : null},
          ${uebersetzung(zeile.name, '—')}, ${zeile.qty}, ${zeile.price_unit},
          ${zeile.tax_amount ?? 0})`
    }
    uebernommen++
  }
  lauf.meldung(`Eingangsrechnungen: ${uebernommen} von ${rechnungen.length} übernommen.`)
}
