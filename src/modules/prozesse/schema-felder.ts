import { z } from 'zod'
import type { RegistrierteAktion } from './registry/typen.ts'

/**
 * Formulartaugliche Feldableitung aus den zod-Schemas der Registry — das
 * Herz der Maskengenerierung: eine Aktion beschreibt ihre Eingaben genau
 * einmal (im Schema), die Maske fällt daraus ab. Bewusst datenbankfrei;
 * Auswahllisten für Verweisfelder (partner_id, variant_id, …) löst die
 * Server-Komponente auf, die das Formular einbettet.
 */

export type FeldTyp =
  | 'text'
  | 'mehrzeilig'
  | 'nummer'
  | 'schalter'
  | 'auswahl'
  | 'verweis'
  | 'datum'
  | 'json'

export interface FormularFeld {
  name: string
  label: string
  typ: FeldTyp
  pflicht: boolean
  /** Vorgabewert aus zod (.default) — nicht zu verwechseln mit Schritt-params. */
  vorgabe?: unknown
  /** Werte einer Enum-Auswahl. */
  auswahl?: string[]
  /** Für typ 'verweis': welcher Stammdatenbestand (aus dem Feldnamen abgeleitet). */
  quelle?: string
  hinweis?: string
}

/** Innerste Typ-Schale freilegen (Optional/Default/Nullable/Effects). */
function kern(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodNullable) {
      s = s._def.innerType as z.ZodTypeAny
    } else if (s instanceof z.ZodEffects) {
      s = s._def.schema as z.ZodTypeAny
    } else {
      return s
    }
  }
}

/** `partner_id` → `partners` usw. — die Quelle einer Verweis-Auswahl. */
const VERWEIS_QUELLEN: Record<string, string> = {
  partner_id: 'partners',
  vendor_id: 'vendors',
  variant_id: 'product_variants',
  user_id: 'users',
  bankkonto_id: 'bankkonten',
}

