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

  'verkauf.auftrag_fuer_neuen_kunden': {
    label: 'Auftrag für neuen Kunden',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Legt Kontakt UND Angebot in einem Zug an — für den häufigsten Fall am Telefon: ' +
      'der Kunde ist neu. Personen brauchen vorname und nachname, Firmen name mit ' +
      'is_company = true. Ist der Kunde schon angelegt, stattdessen auftrag_anlegen nutzen.',
    bindung: 'frei',
    modell: 'sales_order',
    uebergang: { von: [], nach: ['draft'] },
    // Alternativer Einstieg in denselben Prozessschritt „anlegen": der Beleg
    // landet in genau demselben Zustand (draft), nur entsteht der Kontakt
    // eine Zeile vorher. Deshalb kein eigener Schritt im Diagramm.
    prozessfrei: true,
    schema: z
      .object({
        name: z.string().max(200).optional(),
        vorname: z.string().max(100).optional(),
        nachname: z.string().max(100).optional(),
        is_company: z.boolean().default(false),
        email: z.string().max(200).optional(),
        phone: z.string().max(60).optional(),
        street: z.string().max(200).optional(),
        house_number: z.string().max(20).optional(),
        zip: z.string().max(20).optional(),
        city: z.string().max(100).optional(),
        country_code: z.string().max(2).default('DE'),
      })
      .refine((k) => (k.is_company ? Boolean(k.name?.trim()) : Boolean(k.nachname?.trim())), {
        message: 'Personen brauchen Vor- und Nachname, Firmen einen Firmennamen',
        path: ['nachname'],
      }),
    zusammenfassung: (p) =>
      `Neuer Kunde ${p.is_company ? (p.name ?? '') : `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim()}`,
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim() || undefined,
      vorname: String(fd.get('vorname') ?? '').trim() || undefined,
      nachname: String(fd.get('nachname') ?? '').trim() || undefined,
      is_company: fd.get('is_company') === 'on',
      email: String(fd.get('email') ?? '').trim() || undefined,
      phone: String(fd.get('phone') ?? '').trim() || undefined,
      street: String(fd.get('street') ?? '').trim() || undefined,
      house_number: String(fd.get('house_number') ?? '').trim() || undefined,
      zip: String(fd.get('zip') ?? '').trim() || undefined,
      city: String(fd.get('city') ?? '').trim() || undefined,
      country_code: String(fd.get('country_code') ?? 'DE'),
    }),
    revalidate: ['/verkauf', '/kontakte'],
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
    // Korrektur-Aktion, kein Prozessschritt: cancel → draft liefe dem
    // Ablauf entgegen (Schleifen sind im Prozessgraphen verboten).
    prozessfrei: true,
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
