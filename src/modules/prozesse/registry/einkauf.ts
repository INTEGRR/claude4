import { z } from 'zod'
import { positionenSchema, type PositionsZeile, type RegistrierteAktion } from './typen.ts'
import { plural } from '../../shared/format.ts'

const DATUM = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT')

/**
 * Position eines Belegs (Commercial Invoice, Pro-forma): entweder ein
 * vorhandener Artikel (`produkt`) oder ein neues Kaufteil (`artikel_neu`,
 * optional `sku_neu`). Flach gehalten, damit der Vorschlagseditor im KI-Chat
 * sie als Tabelle mit editierbaren Zellen zeigt.
 */
export const belegPositionSchema = z.object({
  produkt: z.string().max(200).optional().describe('SKU, Barcode, Name oder ID eines VORHANDENEN Artikels'),
  artikel_neu: z.string().max(200).optional().describe('Name eines NEUEN Kaufteils — wenn produkt fehlt'),
  sku_neu: z.string().max(60).optional().describe('Artikelnummer des neuen Kaufteils'),
  menge: z.number().positive(),
  preis: z.number().nonnegative().optional().describe('Netto je Einheit in der Belegwährung'),
})
export type BelegPosition = z.infer<typeof belegPositionSchema>

/** Jede Zeile braucht genau einen Weg zum Artikel — die Meldung nennt die Zeile. */
export function belegPositionenPruefen(positionen: BelegPosition[]): string | null {
  for (const [i, pos] of positionen.entries()) {
    const produkt = pos.produkt?.trim()
    const neu = pos.artikel_neu?.trim()
    if (!produkt && !neu) return `Position ${i + 1}: produkt (vorhanden) oder artikel_neu (anlegen) angeben`
    if (produkt && neu) return `Position ${i + 1}: entweder produkt oder artikel_neu — nicht beides`
  }
  return null
}

export const belegBestellungSchema = z.object({
  lieferant: z.string().min(1).max(200).describe('Name, Referenz oder ID des Lieferanten; mit lieferant_neu der Name des neuen'),
  lieferant_neu: z.boolean().default(false).describe('Lieferanten anlegen, wenn es ihn noch nicht gibt'),
  lieferant_land: z.string().length(2).optional().describe('Land des neuen Lieferanten, ISO-2 (z. B. CN)'),
  lieferant_email: z.string().email().max(200).optional(),
  positionen: z.array(belegPositionSchema).min(1).max(50),
  waehrung: z.string().length(3).default('EUR').describe('ISO-Code der Belegwährung, z. B. USD'),
  incoterm_code: z.string().max(10).optional().describe('z. B. DDP, FOB, EXW'),
  referenz: z.string().max(80).optional().describe('Belegnummer des Lieferanten (Rechnung, PI)'),
  bestelldatum: DATUM.optional(),
  eta: DATUM.optional().describe('Erwartete Ankunft'),
  versandkosten: z.number().nonnegative().optional().describe('Fracht laut Beleg in der Belegwährung — wird eine Dienstleistungszeile'),
  hinweis: z.string().max(500).optional(),
  bestaetigen: z.boolean().default(true).describe('Gleich bestätigen — die Ware ist bestellt, der Wareneingang wird erwartet'),
  bezahlt: z.boolean().default(false).describe('Schon bezahlt — Vorkasse 100 % wird als bezahlt vermerkt'),
  bezahlt_betrag: z.number().positive().optional().describe('Gezahlter Betrag in der Belegwährung (leer = Bestellsumme)'),
  bezahlt_am: DATUM.optional(),
  beleg_art: z.enum(['ci', 'pi', 'rechnung', 'sonstiges']).optional().describe('Art des angehängten Belegs: ci = Commercial Invoice, pi = Pro-forma'),
})
export type BelegBestellung = z.infer<typeof belegBestellungSchema>

/**
 * Aktionen des Einkaufs: Bestellung, Lieferantenrechnung,
 * Einstandsnebenkosten und Wechselkurse. Die Statusübergänge stehen auf
 * der Restliste des Vollständigkeitstests, bis der Einkaufsprozess
 * (P6: Bestellung → Wareneingang → Rechnung) gesät ist.
 */
