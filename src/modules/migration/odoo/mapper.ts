/**
 * Reine Umformungen Odoo 18 → KRNL — ohne Datenbank, damit direkt testbar
 * (tests/odoo-import.test.ts). Alles, was der Importer an Odoo-Werten
 * anfasst, läuft durch diese Funktionen: Übersetzungs-jsonb, Einheiten-
 * Verhältnisse, Zustands-Karten, Shopify-GIDs, Kosten-Fallback,
 * Belegnummern-Parser.
 *
 * Grundsatz: Unbekannte Enum-Werte werfen einen Fehler, statt still auf
 * irgendetwas zu mappen — bei einer Datenübernahme ist ein lauter Abbruch
 * billiger als ein leiser Datenfehler.
 */

// --- Übersetzungen ----------------------------------------------------------

/**
 * Odoo 18 speichert übersetzbare Namen als jsonb `{"de_DE": …, "en_US": …}`.
 * Deutsch vor Englisch vor irgendetwas — manche Einträge (z. B. die
 * Einheit „g") tragen nur en_US.
 */
export function uebersetzung(wert: unknown, fallback = ''): string {
  if (typeof wert === 'string') return wert.trim() || fallback
  if (wert && typeof wert === 'object') {
    const karte = wert as Record<string, unknown>
    for (const schluessel of ['de_DE', 'en_US']) {
      const kandidat = karte[schluessel]
      if (typeof kandidat === 'string' && kandidat.trim()) return kandidat.trim()
    }
    for (const kandidat of Object.values(karte)) {
      if (typeof kandidat === 'string' && kandidat.trim()) return kandidat.trim()
    }
  }
  return fallback
}

// --- Einheiten --------------------------------------------------------------

/**
 * Odoo-`factor` ist „wie viele dieser Einheit ergeben eine Odoo-Referenz-
 * einheit" (Dutzend: 0,0833…; g: 1000 bei Referenz kg). KRNL-`ratio` ist
 * „wie viele KRNL-Referenzeinheiten ist EINE dieser Einheit". Da die
 * Referenzen abweichen können (KRNL-Gewichtsreferenz ist g, Odoos ist kg),
 * wird über die KRNL-ratio der Odoo-Referenz umgerechnet:
 *
 *   ratio = ratioDerOdooReferenzInKrnl / factor
 *
 * Beispiele: Dutzend (factor 0,0833…, Referenz Stück→ratio 1) → 12;
 * g (factor 1000, Referenz kg→KRNL-ratio 1000) → 1.
 */
export function uomRatio(factor: number, ratioDerOdooReferenzInKrnl: number): number {
  if (!(factor > 0)) throw new Error(`Odoo-UoM-factor muss > 0 sein, ist ${factor}`)
  if (!(ratioDerOdooReferenzInKrnl > 0)) {
    throw new Error(`KRNL-Referenz-ratio muss > 0 sein, ist ${ratioDerOdooReferenzInKrnl}`)
  }
  // Float-Artefakte glätten (1/0,0833… = 12,000000000000002).
  return Math.round((ratioDerOdooReferenzInKrnl / factor) * 1e6) / 1e6
}

// --- Shopify-GIDs -----------------------------------------------------------

/**
 * Odoo hält die Shopify-Schlüssel als nackte Zahlen (Studio-Feld bzw.
 * client_order_ref); KRNL speichert die GraphQL-GIDs — dieselbe Form, die
 * der laufende Shopify-Sync schreibt. Nur so erkennt er Bestandsdaten
 * wieder, statt Duplikate anzulegen.
 */
export function kundenGid(id: string | number): string {
  return `gid://shopify/Customer/${String(id).trim()}`
}

export function bestellGid(id: string | number): string {
  return `gid://shopify/Order/${String(id).trim()}`
}

/** Eine reine Ziffernfolge — so erkennen wir Shopify-Referenzen. */
export function istShopifyRef(wert: string | null | undefined): boolean {
  return /^\d{6,}$/.test((wert ?? '').trim())
}

// --- Skalar-Umformungen -----------------------------------------------------