function beschriftung(name: string): string {
  /**
   * Deutsches Wörterbuch über ALLE Registry-Feldnamen — die generierten
   * Masken sind Oberflächen erster Klasse, rohe Spaltennamen haben dort
   * nichts verloren. Neue Felder ohne .describe() landen im Fallback unten
   * und fallen im nächsten Masken-Blick auf.
   */
  const TEXTE: Record<string, string> = {
    // Verweise
    partner_id: 'Kunde/Partner',
    vendor_id: 'Lieferant',
    variant_id: 'Produkt',
    user_id: 'Verantwortlich',
    bankkonto_id: 'Bankkonto',
    // Finanzen
    iban: 'IBAN',
    waehrung: 'Währung',
    stichtag: 'Stichtag',
    saldo: 'Saldo (€)',
    richtung: 'Richtung',
    betrag: 'Betrag',
    gezahlt_am: 'Gezahlt am',
    verwendungszweck: 'Verwendungszweck',
    zahlung_id: 'Zahlung',
    anzahlung_pct: 'Anzahlung (%)',
    rest_ausloeser: 'Rest fällig bei',
    rest_termin: 'Rest-Termin',
    rest_versatz_tage: 'Rest-Versatz (Tage)',
    bezeichnung: 'Bezeichnung',
    anteil_pct: 'Anteil (%)',
    ausloeser: 'Fällig bei',
    versatz_tage: 'Versatz (Tage)',
    termin: 'Termin',
    rate_id: 'Zahlplan-Rate',
    verschifft_am: 'Verschifft am',
    kategorie: 'Kategorie',
    intervall: 'Intervall',
    zahltag: 'Zahltag (1–28)',
    beginn: 'Vertragsbeginn',
    ende: 'Vertragsende (leer = unbefristet)',
    laufzeit_monate: 'Mindestlaufzeit (Monate)',
    kuendigungsfrist_monate: 'Kündigungsfrist (Monate)',
    zum: 'Kündigen zum (leer = nächstmöglich)',
    // Allgemein
    name: 'Name',
    qty: 'Menge',
    menge: 'Menge',
    note: 'Vermerk',
    vermerk: 'Vermerk',
    titel: 'Titel',
    beschreibung: 'Beschreibung',
    status: 'Status',
    state: 'Status',
    aktiv: 'Aktiv',
    active: 'Aktiv',
    aufloesung: 'Vermerk zum Abschluss',
    commit_sha: 'Commit (SHA)',
    under_warranty: 'Garantie',
    part_type: 'Art',
    kind: 'Art',
    schwere: 'Schwere',
    seite: 'Seite',
    reason: 'Grund',
    reference: 'Referenz',
    sequence: 'Reihenfolge',
    // Produkt
    uom_id: 'Einheit',
    purchase_uom_id: 'Einkaufseinheit',
    list_price: 'Verkaufspreis (netto)',
    standard_cost: 'Einstandspreis',
    weight_g: 'Gewicht (g)',
    gewicht_g: 'Gewicht (g)',
    can_be_sold: 'Verkaufbar',
    verkaufbar: 'Verkaufbar',
    can_be_purchased: 'Einkaufbar',
    einkaufbar: 'Einkaufbar',
    route_buy: 'Route: Einkaufen',
    route_manufacture: 'Route: Fertigen',
    route_mto: 'Route: Auf Bestellung (MTO)',
    sku: 'Artikelnummer (SKU)',
    barcode: 'Barcode',
    tracking: 'Nachverfolgung (Los/Serie)',
    category_id: 'Kategorie',
    sale_delay: 'Lieferzeit Verkauf (Tage)',
    hs_code: 'Zolltarifnummer (HS)',
    country_of_origin: 'Ursprungsland',
    sale_tax_id: 'Steuer Verkauf',
    purchase_tax_id: 'Steuer Einkauf',
    invoice_policy: 'Abrechnung Verkauf',
    bill_policy: 'Abrechnung Einkauf',
    description_sale: 'Belegtext Verkauf',
    description_purchase: 'Belegtext Einkauf',
    description_picking: 'Belegtext Lager',
    responsible_id: 'Verantwortlich',
    kleinpaket: 'Kleinpaket-tauglich',
    platzbedarf: 'Platzbedarf',
    shopify_variant_id: 'Shopify-Varianten-ID',
    attribute_id: 'Attribut',
    value_ids: 'Attributwerte',
    werte: 'Werte',
    template_id: 'Produktvorlage',
    // Lieferantenpreise
    preis: 'Preis (netto)',
    preis_id: 'Preiszeile',
    rabatt: 'Rabatt (%)',
    moq: 'Mindestmenge (MOQ)',
    lieferzeit_tage: 'Lieferzeit (Tage)',
    gueltig_von: 'Gültig von',
    gueltig_bis: 'Gültig bis',
    // Kontakte
    email: 'E-Mail',
    phone: 'Telefon',
    telefon: 'Telefon',
    mobile: 'Mobil',
    website: 'Webseite',
    street: 'Straße',
    street2: 'Adresszusatz',
    house_number: 'Hausnummer',
    zip: 'PLZ',
    city: 'Ort',
    country_code: 'Land (ISO)',
    vat: 'USt-IdNr.',
    ref: 'Interne Referenz',
    company_registry: 'Handelsregister',
    is_company: 'Firma',
    is_customer: 'Kunde',
    is_vendor: 'Lieferant',
    job_title: 'Funktion',
    partner_type: 'Art des Unterkontakts',
    customer_payment_term_id: 'Zahlungsbedingung (Verkauf)',
    supplier_payment_term_id: 'Zahlungsbedingung (Einkauf)',
    // Belege Verkauf/Einkauf
    price_unit: 'Preis je Einheit',
    discount: 'Rabatt (%)',
    line_id: 'Position',
    client_order_ref: 'Kundenreferenz',
    commitment_date: 'Zusagedatum',
    validity_date: 'Angebot gültig bis',
    incoterm_code: 'Incoterm',
    incoterm_location: 'Incoterm-Ort',
    payment_term_id: 'Zahlungsbedingung',
    priority: 'Dringend',
    receipt_reminder_email: 'Empfangserinnerung',
    reminder_date_before_receipt: 'Erinnerung (Tage vorher)',
    eta: 'ETA (geschätzt)',
    eta_bestaetigt: 'Vom Lieferanten bestätigt',
    carrier: 'Carrier',
    tracking_nummer: 'Tracking-Nummer',
    tracking_url: 'Tracking-Link',
    vendor_bill_reference: 'Rechnungsnr. des Lieferanten',
    payment_reference: 'Verwendungszweck',
    bill_date: 'Rechnungsdatum',
    checked: 'Geprüft',
    locked: 'Gesperrt',
    amount: 'Betrag',
    basis: 'Verteilung nach',
    cost_type: 'Kostenart',
    currency: 'Währung',
    is_estimate: 'Schätzung',
    rate: 'Kurs',
    valid_from: 'Gültig ab',
    // Lager
    counted_qty: 'Gezählte Menge',
    min_qty: 'Mindestbestand',
    max_qty: 'Maximalbestand',
    qty_multiple: 'Losgrößen-Vielfaches',
    route: 'Beschaffungsweg',
    tage: 'Tage',
    lose: 'Lose/Seriennummern',
    mengen: 'Ist-Mengen',
    // Fertigung
    backorder: 'Rückstand anlegen',
    capacity: 'Kapazität',
    cost_per_hour: 'Stundensatz (€/h)',
    time_efficiency: 'Leistung (%)',
    duration_minutes: 'Dauer (Minuten)',
    setup_minutes: 'Rüstzeit (Minuten)',
    work_center_id: 'Arbeitsplatz',
    operation_id: 'Arbeitsgang',
    employee_id: 'Mitarbeiter',
    minutes: 'Minuten',
    consumption: 'Verbrauchsprüfung',
    method: 'Entnahmeart',
    issue_method: 'Entnahmeart',
    force: 'Erzwingen',
    part_id: 'Teil',
    component_variant_id: 'Komponente',
    ptav_ids: 'Nur für Attributwerte',
    // Personal
    department: 'Abteilung',
    employment_type: 'Beschäftigungsart',
    hourly_cost: 'Personalkostensatz (€/h)',
    weekly_hours: 'Wochenstunden',
    vacation_days: 'Urlaubstage',
    hire_date: 'Eintritt',
    exit_date: 'Austritt',
    break_minutes: 'Pause (Minuten)',
    started_at: 'Beginn',
    ended_at: 'Ende',
    entry_id: 'Buchung',
    day: 'Tag',
    starts_on: 'Von',
    ends_on: 'Bis',
    half_day: 'Halber Tag',
    // Versand
    billing_number: 'Abrechnungsnummer',
    dhl_product: 'DHL-Produkt',
    insurance_from_value: 'Versichern ab Warenwert (€)',
    max_weight_g: 'Max. Gewicht (g)',
    min_weight_g: 'Min. Gewicht (g)',
    max_content_g: 'Max. Inhalt (g)',
    require_kleinpaket_fit: 'Nur Kleinpaket-taugliche',
    sku_scope: 'SKU-Filter',
    skus: 'Artikelnummern',
    zone: 'Zone',
    land: 'Land',
    produkt: 'Produkt',
    // System
    role: 'Rolle',
    password: 'Passwort',
    befugnisse: 'Befugnisse',
    prozess_code: 'Prozess',
    schritt_code: 'Schritt',
    paket_code: 'Paket',
    version: 'Version',
    code: 'Code',
    label: 'Beschriftung',
    bereich: 'Bereich',
    modell: 'Modell',
    typ: 'Typ',
    pflicht: 'Pflichtfeld',
    schritte: 'Schritte',
    uebergaenge: 'Übergänge',
    zusatz: 'Eigene Felder',
  }
  if (TEXTE[name]) return TEXTE[name]
  const roh = name.replace(/_id$/, '').replace(/_/g, ' ')
  return roh.charAt(0).toUpperCase() + roh.slice(1)
}

