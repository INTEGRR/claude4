import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen des Verkaufs. Der Shop-Weg läuft über P4
 * (shopify_bestellung_versand); die Aktionen hier tragen den MANUELLEN
 * Verkauf — ein eigener Prozess dafür folgt, bis dahin stehen die
 * Statusübergänge auf der Restliste des Vollständigkeitstests.
 */
export const VERKAUF = {
  'verkauf.auftrag_anlegen': {
    label: 'Angebot anlegen',
    bereich: 'verkauf',
    beschreibung:
      'Legt ein Angebot für einen Kunden an (Status draft); die Lieferadresse wird aus dem Kontakt vorbelegt.',
    bindung: 'frei',
    modell: 'sales_order',
    uebergang: { von: [], nach: ['draft'] },
    schema: z.object({
      partner_id: z.string().min(1, 'Bitte einen Kunden auswählen'),
    }),
    formdata: (fd) => ({ partner_id: String(fd.get('partner_id') ?? '') }),
    revalidate: ['/verkauf'],
  },

  'verkauf.bestaetigen': {
    label: 'Auftrag bestätigen',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Bestätigt das Angebot: Steuer-Schnappschuss, Lieferung entsteht (Kits werden aufgelöst), MTO legt Fertigungsaufträge an.',
    bindung: 'beleg',
    modell: 'sales_order',
    uebergang: { von: ['draft', 'sent'], nach: ['sale'] },
    schema: z.object({}),
    revalidate: ['/verkauf/:id', '/verkauf', '/lager'],
  },

  'verkauf.stornieren': {
    label: 'Auftrag stornieren',
    bereich: 'verkauf',
    ki: true,
    beschreibung: 'Storniert den Auftrag samt offener Lieferungen (nach den Storno-Regeln).',
    bindung: 'beleg',
    modell: 'sales_order',
    uebergang: { von: ['draft', 'sent', 'sale'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/verkauf/:id', '/verkauf'],
  },

  'verkauf.zurueck_auf_angebot': {
    label: 'Auf Angebot zurücksetzen',
    bereich: 'verkauf',
    beschreibung: 'Holt einen stornierten/versendeten Beleg zurück in den Entwurf.',
    bindung: 'beleg',
    modell: 'sales_order',
    uebergang: { von: ['cancel', 'sent'], nach: ['draft'] },
    schema: z.object({}),
    revalidate: ['/verkauf/:id'],
  },

  'verkauf.kopf_aendern': {
    label: 'Kopffelder ändern',
    bereich: 'verkauf',
    beschreibung:
      'Verkäufer, Kundenreferenz, Termine, Zahlungsbedingung und Incoterm — nur solange der Auftrag nicht gesperrt ist.',
    bindung: 'beleg',
    modell: 'sales_order',
    prozessfrei: true,
    schema: z.object({
      user_id: z.string().optional(),
      client_order_ref: z.string().max(100).optional(),
      commitment_date: z.string().optional(),
      validity_date: z.string().optional(),
      payment_term_id: z.string().optional(),
      incoterm_code: z.string().max(10).optional(),
      incoterm_location: z.string().max(100).optional(),
    }),
    formdata: (fd) => ({
      user_id: String(fd.get('user_id') ?? '') || undefined,
      client_order_ref: String(fd.get('client_order_ref') ?? '').trim() || undefined,
      commitment_date: String(fd.get('commitment_date') ?? '') || undefined,
      validity_date: String(fd.get('validity_date') ?? '') || undefined,
      payment_term_id: String(fd.get('payment_term_id') ?? '') || undefined,
      incoterm_code: String(fd.get('incoterm_code') ?? '') || undefined,
      incoterm_location: String(fd.get('incoterm_location') ?? '').trim() || undefined,
    }),
    revalidate: ['/verkauf/:id'],
  },

  'verkauf.sperren': {
    label: 'Sperren/Entsperren',
    bereich: 'verkauf',
    beschreibung: 'Sperrt einen bestätigten Auftrag gegen Änderungen (oder gibt ihn wieder frei).',
    bindung: 'beleg',
    modell: 'sales_order',
    prozessfrei: true,
    schema: z.object({ locked: z.boolean() }),
    zusammenfassung: (p) => (p.locked ? 'sperren' : 'entsperren'),
    revalidate: ['/verkauf/:id'],
  },

  'verkauf.position_hinzufuegen': {
    label: 'Position hinzufügen',
    bereich: 'verkauf',
    beschreibung: 'Nimmt ein Produkt in den Beleg auf (Preis aus der Liste, überschreibbar).',
    bindung: 'beleg',
    modell: 'sales_order',
    prozessfrei: true,
    schema: z.object({
      variant_id: z.string().min(1, 'Bitte ein Produkt auswählen'),
      qty: z.number().positive('Die Menge muss größer als 0 sein'),
      price_unit: z.number().optional(),
    }),
    formdata: (fd) => ({
      variant_id: String(fd.get('variant_id') ?? ''),
      qty: Number(fd.get('qty') ?? 0),
      price_unit:
        fd.get('price_unit') !== null && fd.get('price_unit') !== ''
          ? Number(fd.get('price_unit'))
          : undefined,
    }),
    revalidate: ['/verkauf/:id'],
  },

  'verkauf.position_entfernen': {
    label: 'Position entfernen',
    bereich: 'verkauf',
    beschreibung: 'Entfernt eine Belegzeile (nur im Entwurf).',
    bindung: 'beleg',
    modell: 'sales_order',
    prozessfrei: true,
    schema: z.object({ line_id: z.string().min(1) }),
    revalidate: ['/verkauf/:id'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
