/**
 * Abnahmetest — das Drei-Monats-Szenario als DATEN (Entscheidungslog
 * 2026-10-15, „Abnahmetest: Modell vorab, Wiederholung live, Vergleich").
 *
 * Dieselbe Schrittliste treibt zwei Dinge:
 *  - das Rechenmodell (modell.ts) — rein, ohne Datenbank, rechnet VORHER
 *    aus, welche Werte nach jedem Monat stehen müssen;
 *  - den Live-Lauf (tests/prozesse/abnahme.test.ts) — spielt jeden Schritt
 *    über die Aktions-Registry (Torwächter) gegen eine frische Datenbank
 *    samt Shopify-, DHL- und 17TRACK-Attrappe nach.
 *
 * Die Monate liegen RELATIV zum Lauftag: Monat 3 ist der laufende Monat,
 * Monat 1 liegt zwei Monate zurück. So bleiben Fälligkeiten („ab heute")
 * und Kurse deterministisch, egal wann die Suite läuft.
 */

export type Sku = 'ALU-CASE' | 'PCB-65' | 'SW-LIN' | 'DESKMAT' | 'KB-65'
export type Datum = string // JJJJ-MM-TT

export interface Produkt {
  sku: Sku
  name: string
  /** Plankosten (standard_cost) — greifen, solange kein Durchschnittspreis existiert. */
  kosten: number
  /** Listenpreis netto (list_price). */
  preis: number
  gewicht_g: number
  verkaufbar: boolean
  einkaufbar: boolean
  route: 'kaufen' | 'fertigen'
  /** Auf Auftrag fertigen (route_mto) — die Tastatur meldet dem Shop die baubare Menge. */
  mto?: boolean
  /** Shopify-Variante (GID-Nummer) — nur verknüpfte Artikel melden Bestand. */
  shopify?: number
}

export const PRODUKTE: Produkt[] = [
  { sku: 'ALU-CASE', name: 'Aluminiumgehäuse 65', kosten: 38, preis: 0, gewicht_g: 900, verkaufbar: false, einkaufbar: true, route: 'kaufen' },
  { sku: 'PCB-65', name: 'PCB 65 Hotswap', kosten: 22, preis: 0, gewicht_g: 120, verkaufbar: false, einkaufbar: true, route: 'kaufen' },
  { sku: 'SW-LIN', name: 'Linear-Switch', kosten: 0.3, preis: 0, gewicht_g: 6, verkaufbar: false, einkaufbar: true, route: 'kaufen' },
  { sku: 'DESKMAT', name: 'Deskmat 900×400', kosten: 9, preis: 29, gewicht_g: 450, verkaufbar: true, einkaufbar: true, route: 'kaufen', shopify: 702 },
  { sku: 'KB-65', name: 'Tastatur 65 montiert', kosten: 0, preis: 199, gewicht_g: 1100, verkaufbar: true, einkaufbar: false, route: 'fertigen', mto: true, shopify: 701 },
]

/** Stückliste der Tastatur: je Stück ein Gehäuse, ein PCB, 70 Switches (Backflush). */
export const STUECKLISTE: { produkt: Sku; komponenten: { sku: Sku; menge: number }[] } = {
  produkt: 'KB-65',
  komponenten: [
    { sku: 'ALU-CASE', menge: 1 },
    { sku: 'PCB-65', menge: 1 },
    { sku: 'SW-LIN', menge: 70 },
  ],
}

/** Ein Arbeitsgang „Montage" am Arbeitsplatz MONT: 30 Minuten je Stück, 48 € je Stunde. */
export const ARBEITSGANG = { arbeitsplatz: 'MONT', name: 'Montage', minuten: 30, satz: 48 }

export const PARTNER = {
  lieferantEur: 'Keycap Works GmbH',
  lieferantUsd: 'Switch Supply Co.',
  kunde: 'Büro Nord GmbH',
}

/** Sitzland der Lieferanten — ausländische stellen keine deutsche Umsatzsteuer (0121). */
export const LIEFERANT_LAND: Record<string, string> = {
  [PARTNER.lieferantEur]: 'DE',
  [PARTNER.lieferantUsd]: 'US',
}

/** Vorsteuer-Standard der Bestellzeile nach Lieferantenland (0121): Ausland 0 %, Inland 19 %. */
export function einkaufSteuersatz(lieferant: string): number {
  return LIEFERANT_LAND[lieferant] === 'DE' ? STEUERSATZ : 0
}

export const BANKKONTO = 'Geschäftskonto'
export const ERSTER_KONTOSTAND = 50_000
export const SHOPIFY_MTO = { puffer: 2, deckel: 99 }
export const STEUERSATZ = 19