/** Odoo wiegt in kg (numeric), KRNL in Gramm (int, DHL-tauglich). */
export function kgZuGramm(kg: number | null | undefined): number | null {
  if (kg === null || kg === undefined || Number.isNaN(kg)) return null
  if (kg === 0) return null
  return Math.round(kg * 1000)
}

/**
 * Odoo-HTML-Felder (comment, note, descriptions) → schlichter Text. Nimmt
 * auch Übersetzungs-jsonb entgegen (die Beschreibungsfelder sind in Odoo 18
 * übersetzbar). Kein vollwertiger Parser — Tags raus, die häufigsten
 * Entities, Whitespace zusammenfalten.
 */
export function htmlZuText(roh: unknown): string | null {
  const html = uebersetzung(roh, '')
  if (!html) return null
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
  return text || null
}

/**
 * Firmenabhängige Odoo-Werte (standard_price) liegen als jsonb
 * `{"1": 25.0}` vor — ANVIL hat genau eine Firma.
 */
export function firmenwert(wert: unknown): number | null {
  if (typeof wert === 'number') return wert
  if (wert && typeof wert === 'object') {
    for (const kandidat of Object.values(wert as Record<string, unknown>)) {
      if (typeof kandidat === 'number') return kandidat
    }
  }
  return null
}

/**
 * `x_studio_vorname` + Odoo-`name` → getrennte KRNL-Namensfelder (0068).
 * Beginnt der volle Name mit dem Vornamen, ist der Rest der Nachname;
 * sonst ist der volle Name der Nachname (Firmenkontakte tragen keinen
 * Vornamen und bleiben unangetastet).
 */
export function nameTeilen(
  name: string,
  vorname: string | null | undefined,
): { vorname: string | null; nachname: string | null } {
  const v = (vorname ?? '').trim()
  const n = name.trim()
  if (!v) return { vorname: null, nachname: null }
  if (n.toLowerCase().startsWith(`${v.toLowerCase()} `)) {
    return { vorname: v, nachname: n.slice(v.length).trim() || null }
  }
  return { vorname: v, nachname: n || null }
}

// --- Zustands-Karten --------------------------------------------------------

function enumKarte<Z extends string>(
  name: string,
  karte: Record<string, Z>,
): (wert: string | null | undefined) => Z {
  return (wert) => {
    const ziel = karte[(wert ?? '').trim()]
    if (ziel === undefined) {
      throw new Error(`Unbekannter Odoo-Wert für ${name}: „${wert}"`)
    }
    return ziel
  }
}

/** sale.order.state — KRNL ist als Odoo-Nachbau gebaut, die Enums decken sich. */
export const saleState = enumKarte('sale_state', {
  draft: 'draft',
  sent: 'sent',
  sale: 'sale',
  cancel: 'cancel',
} as const)

export const purchaseState = enumKarte('purchase_state', {
  draft: 'draft',
  sent: 'sent',
  purchase: 'purchase',
  done: 'done',
  cancel: 'cancel',
} as const)

/** Odoo schreibt „to invoice" mit Leerzeichen, das KRNL-Enum mit Unterstrich. */
export const invoiceStatus = enumKarte('invoice_status', {
  no: 'no',
  'to invoice': 'to_invoice',
  invoiced: 'invoiced',
  upselling: 'upselling',
} as const)

/** Einkaufsseitig heißt dieselbe Odoo-Spalte in KRNL billing_status. */
export const billingStatus = enumKarte('billing_status', {
  no: 'nothing',
  'to invoice': 'waiting',
  invoiced: 'fully_billed',
} as const)

export const moState = enumKarte('mo_state', {
  draft: 'draft',
  confirmed: 'confirmed',
  progress: 'progress',
  to_close: 'to_close',
  done: 'done',
  cancel: 'cancel',
} as const)

export const repairState = enumKarte('repair_state', {
  draft: 'new',
  confirmed: 'confirmed',
  under_repair: 'under_repair',
  done: 'repaired',
  cancel: 'cancel',
} as const)

export const billState = enumKarte('bill_state', {
  draft: 'draft',
  posted: 'posted',
  cancel: 'cancel',
} as const)

