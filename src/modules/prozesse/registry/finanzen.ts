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

  // --- Fixkosten-Verträge (0059) -------------------------------------------

  'finanzen.vertrag_anlegen': {
    label: 'Vertrag anlegen',
    bereich: 'finanzen',
    beschreibung:
      'Legt einen Fixkosten-Vertrag an (Miete, Lizenz, Personal-Posten …): Betrag je Intervall, Zahltag, Laufzeit und Kündigungsfrist.',
    bindung: 'frei',
    ki: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(160),
      kategorie: z.string().min(1).max(60).default('sonstiges'),
      partner_id: z.string().uuid().optional(),
      betrag: z.number().positive('Der Betrag muss größer als null sein'),
      waehrung: z.string().length(3).default('EUR'),
      intervall: z.enum(['monatlich', 'quartalsweise', 'jaehrlich']).default('monatlich'),
      zahltag: z.number().int().min(1).max(28).default(1),
      beginn: DATUM,
      ende: DATUM.optional(),
      laufzeit_monate: z.number().int().positive().optional(),
      kuendigungsfrist_monate: z.number().int().min(0).max(24).default(0),
      notiz: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) => `Vertrag „${p.name}" (${p.betrag} ${p.waehrung} ${p.intervall}) anlegen`,
    revalidate: ['/finanzen/vertraege', '/finanzen'],
  },

  'finanzen.vertrag_aendern': {
    label: 'Vertrag ändern',
    bereich: 'finanzen',
    beschreibung: 'Ändert Stammdaten eines Vertrags (Betrag, Intervall, Fristen, Laufzeit).',
    bindung: 'beleg',
    modell: 'vertrag',
    prozessfrei: true,
    schema: z.object({
      name: z.string().min(1).max(160),
      kategorie: z.string().min(1).max(60),
      partner_id: z.string().uuid().optional(),
      betrag: z.number().positive(),
      waehrung: z.string().length(3).default('EUR'),
      intervall: z.enum(['monatlich', 'quartalsweise', 'jaehrlich']),
      zahltag: z.number().int().min(1).max(28),
      beginn: DATUM,
      ende: DATUM.optional(),
      laufzeit_monate: z.number().int().positive().optional(),
      kuendigungsfrist_monate: z.number().int().min(0).max(24),
      notiz: z.string().max(500).optional(),
    }),
    formdata: (fd) => ({
      name: String(fd.get('name') ?? '').trim(),
      kategorie: String(fd.get('kategorie') ?? '').trim() || 'sonstiges',
      partner_id: String(fd.get('partner_id') ?? '') || undefined,
      betrag: Number(fd.get('betrag')),
      waehrung: String(fd.get('waehrung') ?? 'EUR'),
      intervall: String(fd.get('intervall') ?? 'monatlich'),
      zahltag: Number(fd.get('zahltag') ?? 1),
      beginn: String(fd.get('beginn') ?? ''),
      ende: String(fd.get('ende') ?? '') || undefined,
      laufzeit_monate: String(fd.get('laufzeit_monate') ?? '')
        ? Number(fd.get('laufzeit_monate'))
        : undefined,
      kuendigungsfrist_monate: Number(fd.get('kuendigungsfrist_monate') ?? 0),
      notiz: String(fd.get('notiz') ?? '').trim() || undefined,
    }),
    revalidate: ['/finanzen/vertraege/:id', '/finanzen/vertraege', '/finanzen'],
  },

  'finanzen.vertrag_kuendigen': {
    label: 'Vertrag kündigen',
    bereich: 'finanzen',
    beschreibung:
      'Kündigt den Vertrag fristgerecht — ohne Datum zum nächstmöglichen Termin; ein früherer Termin als der fristgerechte wird abgewiesen.',
    bindung: 'beleg',
    modell: 'vertrag',
    uebergang: { von: ['aktiv'], nach: ['gekuendigt'] },
    schema: z.object({
      zum: DATUM.optional(),
    }),
    formdata: (fd) => ({
      zum: String(fd.get('zum') ?? '') || undefined,
    }),
    zusammenfassung: (p) => (p.zum ? `Kündigen zum ${p.zum}` : 'Zum nächstmöglichen Termin kündigen'),
    revalidate: ['/finanzen/vertraege/:id', '/finanzen/vertraege', '/finanzen'],
  },

  'finanzen.vertrag_zahlen': {
    label: 'Vertragszahlung erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Erfasst die Zahlung des Vertragsbetrags im Register — der Termin des laufenden Monats gilt damit als beglichen.',
    bindung: 'beleg',
    modell: 'vertrag',
    prozessfrei: true,
    schema: z.object({
      gezahlt_am: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
    }),
    formdata: (fd) => ({
      gezahlt_am: String(fd.get('gezahlt_am') ?? '') || undefined,
      bankkonto_id: String(fd.get('bankkonto_id') ?? '') || undefined,
    }),
    revalidate: ['/finanzen/vertraege/:id', '/finanzen'],
  },

  // --- Darlehen + Steuern (0060) -------------------------------------------

  'finanzen.darlehen_anlegen': {
    label: 'Darlehen anlegen',
    bereich: 'finanzen',
    beschreibung:
      'Legt ein Darlehen mit Konditionen an und erzeugt den Tilgungsplan (Annuität, lineare Rate oder endfällig).',
    bindung: 'frei',
    prozessfrei: true,
    nurAdmin: true,
    schema: z.object({
      name: z.string().min(1, 'Bitte einen Namen angeben').max(160),
      partner_id: z.string().uuid().optional(),
      betrag: z.number().positive('Der Betrag muss größer als null sein'),
      zinssatz_pct: z.number().min(0).max(30).default(0),
      art: z.enum(['annuitaet', 'rate', 'endfaellig']).default('annuitaet'),
      auszahlung_am: DATUM,
      laufzeit_monate: z.number().int().positive().max(360),
      tilgungsfrei_monate: z.number().int().min(0).default(0),
      zahltag: z.number().int().min(1).max(28).default(1),
      bankkonto_id: z.string().uuid().optional(),
      notiz: z.string().max(500).optional(),
    }),
    zusammenfassung: (p) =>
      `Darlehen „${p.name}" über ${p.betrag} € (${p.zinssatz_pct} % p. a., ${p.laufzeit_monate} Monate) anlegen`,
    revalidate: ['/finanzen/darlehen', '/finanzen'],
  },

  'finanzen.darlehen_auszahlen': {
    label: 'Darlehen auszahlen',
    bereich: 'finanzen',
    beschreibung:
      'Bucht die Auszahlung als Einzahlung ins Register und setzt das Darlehen auf laufend; der Tilgungsplan wird bei Bedarf erzeugt.',
    bindung: 'frei',
    prozessfrei: true,
    nurAdmin: true,
    schema: z.object({
      darlehen_id: z.string().uuid('Bitte das Darlehen angeben'),
      datum: DATUM.optional(),
    }),
    revalidate: ['/finanzen/darlehen', '/finanzen'],
  },

  'finanzen.darlehen_rate_zahlen': {
    label: 'Darlehensrate zahlen',
    bereich: 'finanzen',
    beschreibung: 'Erfasst Zins + Tilgung einer Rate im Register; die letzte Rate tilgt das Darlehen.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      rate_id: z.string().uuid('Bitte die Rate angeben'),
      datum: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
    }),
    revalidate: ['/finanzen/darlehen', '/finanzen'],
  },

  'finanzen.steuer_erfassen': {
    label: 'Steuertermin erfassen',
    bereich: 'finanzen',
    beschreibung:
      'Erfasst einen Steuertermin manuell (USt/GewSt/KSt/sonstige) — negativer Betrag = Erstattung.',
    bindung: 'frei',
    prozessfrei: true,
    ki: true,
    schema: z.object({
      art: z.enum(['ust', 'gewst', 'kst', 'sonstige']),
      zeitraum_von: DATUM,
      zeitraum_bis: DATUM,
      bezeichnung: z.string().min(1).max(160),
      betrag: z.number(),
      faellig_am: DATUM,
      notiz: z.string().max(300).optional(),
    }),
    zusammenfassung: (p) => `${p.bezeichnung}: ${p.betrag} € fällig am ${p.faellig_am}`,
    revalidate: ['/finanzen/steuern', '/finanzen'],
  },

  'finanzen.steuer_zahlen': {
    label: 'Steuertermin begleichen',
    bereich: 'finanzen',
    beschreibung: 'Bucht die Zahlung (bzw. Erstattung) eines Steuertermins ins Register.',
    bindung: 'frei',
    prozessfrei: true,
    schema: z.object({
      steuer_id: z.string().uuid('Bitte den Steuertermin angeben'),
      datum: DATUM.optional(),
      bankkonto_id: z.string().uuid().optional(),
    }),
    revalidate: ['/finanzen/steuern', '/finanzen'],
  },

  'finanzen.ust_vorschlag_uebernehmen': {
    label: 'USt-Vorschlag übernehmen',
    bereich: 'finanzen',
    beschreibung:
      'Übernimmt die aus den Belegen geschätzte USt-Zahllast eines Monats als Steuertermin (Umsatzsteuer − Vorsteuer, fällig im Folgemonat).',
    bindung: 'frei',
    prozessfrei: true,
    ki: true,
    schema: z.object({
      monat: DATUM,
    }),
    revalidate: ['/finanzen/steuern', '/finanzen'],
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, RegistrierteAktion<any>>