/** Brutto-Shoppreise (Steuer im Preis): netto × 1,19 — so liefert Shopify sie. */
export const SHOP_BRUTTO: Record<'KB-65' | 'DESKMAT', number> = { 'KB-65': 236.81, DESKMAT: 34.51 }
export const SHOP_VERSAND_BRUTTO = 4.9

export interface Position {
  produkt: Sku
  menge: number
  /** Netto je Einheit in der Belegwährung (Einkauf/B2B) — im Shop: Brutto je Stück. */
  preis: number
}

export type Schritt =
  | { art: 'kurs'; waehrung: 'USD'; kurs: number; ab: Datum }
  | { art: 'kontostand'; stichtag: Datum; saldo: number }
  | { art: 'vertrag'; id: string; name: string; betrag: number; zahltag: number; beginn: Datum; frist: number }
  | { art: 'vertrag_zahlen'; vertrag: string; am: Datum }
  | { art: 'vertrag_kuendigen'; vertrag: string; zum: Datum }
  | { art: 'darlehen'; id: string; name: string; betrag: number; zins_pct: number; laufzeit: number; zahltag: number; auszahlung_am: Datum; darlehensart?: 'annuitaet' | 'rate' | 'endfaellig' }
  | { art: 'darlehen_auszahlen'; darlehen: string; am: Datum }
  | { art: 'darlehen_rate'; darlehen: string; nr: number; am: Datum }
  /** Steuertermin; `steuerart` Standard „ust" — je Art und Zeitraum nur ein Termin (Unique in steuerzahlungen). */
  | { art: 'steuer'; id: string; bezeichnung: string; betrag: number; von: Datum; bis: Datum; faellig: Datum; steuerart?: 'ust' | 'gewst' | 'kst' | 'sonstige' }
  | { art: 'steuer_zahlen'; steuer: string; am: Datum }
  /** Inventur im Hauptlager: `gezaehlt` absolut oder `differenz` gegen den Buchbestand. */
  | { art: 'inventur'; produkt: Sku; gezaehlt?: number; differenz?: number }
  /** Bestellung anlegen + bestätigen; USD-Belege laufen über „Bestellung aus Beleg erfassen" (mit Fracht, ggf. Vorkasse). */
  | { art: 'bestellung'; id: string; lieferant: string; waehrung: 'EUR' | 'USD'; positionen: Position[]; fracht?: number; vorkasse_am?: Datum; referenz?: string }
  /** Wareneingang buchen — ohne `mengen` vollständig; mit `mengen` Teilmenge, Rest wird Rückstand. */
  | { art: 'wareneingang'; bestellung: string; mengen?: Partial<Record<Sku, number>> }
  /** Einstandsnebenkosten auf den n-ten Wareneingang der Bestellung (1 = erster). */
  | { art: 'nebenkosten'; bestellung: string; eingang: number; betrag: number; basis: 'weight' | 'value' | 'quantity'; typ: 'freight' | 'customs_duty' | 'handling' }
  /** Lieferantenrechnung aus der Bestellung: erstellen, datieren, buchen; `zahlen_am` = Überweisung vom Konto, `gedeckt` = „als bezahlt" (über Vorkasse gedeckt), sonst bleibt sie offen. */
  | { art: 'rechnung'; id: string; bestellung: string; datum: Datum; zahlen_am?: Datum; gedeckt?: boolean }
  /** Offene Rechnung später vom Konto überweisen. */
  | { art: 'rechnung_zahlen'; rechnung: string; am: Datum }
  /** Shop-Bestellung (bezahlt, unversendet) per Webhook. Preise brutto je Stück. */
  | { art: 'shop_bestellung'; id: string; nr: string; am: Datum; positionen: Position[] }
  /** Storno in Shopify (Webhook) — Shopify führt. */
  | { art: 'shop_storno'; bestellung: string }
  /** B2B-Auftrag für den Firmenkunden: anlegen + bestätigen. Preise netto. */
  | { art: 'auftrag'; id: string; kunde: string; positionen: Position[] }
  | { art: 'auftrag_storno'; auftrag: string }
  /** Fertigungsauftrag des (Auftrags-)Belegs fertig melden (Backflush). */
  | { art: 'fertig'; auftrag: string }
  /** Fertigung auf Lager: anlegen, bestätigen, fertig melden. */
  | { art: 'fertigung'; id: string; produkt: Sku; menge: number }
  /** Lieferung hinaus: Shop-Aufträge per DHL-Label (bucht aus, meldet an Shopify), B2B per „Buchen". */
  | { art: 'versand'; auftrag: string }
  | { art: 'demontage'; produkt: Sku; menge: number }
  | { art: 'ausschuss'; produkt: Sku; menge: number }
  /** Monatsabschluss: Outbox leeren, Shopify-Abgleich, Stand vergleichen. */
  | { art: 'monatsende'; monat: 1 | 2 | 3 }

