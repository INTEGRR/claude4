import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

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
    beschreibung: 'Einkäufer, Zahlungsbedingung, Incoterm, Priorität und Wareneingangs-Erinnerung.',
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
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      payment_term_id: String(fd.get('payment_term_id') ?? '') || undefined,
      incoterm_code: String(fd.get('incoterm_code') ?? '') || undefined,
      priority: fd.get('priority') === 'on',
      receipt_reminder_email: fd.get('receipt_reminder_email') === 'on',
      reminder_date_before_receipt: Number(fd.get('reminder_date_before_receipt') ?? 1),
    }),
    revalidate: ['/einkauf/:id'],
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