function feldTyp(name: string, s: z.ZodTypeAny): Pick<FormularFeld, 'typ' | 'auswahl' | 'quelle'> {
  if (VERWEIS_QUELLEN[name]) return { typ: 'verweis', quelle: VERWEIS_QUELLEN[name] }
  if (s instanceof z.ZodEnum) return { typ: 'auswahl', auswahl: [...(s.options as string[])] }
  if (s instanceof z.ZodBoolean) return { typ: 'schalter' }
  if (s instanceof z.ZodNumber) return { typ: 'nummer' }
  if (s instanceof z.ZodString) {
    const max = (s._def.checks as { kind: string; value?: number }[]).find(
      (c) => c.kind === 'max',
    )?.value
    return { typ: max !== undefined && max >= 1000 ? 'mehrzeilig' : 'text' }
  }
  // Records/Objekte/Arrays: generisch nur als JSON erfassbar (z. B. die
  // Ist-Mengen beim Reparaturabschluss — dafür bleibt die Fachmaske da).
  return { typ: 'json' }
}

export function formularFelder(aktion: RegistrierteAktion): FormularFeld[] {
  const objekt = kern(aktion.schema)
  if (!(objekt instanceof z.ZodObject)) return []

  return Object.entries(objekt.shape as Record<string, z.ZodTypeAny>).map(([name, roh]) => {
    const innen = kern(roh)
    const vorgabe =
      roh instanceof z.ZodDefault
        ? (roh._def.defaultValue as () => unknown)()
        : undefined
    return {
      name,
      label: roh.description ?? beschriftung(name),
      pflicht: !(roh instanceof z.ZodOptional) && !(roh instanceof z.ZodDefault),
      ...(vorgabe !== undefined ? { vorgabe } : {}),
      hinweis: roh.description,
      ...feldTyp(name, innen),
    }
  })
}