export const EINKAUF = {
  'einkauf.bestellung_anlegen': {
    label: 'Bestellung anlegen',
    bereich: 'einkauf',
    beschreibung: 'Legt eine Bestellung bei einem Lieferanten an (Entwurf).',
    bindung: 'frei',
    modell: 'purchase_order',
    uebergang: { von: [], nach: ['draft'] },
    schema: z.object({
      vendor_id: z.string().min(1, 'Bitte einen Lieferanten auswählen'),
    }),
    formdata: (fd) => ({ vendor_id: String(fd.get('vendor_id') ?? '') }),
    revalidate: ['/einkauf'],
  },

  'einkauf.bestellung_mit_positionen': {
    label: 'Bestellung mit Positionen anlegen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Legt eine Bestellung (Entwurf) bei einem BESTEHENDEN Lieferanten samt Positionen ' +
      'in einem Zug an. lieferant nimmt Name, Referenz oder ID; jede Position: produkt ' +
      '(SKU, Barcode, Name oder ID), menge, optional preis (netto je Einheit, leer = ' +
      'Lieferantenpreisliste bzw. Standardkosten). Wird nicht bestätigt.',
    bindung: 'frei',
    modell: 'purchase_order',
    uebergang: { von: [], nach: ['draft'] },
    // Alternativer Einstieg in denselben Zustand (draft) wie
    // bestellung_anlegen — deshalb kein eigener Prozessschritt.
    prozessfrei: true,
    schema: z.object({
      lieferant: z.string().min(1).describe('Name, Referenz oder ID eines vorhandenen Lieferanten'),
      positionen: z.array(positionenSchema).min(1).max(50),
      hinweis: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      `Bestellung bei ${p.lieferant} mit ${plural(p.positionen.length, 'Position', 'Positionen')}: ` +
      p.positionen.map((pos: PositionsZeile) => `${pos.menge} × ${pos.produkt}`).join(', '),
    revalidate: ['/einkauf'],
  },

  'einkauf.bestellung_erfassen': {
    label: 'Bestellung aus Beleg erfassen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Erfasst eine bereits außerhalb getätigte Bestellung aus einem Beleg (Commercial Invoice, ' +
      'Pro-forma, Auftragsbestätigung) in EINEM Zug. lieferant: Name/Referenz/ID — oder mit ' +
      'lieferant_neu = true neu anlegen (dann lieferant_land ISO-2, optional lieferant_email). ' +
      'positionen je Zeile: produkt (SKU/Barcode/Name/ID eines vorhandenen Artikels) ODER ' +
      'artikel_neu (Name eines neuen Kaufteils) + sku_neu; menge; preis netto je Einheit in der ' +
      'Belegwährung. waehrung (ISO, z. B. USD), incoterm_code (DDP, FOB …), referenz = Belegnummer, ' +
      'versandkosten = Fracht laut Beleg (Dienstleistungszeile), eta. bestaetigen = true bestätigt ' +
      'sofort (Wareneingang wird erwartet); bezahlt = true vermerkt Vorkasse 100 % als bezahlt ' +
      '(bezahlt_betrag in Belegwährung, bezahlt_am). beleg_art benennt den Anhang (ci, pi, rechnung). ' +
      'Beträge bleiben in der Belegwährung — nichts in Euro umrechnen.',
    bindung: 'frei',
    modell: 'purchase_order',
    uebergang: { von: [], nach: ['draft', 'purchase'] },
    // Alternativer Einstieg wie bestellung_mit_positionen: die nachträgliche
    // Erfassung einer Bestellung, die außerhalb von KRNL schon lief (Beleg
    // im KI-Chat). Landet je nach `bestaetigen` in draft oder purchase —
    // deshalb kein eigener Prozessschritt (Entscheidungslog 2026-10-15).
    prozessfrei: true,
    schema: belegBestellungSchema,
    zusammenfassung: (p) =>
      `Bestellung bei ${p.lieferant}${p.lieferant_neu ? ' (neu)' : ''} in ${p.waehrung}` +
      `${p.referenz ? `, Beleg ${p.referenz}` : ''}: ` +
      p.positionen
        .map((pos: BelegPosition) => `${pos.menge} × ${pos.produkt?.trim() || `${pos.artikel_neu ?? '?'} (neu)`}`)
        .join(', ') +
      (p.versandkosten ? ` + Fracht ${p.versandkosten}` : '') +
      (p.bestaetigen ? ' — bestätigt' : ' — Entwurf') +
      (p.bezahlt ? `, bezahlt${p.bezahlt_betrag ? ` ${p.bezahlt_betrag} ${p.waehrung}` : ''}` : ''),
    revalidate: ['/einkauf', '/lager/zulauf', '/finanzen'],
  },

  'einkauf.position_hinzufuegen': {
    label: 'Position hinzufügen',
    bereich: 'einkauf',
    beschreibung:
      'Nimmt ein Produkt in die Bestellung auf — Preis und Rabatt aus der Lieferantenpreisliste, überschreibbar.',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
      price_unit: z.number().optional(),
      discount: z.number().optional(),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
      price_unit:
        fd.get('price_unit') !== null && fd.get('price_unit') !== ''
          ? Number(fd.get('price_unit'))
          : undefined,
      discount:
        fd.get('discount') !== null && fd.get('discount') !== ''
          ? Number(fd.get('discount'))
          : undefined,
    }),
    revalidate: ['/einkauf/:id'],
  },

  'einkauf.position_entfernen': {
    label: 'Position entfernen',
    bereich: 'einkauf',
    beschreibung: 'Entfernt eine Bestellzeile (nur im Entwurf).',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({ line_id: z.string().min(1) }),
    revalidate: ['/einkauf/:id'],
  },

  'einkauf.kopf_aendern': {
    label: 'Kopffelder ändern',
    bereich: 'einkauf',
    beschreibung:
      'Einkäufer, Zahlungsbedingung, Incoterm, Priorität, Wareneingangs-Erinnerung — und der ' +
      'Liefertermin: ETA (Schätzung), vom Lieferanten bestätigter Termin sowie Carrier und ' +
      'Tracking. Termine wandern automatisch an die offenen Wareneingangs-Transfers.',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({
      user_id: z.string().optional(),
      payment_term_id: z.string().optional(),
      incoterm_code: z.string().max(10).optional(),
      priority: z.boolean().default(false),
      receipt_reminder_email: z.boolean().default(false),
      reminder_date_before_receipt: z.number().int().min(0).max(60).default(1),
      eta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      eta_bestaetigt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      carrier: z.string().max(60).optional(),
      tracking_nummer: z.string().max(120).optional(),
      tracking_url: z.string().max(400).optional(),
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      payment_term_id: String(fd.get('payment_term_id') ?? '') || undefined,
      incoterm_code: String(fd.get('incoterm_code') ?? '') || undefined,
      priority: fd.get('priority') === 'on',
      receipt_reminder_email: fd.get('receipt_reminder_email') === 'on',
      reminder_date_before_receipt: Number(fd.get('reminder_date_before_receipt') ?? 1),
      eta: String(fd.get('eta') ?? '') || undefined,
      eta_bestaetigt: String(fd.get('eta_bestaetigt') ?? '') || undefined,
      carrier: String(fd.get('carrier') ?? '').trim() || undefined,
      tracking_nummer: String(fd.get('tracking_nummer') ?? '').trim() || undefined,
      tracking_url: String(fd.get('tracking_url') ?? '').trim() || undefined,
    }),
    revalidate: ['/einkauf/:id', '/lager/zulauf'],
  },

  'einkauf.zulauf_verfolgen': {
    label: 'Sendung jetzt abfragen',
    bereich: 'einkauf',
    ki: true,
    beschreibung:
      'Fragt den Stand der Zulauf-Sendung (Carrier + Tracking-Nummer der Bestellung) sofort bei 17TRACK ab — ' +
      'meldet sie notfalls erst an. Sonst kommen Statuswechsel per Webhook und stündlichem Abruf; ' +
      '„zuletzt abgefragt" steht an der Sendung.',
    bindung: 'beleg',
    modell: 'purchase_order',
    // Ein Abfragewerkzeug ohne Zustandswechsel der Bestellung (wie versand.adresse_pruefen).
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/einkauf/:id', '/lager/zulauf'],
  },

  'einkauf.bestellung_freigeben': {
    label: 'Bestellung freigeben',
    bereich: 'einkauf',
    beschreibung:
      'Gibt eine offene Bestellung frei. Über dem Freigabe-Limit (Einstellungen) lässt sich ' +
      'ohne diese Freigabe nicht bestellen; Positionsänderungen lassen sie erlöschen. Wer ' +
      'freigeben darf, bestimmt die Befugnis „Bestellungen freigeben" am Prozessschritt.',
    bindung: 'beleg',
    modell: 'purchase_order',
    schema: z.object({}),
    revalidate: ['/einkauf/:id', '/einkauf'],
  },

  'einkauf.bestaetigen': {
    label: 'Bestellung bestätigen',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Bestätigt die Bestellung — der Wareneingang entsteht.',
    bindung: 'beleg',
    modell: 'purchase_order',
    uebergang: { von: ['draft', 'sent'], nach: ['purchase'] },
    schema: z.object({}),
    revalidate: ['/einkauf/:id', '/einkauf', '/lager'],
  },

  'einkauf.stornieren': {
    label: 'Bestellung stornieren',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Storniert die Bestellung samt offener Wareneingänge.',
    bindung: 'beleg',
    modell: 'purchase_order',
    uebergang: { von: ['draft', 'sent', 'purchase'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/einkauf/:id'],
  },

  'einkauf.sperren': {
    label: 'Sperren/Entsperren',
    bereich: 'einkauf',
    beschreibung: 'Sperrt eine bestätigte Bestellung gegen Änderungen (oder gibt sie frei).',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({ locked: z.boolean() }),
    zusammenfassung: (p) => (p.locked ? 'sperren' : 'entsperren'),
    revalidate: ['/einkauf/:id'],
  },

  'einkauf.email_senden': {
    label: 'Per E-Mail senden',
    bereich: 'einkauf',
    beschreibung:
      'Stellt die Bestellung als E-Mail mit Positionsliste in die Outbox (Adresse aus dem Lieferantenkontakt).',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/einkauf/:id'],
  },

  // --- Lieferantenrechnungen ----------------------------------------------

  'einkauf.rechnung_erstellen': {
    label: 'Rechnung erstellen',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Erzeugt die Lieferantenrechnung aus der Bestellung (Entwurf).',
    bindung: 'beleg',
    modell: 'purchase_order',
    schema: z.object({}),
    revalidate: ['/einkauf/:id', '/einkauf/rechnungen'],
  },

  'einkauf.rechnung_details': {
    label: 'Rechnungsdaten ändern',
    bereich: 'einkauf',
    beschreibung: 'Rechnungsdatum, Lieferantenreferenz, Zahlungsbedingung, Zahlungsreferenz (nur im Entwurf).',
    bindung: 'beleg',
    modell: 'vendor_bill',
    prozessfrei: true,
    schema: z.object({
      bill_date: z.string().optional(),
      vendor_bill_reference: z.string().max(100).optional(),
      payment_term_id: z.string().optional(),
      payment_reference: z.string().max(100).optional(),
    }),
    formdata: (fd) => ({
      bill_date: String(fd.get('bill_date') ?? '') || undefined,
      vendor_bill_reference: String(fd.get('vendor_bill_reference') ?? '') || undefined,
      payment_term_id: String(fd.get('payment_term_id') ?? '') || undefined,
      payment_reference: String(fd.get('payment_reference') ?? '').trim() || undefined,
    }),
    revalidate: ['/einkauf/rechnungen/:id'],
  },

  'einkauf.rechnung_pruefen': {
    label: 'Als geprüft markieren',
    bereich: 'einkauf',
    beschreibung: 'Setzt oder entfernt das Prüf-Flag der Rechnung.',
    bindung: 'beleg',
    modell: 'vendor_bill',
    prozessfrei: true,
    schema: z.object({ checked: z.boolean() }),
    revalidate: ['/einkauf/rechnungen/:id'],
  },

  'einkauf.rechnung_buchen': {
    label: 'Rechnung buchen',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Bucht die Rechnung (Abgleich gegen Wareneingang nach Einstellung).',
    bindung: 'beleg',
    modell: 'vendor_bill',
    uebergang: { von: ['draft'], nach: ['posted'] },
    schema: z.object({}),
    revalidate: ['/einkauf/rechnungen/:id'],
  },

  'einkauf.rechnung_zahlen': {
    label: 'Als bezahlt markieren',
    bereich: 'einkauf',
    ki: true,
    beschreibung: 'Markiert die gebuchte Rechnung als bezahlt.',
    bindung: 'beleg',
    modell: 'vendor_bill',
    uebergang: { von: ['posted'], nach: ['paid'] },
    schema: z.object({}),
    revalidate: ['/einkauf/rechnungen/:id'],
  },

  'einkauf.rechnung_stornieren': {
    label: 'Rechnung stornieren',
    bereich: 'einkauf',
    beschreibung: 'Storniert die Rechnung; gebuchte Rechnungen bekommen eine Stornorechnung.',
    bindung: 'beleg',
    modell: 'vendor_bill',
    uebergang: { von: ['draft', 'posted'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/einkauf/rechnungen/:id', '/einkauf/rechnungen'],
  },

  // --- Einstandsnebenkosten + Kurse ----------------------------------------

  'einkauf.nebenkosten_erfassen': {
    label: 'Nebenkosten erfassen',
    bereich: 'einkauf',
    beschreibung:
      'Erfasst Einstandsnebenkosten (Fracht, Zoll, …) an einem Wareneingang — Verteilung nach Basis.',
    bindung: 'beleg',
    modell: 'stock_picking',
    prozessfrei: true,
    schema: z.object({
      amount: z.number().positive('Bitte einen Betrag größer als 0 angeben'),
      currency: z.string().max(3).default('EUR'),
      cost_type: z.string().default('freight'),
      basis: z.string().default('weight'),
      is_estimate: z.boolean().default(false),
      vendor_id: z.string().optional(),
      note: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      amount: Number(fd.get('amount') ?? 0),
      currency: String(fd.get('currency') ?? 'EUR'),
      cost_type: String(fd.get('cost_type') ?? 'freight'),
      basis: String(fd.get('basis') ?? 'weight'),
      is_estimate: fd.get('is_estimate') === 'on',
      vendor_id: String(fd.get('vendor_id') ?? '') || undefined,
      note: String(fd.get('note') ?? '').trim() || undefined,
    }),
    revalidate: ['/lager/:id'],
  },

  'einkauf.nebenkosten_buchen': {
    label: 'Nebenkosten buchen',
    bereich: 'einkauf',
    beschreibung: 'Bucht die Nebenkosten auf die Wertschichten des Wareneingangs.',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager', '/lager/bewertung'],
  },

  'einkauf.nebenkosten_stornieren': {
    label: 'Nebenkosten stornieren',
    bereich: 'einkauf',
    beschreibung: 'Storniert gebuchte Nebenkosten (Gegenbuchung auf den Wertschichten).',
    bindung: 'beleg',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/lager', '/lager/bewertung'],
  },

  'einkauf.wechselkurs_erfassen': {
    label: 'Wechselkurs erfassen',
    bereich: 'einkauf',
    beschreibung: 'Erfasst einen Wechselkurs von Hand (1 Fremdwährung = Kurs Hauswährung).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      currency: z.string().min(3, 'Bitte Währung angeben').max(3),
      rate: z.number().positive('Bitte einen Kurs größer als 0 angeben'),
      valid_from: z.string().optional(),
    }),
    formdata: (fd) => ({
      currency: String(fd.get('currency') ?? ''),
      rate: Number(fd.get('rate') ?? 0),
      valid_from: String(fd.get('valid_from') ?? '') || undefined,
    }),
    revalidate: ['/einkauf/kurse'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
