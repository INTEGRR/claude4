import { z } from 'zod'
import { positionenSchema, type PositionsZeile, type RegistrierteAktion } from './typen.ts'
import { plural } from '../../shared/format.ts'

const DATUM = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT')

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

  'verkauf.auftrag_mit_positionen': {
    label: 'Auftrag mit Positionen anlegen',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Legt ein Angebot (Entwurf) für einen BESTEHENDEN Kunden samt Positionen in einem ' +
      'Zug an. kunde nimmt Name, Referenz oder ID; jede Position: produkt (SKU, Barcode, ' +
      'Name oder ID), menge, optional preis (netto je Einheit, leer = Listenpreis). Der ' +
      'Auftrag wird NICHT bestätigt — das bleibt ein bewusster Schritt in der Oberfläche.',
    bindung: 'frei',
    modell: 'sales_order',
    uebergang: { von: [], nach: ['draft'] },
    // Wie auftrag_fuer_neuen_kunden: alternativer Einstieg in denselben
    // Zustand (draft), deshalb kein eigener Prozessschritt.
    prozessfrei: true,
    schema: z.object({
      kunde: z.string().min(1).describe('Name, Referenz oder ID eines vorhandenen Kunden'),
      positionen: z.array(positionenSchema).min(1).max(50),
      hinweis: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      `Angebot für ${p.kunde} mit ${plural(p.positionen.length, 'Position', 'Positionen')}: ` +
      p.positionen.map((pos: PositionsZeile) => `${pos.menge} × ${pos.produkt}`).join(', '),
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
    beschreibung:
      'Storniert einen Auftrag, der NICHT aus dem Shop kommt, samt offener Lieferungen, nicht begonnener ' +
      'Fertigung und DHL-Labels. Shop-Aufträge storniert Shopify (im Shopify-Admin, mit Erstattung) — ' +
      'KRNL zieht dann automatisch nach.',
    bindung: 'beleg',
    modell: 'sales_order',
    uebergang: { von: ['draft', 'sent', 'sale'], nach: ['cancel'] },
    schema: z.object({}),
    revalidate: ['/verkauf/:id', '/verkauf'],
  },

  'verkauf.zurueck_auf_angebot': {
    label: 'Auf Angebot zurücksetzen',
    bereich: 'verkauf',
    beschreibung: 'Holt einen stornierten/versendeten Beleg zurück in den Entwurf (nicht für Shop-Aufträge — Shopify führt).',
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

  // --- Kundenrechnungen (0115, Entscheidungslog 2026-10-16) -----------------
  // Die Rechnung entsteht mit der Lieferung (Trigger, settings.rechnung.
  // automatisch) — der Knopf ist der Weg von Hand, wenn die Automatik aus
  // ist oder eine Lieferung nachgerechnet werden muss.

  'verkauf.rechnung_erstellen': {
    label: 'Rechnung aus Lieferung erstellen',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Erzeugt die Kundenrechnung zu einer gebuchten Lieferung (Warenausgang eines Verkaufsauftrags): ' +
      'gelieferte Mengen zu den Auftragspreisen, Versand einmal je Auftrag; Shop-Aufträge gelten als ' +
      'bezahlt. Mit eingeschalteter Automatik passiert das bei jeder Lieferung von selbst. Beleg = die Lieferung.',
    bindung: 'beleg',
    modell: 'stock_picking',
    schema: z.object({}),
    revalidate: ['/verkauf/rechnungen', '/verkauf/:id', '/lager/:id'],
  },

  'verkauf.rechnung_zahlen': {
    label: 'Zahlung erfassen',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Erfasst den Zahlungseingang zu einer Kundenrechnung (bzw. die Erstattung einer Gutschrift). Mit ' +
      'Bankkonto oder Betrag landet die Zahlung im Zahlungsregister (Teilzahlungen möglich), sonst wird ' +
      'der Beleg nur als bezahlt markiert.',
    bindung: 'beleg',
    modell: 'kundenrechnung',
    uebergang: { von: ['offen'], nach: ['bezahlt'] },
    schema: z.object({
      datum: DATUM.optional(),
      betrag: z.number().positive().optional().describe('Teilbetrag in Euro; leer = offener Betrag'),
      bankkonto_id: z.string().uuid().optional(),
      zahlungsart: z.string().max(60).optional().describe('z. B. Überweisung, PayPal, bar'),
    }),
    formdata: (fd) => ({
      datum: String(fd.get('datum') ?? '') || undefined,
      betrag: fd.get('betrag') ? Number(fd.get('betrag')) : undefined,
      bankkonto_id: String(fd.get('bankkonto_id') ?? '') || undefined,
      zahlungsart: String(fd.get('zahlungsart') ?? '').trim() || undefined,
    }),
    revalidate: ['/verkauf/rechnungen/:id', '/verkauf/rechnungen', '/finanzen'],
  },

  'verkauf.rechnung_stornieren': {
    label: 'Stornieren (Gutschrift)',
    bereich: 'verkauf',
    ki: true,
    beschreibung:
      'Storniert eine Kundenrechnung durch eine Gutschrift über alle Positionen — die Rechnung bleibt als ' +
      'Beleg bestehen (storniert), die Gutschrift verweist auf sie. Bei bezahlten Überweisungsrechnungen ' +
      'steht die Erstattung danach als offene Gutschrift im Zahlungsregister.',
    bindung: 'beleg',
    modell: 'kundenrechnung',
    uebergang: { von: ['offen', 'bezahlt'], nach: ['storniert'] },
    schema: z.object({ grund: z.string().max(300).optional() }),
    formdata: (fd) => ({ grund: String(fd.get('grund') ?? '').trim() || undefined }),
    revalidate: ['/verkauf/rechnungen/:id', '/verkauf/rechnungen'],
  },

  'verkauf.gutschrift_erstellen': {
    label: 'Teilgutschrift erstellen',
    bereich: 'verkauf',
    beschreibung:
      'Gutschrift über einzelne Positionen/Mengen einer Rechnung (Rücknahme, Preisnachlass) — die Rechnung ' +
      'bleibt gültig, die Gutschrift verweist auf sie.',
    bindung: 'beleg',
    modell: 'kundenrechnung',
    // Korrekturbeleg, kein Prozessschritt: die Rechnung wechselt ihren Zustand nicht.
    prozessfrei: true,
    schema: z.object({
      positionen: z
        .array(z.object({ position_id: z.string().uuid(), menge: z.number().positive() }))
        .min(1, 'Bitte mindestens eine Position mit Menge angeben'),
      grund: z.string().max(300).optional(),
    }),
    formdata: (fd) => {
      const positionen: { position_id: string; menge: number }[] = []
      for (const [key, value] of fd.entries()) {
        if (!key.startsWith('gut_') || typeof value !== 'string' || value.trim() === '') continue
        const menge = Number(value)
        if (Number.isFinite(menge) && menge > 0) positionen.push({ position_id: key.slice(4), menge })
      }
      return { positionen, grund: String(fd.get('grund') ?? '').trim() || undefined }
    },
    revalidate: ['/verkauf/rechnungen/:id', '/verkauf/rechnungen'],
  },

  'verkauf.rechnung_mahnen': {
    label: 'Mahnen',
    bereich: 'verkauf',
    beschreibung:
      'Nächste Mahnstufe einer fälligen, offenen Rechnung (Zahlungserinnerung → 1. Mahnung → 2. Mahnung); ' +
      'das Mahnschreiben liegt als PDF am Beleg.',
    bindung: 'beleg',
    modell: 'kundenrechnung',
    // Werkzeug am offenen Beleg — der Zustand bleibt „offen".
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/verkauf/rechnungen/:id', '/verkauf/rechnungen'],
  },

  'verkauf.rechnung_details': {
    label: 'Rechnungsdaten ändern',
    bereich: 'verkauf',
    beschreibung: 'Notiz auf dem Beleg und Fälligkeit (nur offene Belege).',
    bindung: 'beleg',
    modell: 'kundenrechnung',
    prozessfrei: true,
    schema: z.object({
      notiz: z.string().max(500).optional(),
      faellig_am: DATUM.optional(),
    }),
    formdata: (fd) => ({
      notiz: String(fd.get('notiz') ?? '').trim() || undefined,
      faellig_am: String(fd.get('faellig_am') ?? '') || undefined,
    }),
    revalidate: ['/verkauf/rechnungen/:id'],
  },

  'verkauf.rechnung_probelauf_loeschen': {
    label: 'Rechnungs-Probelauf löschen',
    bereich: 'verkauf',
    nurAdmin: true,
    beschreibung:
      'Löscht alle Testbelege des Rechnungs-Probelaufs (probe = true: Testrechnungen PROBE-RE-…, Testgutschriften ' +
      'PROBE-GU-…, ihre Zahlungen im Register), rechnet die berechneten Mengen der Aufträge neu und setzt die ' +
      'Probe-Nummernkreise zurück. Echte Belege bleiben unberührt. Voraussetzung, um die Rechnung scharf zu schalten.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({}),
    revalidate: ['/verkauf/rechnungen', '/einstellungen/belege', '/finanzen', '/verkauf'],
  },

  'verkauf.datev_uebergeben': {
    label: 'DATEV: Zeitraum als übergeben markieren',
    bereich: 'verkauf',
    beschreibung:
      'Markiert alle Kundenrechnungen und Gutschriften eines Zeitraums als an die Buchhaltung übergeben ' +
      '(nach dem Export des Buchungsstapels; Testbelege des Probelaufs ausgenommen). Die Datei selbst liefert /api/verkauf/datev.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({ von: DATUM, bis: DATUM }),
    formdata: (fd) => ({ von: String(fd.get('von') ?? ''), bis: String(fd.get('bis') ?? '') }),
    revalidate: ['/verkauf/rechnungen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