/** Odoo-payment_state der Rechnung: bezahlt ist bezahlt, auch „in Zahlung". */
export function billBezahlt(paymentState: string | null | undefined): boolean {
  return paymentState === 'paid' || paymentState === 'in_payment'
}

export const bomTyp = enumKarte('bom_type', {
  normal: 'manufacture',
  phantom: 'kit',
} as const)

export const bomVerbrauch = enumKarte('consumption', {
  strict: 'blocked',
  flexible: 'allowed',
  warning: 'warning',
} as const)

export const attributAnzeige = enumKarte('display_type', {
  select: 'select',
  radio: 'radio',
  color: 'color',
  pills: 'pills',
  multi: 'select',
} as const)

/**
 * Odoo kennt drei Fälligkeits-Anker, KRNL zwei — die beiden
 * Monatsende-Varianten fallen auf days_after_end_of_month zusammen
 * (Näherung, im Report ausgewiesen).
 */
export const faelligkeitsTyp = enumKarte('delay_type', {
  days_after: 'days_after',
  days_end_of_month_on_the: 'days_after_end_of_month',
  days_after_end_of_next_month: 'days_after_end_of_month',
} as const)

// --- Varianten-Matching -----------------------------------------------------

/**
 * Schlüssel einer Variante über die Menge ihrer Attributwerte —
 * reihenfolge- und schreibweisen-unabhängig (Muster: ordneVariantenZu in
 * integrationen/produkt-import-logik.ts). Beide Seiten (KRNL-Varianten
 * nach generate_variants, Odoo-Kombinationen) werden über denselben
 * Schlüssel verbunden.
 */
export function variantenSchluessel(werte: { attribut: string; wert: string }[]): string {
  const norm = (s: string) => s.trim().toLowerCase()
  return werte
    .map((w) => `${norm(w.attribut)}=${norm(w.wert)}`)
    .sort()
    .join('|')
}

// --- Kostenherleitung -------------------------------------------------------

export interface KostenQuellen {
  /** Restwert/Restmenge der Odoo-Wertschichten (beste Quelle). */
  layer: number | null
  /** product_product.standard_price (nur bei ~42/506 Varianten gepflegt). */
  standardPreis: number | null
  /** Jüngster Lieferantenpreis (währungsbereinigt angeliefert). */
  lieferant: number | null
}

/**
 * Odoo bewertet nach Standardpreis und pflegt ihn lückenhaft — deshalb die
 * Kette: echter Schichten-Restwert → gepflegter Standardpreis → jüngster
 * Einkaufspreis → 0 (Pflichtposten auf der Warnliste, sonst rechnet die
 * Marge mit Phantasie).
 */
export function kostenAuswahl(q: KostenQuellen): {
  wert: number
  quelle: 'layer' | 'standardpreis' | 'lieferant' | 'keine'
} {
  if (q.layer !== null && q.layer > 0) return { wert: runde2(q.layer), quelle: 'layer' }
  if (q.standardPreis !== null && q.standardPreis > 0) {
    return { wert: runde2(q.standardPreis), quelle: 'standardpreis' }
  }
  if (q.lieferant !== null && q.lieferant > 0) {
    return { wert: runde2(q.lieferant), quelle: 'lieferant' }
  }
  return { wert: 0, quelle: 'keine' }
}

function runde2(n: number): number {
  return Math.round(n * 100) / 100
}

// --- Belegnummern -----------------------------------------------------------

/**
 * Höchste laufende Nummer eines Kreises in den übernommenen Belegnummern —
 * für den Sequenz-Restart nach dem Import (sonst kollidiert der erste neue
 * Beleg mit einer Odoo-Nummer). Nicht passende Nummern werden ignoriert.
 */
export function nummernMaximum(nummern: (string | null)[], praefix: string): number {
  const muster = new RegExp(`^${praefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\d+)$`)
  let max = 0
  for (const nummer of nummern) {
    const treffer = (nummer ?? '').match(muster)
    if (treffer) max = Math.max(max, Number(treffer[1]))
  }
  return max
}
