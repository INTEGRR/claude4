import { z } from 'zod'
import type { RegistrierteAktion } from './typen.ts'

/**
 * Aktionen der Finanzen, Teil 1 (Zahlungsfundament): Bankkonten und
 * Kontostands-Anker, das zentrale Zahlungsregister (inkl. Teilzahlungen auf
 * Lieferantenrechnungen) und der Zahlplan je Bestellung. Der Bereich
 * 'finanzen' verlangt die persönliche Befugnis 'finanzen:zugriff' — geprüft
 * im Torwächter über canWrite, nicht hier.
 */

const DATUM = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als JJJJ-MM-TT')

export const FINANZEN = {
  'finanzen.bankkonto_anlegen': {
    label: 'Bankkonto anlegen',
    bereich: 'finanzen',
    beschreibung: 'Legt ein Bankkonto an — Konfiguration, übersteht den Demodaten-Neustart.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(120),
      iban: z.string().max(42).optional(),
      waehrung: z.string().length(3).default('EUR'),
    }),
    zusammenfassung: (p) => `Bankkonto „${p.name}" anlegen`,
    revalidate: ['/finanzen'],
  },

  'finanzen.kontostand_erfassen': {
    label: 'Kontostand erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Setzt den manuellen Saldo-Anker eines Bankkontos zum Stichtag — ab dort rechnet der Cashflow mit den erfassten Zahlungen weiter.',
    bindung: 'frei',
    prozessfrei: true,
    ki: true,
    schema: z.object({
      bankkonto_id: z.string().uuid('Bitte ein Konto wählen'),
      stichtag: DATUM,
      saldo: z.number(),
      notiz: z.string().max(300).optional(),
    }),
    zusammenfassung: (p) => `Kontostand ${p.saldo} € zum ${p.stichtag} erfassen`,
    revalidate: ['/finanzen'],
  },

  'finanzen.zahlung_erfassen': {
    label: 'Zahlung erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Erfasst eine freie Ein- oder Auszahlung im Zahlungsregister (ohne Belegbezug — für Rechnungen und Raten gibt es eigene Knöpfe).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      richtung: z.enum(['ein', 'aus']),
      betrag: z.number().positive('Der Betrag muss größer als null sein'),
      waehrung: z.string().length(3).default('EUR'),
      gezahlt_am: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
      verwendungszweck: z.string().max(300).optional(),
    }),
    zusammenfassung: (p) =>
      `${p.richtung === 'ein' ? 'Einzahlung' : 'Auszahlung'} über ${p.betrag} ${p.waehrung} erfassen`,
    revalidate: ['/finanzen'],
  },

  'finanzen.zahlung_stornieren': {
    label: 'Zahlung stornieren',
    bereich: 'finanzen',
    beschreibung:
      'Storniert eine erfasste Zahlung (bleibt sichtbar, zählt nicht mehr) — eine als bezahlt markierte Rechnung wird wieder offen.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      zahlung_id: z.string().uuid('Bitte die Zahlung angeben'),
    }),
    revalidate: ['/finanzen'],
  },

  'finanzen.rechnung_teilzahlung': {
    label: 'Zahlung auf Rechnung erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Erfasst eine (Teil-)Zahlung auf eine gebuchte Lieferantenrechnung; bei voller Deckung springt sie auf bezahlt. Anzahlungen über den Zahlplan der Bestellung werden angerechnet.',
    bindung: 'beleg',
    modell: 'vendor_bill',
    prozessfrei: true,
    schema: z.object({
      betrag: z.number().positive('Der Betrag muss größer als null sein'),
      gezahlt_am: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
    }),
    formdata: (fd) => ({
      betrag: Number(fd.get('betrag')),
      gezahlt_am: String(fd.get('gezahlt_am') ?? '') || undefined,
      bankkonto_id: String(fd.get('bankkonto_id') ?? '') || undefined,
    }),
    zusammenfassung: (p) => `Zahlung über ${p.betrag} € erfassen`,
    revalidate: ['/einkauf/rechnungen/:id', '/finanzen'],
  },

  'finanzen.po_zahlplan_setzen': {
    label: 'Zahlplan festlegen',
    bereich: 'finanzen',
    beschreibung:
      'Setzt den Zahlplan der Bestellung nach der üblichen Vorlage: Anzahlung bei Auftrag, Rest bei Verschiffung/Ankunft. Unbezahlte Raten werden ersetzt; 0 % Anzahlung ergibt eine einzelne Rate.',
    bindung: 'beleg',
    modell: 'purchase_order',
    schema: z.object({
      anzahlung_pct: z.number().min(0).max(100).default(30),
      rest_ausloeser: z.enum(['verschiffung', 'ankunft', 'termin']).default('verschiffung'),
      rest_termin: DATUM.optional(),
      rest_versatz_tage: z.number().int().min(0).max(120).default(0),
    }),
    formdata: (fd) => ({
      anzahlung_pct: Number(fd.get('anzahlung_pct') ?? 30),
      rest_ausloeser: String(fd.get('rest_ausloeser') ?? 'verschiffung'),
      rest_termin: String(fd.get('rest_termin') ?? '') || undefined,
      rest_versatz_tage: Number(fd.get('rest_versatz_tage') ?? 0),
    }),
    zusammenfassung: (p) =>
      p.anzahlung_pct > 0
        ? `Zahlplan: ${p.anzahlung_pct} % Anzahlung, Rest bei ${p.rest_ausloeser}`
        : `Zahlplan: 100 % bei ${p.rest_ausloeser}`,
    revalidate: ['/einkauf/:id', '/finanzen'],
  },

  'finanzen.zahlplan_rate_hinzufuegen': {
    label: 'Zahlplan-Rate hinzufügen',
    bereich: 'finanzen',
    beschreibung:
      'Ergänzt eine einzelne Rate im Zahlplan der Bestellung — Prozent vom Brutto ODER fester Betrag, mit Auslöser.',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({
      bezeichnung: z.string().min(1, 'Bitte eine Bezeichnung angeben').max(120),
      anteil_pct: z.number().positive().max(100).optional(),
      betrag: z.number().positive().optional(),
      ausloeser: z.enum(['bestellung', 'verschiffung', 'ankunft', 'termin']).default('verschiffung'),
      versatz_tage: z.number().int().min(0).max(120).default(0),
      termin: DATUM.optional(),
    }),
    formdata: (fd) => ({
      bezeichnung: String(fd.get('bezeichnung') ?? '').trim(),
      anteil_pct: String(fd.get('anteil_pct') ?? '') ? Number(fd.get('anteil_pct')) : undefined,
      betrag: String(fd.get('betrag') ?? '') ? Number(fd.get('betrag')) : undefined,
      ausloeser: String(fd.get('ausloeser') ?? 'verschiffung'),
      versatz_tage: Number(fd.get('versatz_tage') ?? 0),
      termin: String(fd.get('termin') ?? '') || undefined,
    }),
    revalidate: ['/einkauf/:id', '/finanzen'],
  },

  'finanzen.zahlplan_rate_entfernen': {
    label: 'Zahlplan-Rate entfernen',
    bereich: 'finanzen',
    beschreibung: 'Entfernt eine unbezahlte Rate aus dem Zahlplan.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      rate_id: z.string().uuid('Bitte die Rate angeben'),
    }),
    revalidate: ['/finanzen'],
  },

  'finanzen.rate_zahlen': {
    label: 'Zahlplan-Rate zahlen',
    bereich: 'finanzen',
    beschreibung:
      'Erfasst die Zahlung einer Zahlplan-Rate im Register (Betrag laut Plan, in Bestellwährung über den eingefrorenen Kurs).',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      rate_id: z.string().uuid('Bitte die Rate angeben'),
      gezahlt_am: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
    }),
    revalidate: ['/finanzen'],
  },

  'finanzen.verschiffung_erfassen': {
    label: 'Verschiffung erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Setzt den tatsächlichen Verschiffungstag der Bestellung — Auslöser für Zahlplan-Raten „bei Verschiffung".',
    bindung: 'beleg',
    modell: 'purchase_order',
    prozessfrei: true,
    schema: z.object({
      verschifft_am: DATUM,
    }),
    formdata: (fd) => ({
      verschifft_am: String(fd.get('verschifft_am') ?? ''),
    }),
    revalidate: ['/einkauf/:id', '/finanzen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