export interface Szenario {
  heute: Datum
  /** Monatsanfänge der drei Planmonate (Index 1..3) plus Folgemonate 4..6 für Fälligkeiten. */
  monate: Datum[]
  /** Horizont für „fällig bis" (Ende Monat 5). */
  faelligBis: Datum
  schritte: Schritt[]
}

// --- Datumshilfen (reine Kalenderarithmetik in UTC) ---------------------------

function utc(iso: Datum): Date {
  const [j, m, t] = iso.split('-').map(Number)
  return new Date(Date.UTC(j, m - 1, t))
}

export function iso(d: Date): Datum {
  return d.toISOString().slice(0, 10)
}

/** Erster Tag des Monats, `versatz` Monate neben dem Monat von `datum`. */
export function monatsanfang(datum: Datum, versatz = 0): Datum {
  const d = utc(datum)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + versatz, 1)))
}

export function monatsende(monatsanfangIso: Datum): Datum {
  const d = utc(monatsanfangIso)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)))
}

export function tageAddieren(datum: Datum, tage: number): Datum {
  const d = utc(datum)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + tage)))
}

export function monateAddieren(datum: Datum, monate: number): Datum {
  const d = utc(datum)
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monate, d.getUTCDate())))
}

/** `JJJJ-MM` eines Datums. */
export const monat = (datum: Datum): string => datum.slice(0, 7)

// --- Das Szenario --------------------------------------------------------------

/**
 * Baut den Plan relativ zum Lauftag. Monat 1 = heute − 2 Monate, Monat 3 =
 * der laufende Monat; Tage ≤ 28, damit jeder Monat sie hat.
 */
export function szenarioErzeugen(heute: Datum): Szenario {
  const monate: Datum[] = ['']
  for (let m = 1; m <= 6; m++) monate.push(monatsanfang(heute, m - 3))
  const tag = (m: number, t: number): Datum => tageAddieren(monate[m], t - 1)

  const schritte: Schritt[] = [
    // --- Einrichtung (Monat 1) -----------------------------------------------
    // Saldo-Anker am Vortag des Plans: finanz_saldo zählt Zahlungen NACH dem Stichtag.
    { art: 'kontostand', stichtag: tageAddieren(monate[1], -1), saldo: ERSTER_KONTOSTAND },
    { art: 'kurs', waehrung: 'USD', kurs: 0.92, ab: tag(1, 1) },
    { art: 'vertrag', id: 'V1', name: 'Miete Werkstatt', betrag: 1200, zahltag: 1, beginn: tag(1, 1), frist: 3 },
    { art: 'vertrag', id: 'V2', name: 'Software-Lizenz', betrag: 89, zahltag: 15, beginn: tag(1, 1), frist: 1 },
    { art: 'darlehen', id: 'D1', name: 'Maschinen-Darlehen', betrag: 12_000, zins_pct: 4.8, laufzeit: 24, zahltag: 5, auszahlung_am: tag(1, 3) },

    // --- Monat 1 -------------------------------------------------------------
    { art: 'vertrag_zahlen', vertrag: 'V1', am: tag(1, 1) },
    { art: 'darlehen_auszahlen', darlehen: 'D1', am: tag(1, 3) },
    { art: 'inventur', produkt: 'DESKMAT', gezaehlt: 1 },
    {
      art: 'bestellung', id: 'PO1', lieferant: PARTNER.lieferantEur, waehrung: 'EUR',
      positionen: [
        { produkt: 'ALU-CASE', menge: 40, preis: 36.5 },
        { produkt: 'PCB-65', menge: 40, preis: 21 },
        { produkt: 'DESKMAT', menge: 30, preis: 8.5 },
      ],
    },
    {
      art: 'bestellung', id: 'PO2', lieferant: PARTNER.lieferantUsd, waehrung: 'USD', referenz: 'PI-2026-118',
      positionen: [{ produkt: 'SW-LIN', menge: 5000, preis: 0.28 }], fracht: 60, vorkasse_am: tag(1, 5),
    },
    { art: 'wareneingang', bestellung: 'PO1', mengen: { 'ALU-CASE': 40, 'PCB-65': 40, DESKMAT: 20 } },
    { art: 'nebenkosten', bestellung: 'PO1', eingang: 1, betrag: 120, basis: 'weight', typ: 'freight' },
    { art: 'shop_bestellung', id: 'SH1', nr: '#1001', am: tag(1, 6), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'shop_bestellung', id: 'SH2', nr: '#1002', am: tag(1, 8), positionen: [{ produkt: 'DESKMAT', menge: 2, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'wareneingang', bestellung: 'PO2' },
    { art: 'rechnung', id: 'R1', bestellung: 'PO1', datum: tag(1, 10), zahlen_am: tag(1, 20) },
    { art: 'rechnung', id: 'R2', bestellung: 'PO2', datum: tag(1, 12), gedeckt: true },
    { art: 'fertig', auftrag: 'SH1' },
    { art: 'versand', auftrag: 'SH1' },
    { art: 'versand', auftrag: 'SH2' },
    {
      art: 'shop_bestellung', id: 'SH3', nr: '#1003', am: tag(1, 12),
      positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }, { produkt: 'DESKMAT', menge: 1, preis: SHOP_BRUTTO.DESKMAT }],
    },
    { art: 'shop_bestellung', id: 'SH4', nr: '#1004', am: tag(1, 15), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'vertrag_zahlen', vertrag: 'V2', am: tag(1, 15) },
    { art: 'fertig', auftrag: 'SH3' },
    { art: 'versand', auftrag: 'SH3' },
    { art: 'shop_bestellung', id: 'SH5', nr: '#1005', am: tag(1, 20), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'fertig', auftrag: 'SH4' },
    { art: 'versand', auftrag: 'SH4' },
    { art: 'shop_bestellung', id: 'SH6', nr: '#1006', am: tag(1, 24), positionen: [{ produkt: 'DESKMAT', menge: 3, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'versand', auftrag: 'SH6' },
    { art: 'monatsende', monat: 1 },

    // --- Monat 2 -------------------------------------------------------------
    { art: 'vertrag_zahlen', vertrag: 'V1', am: tag(2, 1) },
    { art: 'kurs', waehrung: 'USD', kurs: 0.9, ab: tag(2, 1) },
    { art: 'wareneingang', bestellung: 'PO1' },
    { art: 'rechnung', id: 'R3', bestellung: 'PO1', datum: tag(2, 3), zahlen_am: tag(2, 10) },
    { art: 'darlehen_rate', darlehen: 'D1', nr: 1, am: tag(2, 5) },
    { art: 'fertig', auftrag: 'SH5' },
    { art: 'versand', auftrag: 'SH5' },
    { art: 'shop_bestellung', id: 'SH7', nr: '#1007', am: tag(2, 2), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'shop_bestellung', id: 'SH8', nr: '#1008', am: tag(2, 5), positionen: [{ produkt: 'KB-65', menge: 2, preis: SHOP_BRUTTO['KB-65'] }] },
    {
      art: 'shop_bestellung', id: 'SH9', nr: '#1009', am: tag(2, 9),
      positionen: [{ produkt: 'DESKMAT', menge: 1, preis: SHOP_BRUTTO.DESKMAT }, { produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }],
    },
    { art: 'steuer', id: 'S1', bezeichnung: 'USt-Voranmeldung Monat 1', betrag: 1850, von: tag(1, 1), bis: monatsende(monate[1]), faellig: tag(2, 10) },
    { art: 'steuer_zahlen', steuer: 'S1', am: tag(2, 10) },
    {
      art: 'bestellung', id: 'PO3', lieferant: PARTNER.lieferantEur, waehrung: 'EUR',
      positionen: [{ produkt: 'ALU-CASE', menge: 20, preis: 37 }, { produkt: 'PCB-65', menge: 20, preis: 21.5 }],
    },
    { art: 'wareneingang', bestellung: 'PO3' },
    { art: 'nebenkosten', bestellung: 'PO3', eingang: 1, betrag: 45, basis: 'value', typ: 'freight' },
    { art: 'fertig', auftrag: 'SH7' },
    { art: 'fertig', auftrag: 'SH8' },
    { art: 'versand', auftrag: 'SH7' },
    { art: 'versand', auftrag: 'SH8' },
    { art: 'shop_bestellung', id: 'SH10', nr: '#1010', am: tag(2, 14), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'vertrag_zahlen', vertrag: 'V2', am: tag(2, 15) },
    {
      art: 'bestellung', id: 'PO4', lieferant: PARTNER.lieferantUsd, waehrung: 'USD', referenz: 'INV-77012',
      positionen: [{ produkt: 'SW-LIN', menge: 3000, preis: 0.27 }], fracht: 40,
    },
    { art: 'wareneingang', bestellung: 'PO4' },
    { art: 'rechnung', id: 'R4', bestellung: 'PO4', datum: tag(2, 16) },
    { art: 'fertig', auftrag: 'SH9' },
    { art: 'versand', auftrag: 'SH9' },
    { art: 'shop_bestellung', id: 'SH11', nr: '#1011', am: tag(2, 18), positionen: [{ produkt: 'DESKMAT', menge: 4, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'versand', auftrag: 'SH11' },
    { art: 'rechnung', id: 'R5', bestellung: 'PO3', datum: tag(2, 20), zahlen_am: tag(2, 28) },
    { art: 'fertig', auftrag: 'SH10' },
    {
      art: 'auftrag', id: 'B1', kunde: PARTNER.kunde,
      positionen: [{ produkt: 'KB-65', menge: 3, preis: 185 }, { produkt: 'DESKMAT', menge: 5, preis: 25 }],
    },
    { art: 'fertig', auftrag: 'B1' },
    { art: 'versand', auftrag: 'B1' },
    { art: 'ausschuss', produkt: 'PCB-65', menge: 2 },
    { art: 'shop_bestellung', id: 'SH12', nr: '#1012', am: tag(2, 22), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'shop_storno', bestellung: 'SH10' },
    { art: 'steuer', id: 'S2', bezeichnung: 'USt-Voranmeldung Monat 2', betrag: 2300, von: tag(2, 1), bis: monatsende(monate[2]), faellig: tag(3, 10) },
    { art: 'monatsende', monat: 2 },

    // --- Monat 3 -------------------------------------------------------------
    { art: 'vertrag_zahlen', vertrag: 'V1', am: tag(3, 1) },
    { art: 'demontage', produkt: 'KB-65', menge: 1 },
    { art: 'fertig', auftrag: 'SH12' },
    { art: 'versand', auftrag: 'SH12' },
    { art: 'fertigung', id: 'MO-LAGER', produkt: 'KB-65', menge: 2 },
    { art: 'shop_bestellung', id: 'SH13', nr: '#1013', am: tag(3, 2), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'shop_bestellung', id: 'SH14', nr: '#1014', am: tag(3, 4), positionen: [{ produkt: 'DESKMAT', menge: 1, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'rechnung_zahlen', rechnung: 'R4', am: tag(3, 5) },
    { art: 'darlehen_rate', darlehen: 'D1', nr: 2, am: tag(3, 5) },
    { art: 'fertig', auftrag: 'SH13' },
    { art: 'versand', auftrag: 'SH13' },
    { art: 'versand', auftrag: 'SH14' },
    { art: 'shop_bestellung', id: 'SH15', nr: '#1015', am: tag(3, 7), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'steuer_zahlen', steuer: 'S2', am: tag(3, 10) },
    { art: 'shop_bestellung', id: 'SH16', nr: '#1016', am: tag(3, 11), positionen: [{ produkt: 'DESKMAT', menge: 2, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'auftrag', id: 'B2', kunde: PARTNER.kunde, positionen: [{ produkt: 'KB-65', menge: 2, preis: 185 }] },
    { art: 'auftrag_storno', auftrag: 'B2' },
    { art: 'fertig', auftrag: 'SH15' },
    { art: 'versand', auftrag: 'SH15' },
    { art: 'versand', auftrag: 'SH16' },
    { art: 'shop_bestellung', id: 'SH17', nr: '#1017', am: tag(3, 13), positionen: [{ produkt: 'KB-65', menge: 1, preis: SHOP_BRUTTO['KB-65'] }] },
    { art: 'shop_bestellung', id: 'SH18', nr: '#1018', am: tag(3, 14), positionen: [{ produkt: 'DESKMAT', menge: 1, preis: SHOP_BRUTTO.DESKMAT }] },
    { art: 'versand', auftrag: 'SH18' },
    { art: 'inventur', produkt: 'SW-LIN', differenz: -15 },
    { art: 'vertrag_zahlen', vertrag: 'V2', am: tag(3, 15) },
    { art: 'vertrag_kuendigen', vertrag: 'V2', zum: monatsende(monate[5]) },
    { art: 'steuer', id: 'S3', bezeichnung: 'USt-Voranmeldung Monat 3', betrag: 1950, von: tag(3, 1), bis: monatsende(monate[3]), faellig: tag(4, 10) },
    { art: 'monatsende', monat: 3 },
  ]

  return { heute, monate, faelligBis: monatsende(monate[5]), schritte }
}
