/**
 * DATEV-Buchungsstapel für Kundenrechnungen und Gutschriften (0115) — rein,
 * ohne Datenbank. Erzeugt eine CSV im Aufbau des DATEV-Formats „EXTF
 * Buchungsstapel" (Version 700): Kopfzeile, Spaltenzeile, je Beleg und
 * Steuersatz eine Buchung Debitor gegen Erlöskonto (Bruttobetrag,
 * Automatikkonto trägt die Steuer). Rechnungen stehen im Soll des Debitors,
 * Gutschriften im Haben.
 *
 * Wie die Eingangsrechnungen (einkauf/datev.ts) ist das eine VORBEREITUNG
 * für den Steuerberater: Konten, Beraternummer und Mandant stehen in den
 * Einstellungen, der Import läuft in DATEV. Umlaute werden ASCII-sicher
 * geschrieben (DATEV erwartet ANSI, Node schreibt UTF-8).
 */

export interface DatevKonten {
  kontenrahmen: 'SKR03' | 'SKR04'
  debitorenkonto: string
  erloeskonto_19: string
  erloeskonto_7: string
  erloeskonto_0: string
  beraternummer?: string
  mandantennummer?: string
  /** Beginn des Wirtschaftsjahres als JJJJMMTT (Standard: 1. Januar des Exportjahres). */
  wj_beginn?: string
}

export interface DatevKundenbeleg {
  nummer: string
  art: 'rechnung' | 'gutschrift'
  /** JJJJ-MM-TT */
  rechnungsdatum: string
  kunde: string
  kundennummer?: string | null
  auftrag?: string | null
  /** Bruttobetrag je Steuersatz. */
  gruppen: { steuersatz: number; brutto: number }[]
}

/** DATEV-Zellen sind in Anführungszeichen; Zahlen mit Komma. */
const zelle = (wert: string | number | null | undefined, zahl = false): string => {
  if (wert === null || wert === undefined || wert === '') return zahl ? '' : '""'
  if (typeof wert === 'number') return wert.toFixed(2).replace('.', ',')
  return `"${ascii(String(wert)).replace(/"/g, "'")}"`
}

/** Umlaute und ß transliteriert, Steuerzeichen raus — ANSI-sicher. */
export function ascii(text: string): string {
  return text
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss').replace(/€/g, 'EUR')
    .replace(/[^\x20-\x7e]/g, '')
}

export function erloeskonto(konten: DatevKonten, steuersatz: number): string {
  if (steuersatz >= 19) return konten.erloeskonto_19
  if (steuersatz > 0) return konten.erloeskonto_7
  return konten.erloeskonto_0
}

const SPALTEN = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz',
  'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto',
  'Buchungstext', 'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre',
  'Beleglink', 'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle', 'Kost-Menge', 'EU-Land u. UStID', 'EU-Steuersatz',
  'Abw. Versteuerungsart', 'Festschreibung',
]

const jjjjmmtt = (iso: string) => iso.slice(0, 10).replace(/-/g, '')
const ddmm = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}`

/**
 * Buchungsstapel als CSV-Text. `zeitraum` bestimmt Kopfzeile (Datum von/bis)
 * und Wirtschaftsjahr; `erstellt` ist der Zeitstempel der Kopfzeile.
 */
export function datevBuchungsstapel(
  belege: DatevKundenbeleg[],
  konten: DatevKonten,
  zeitraum: { von: string; bis: string },
  erstellt = new Date(),
): string {
  const stempel = erstellt.toISOString().replace(/[-:T]/g, '').slice(0, 17)
  const wj = konten.wj_beginn ?? `${zeitraum.von.slice(0, 4)}0101`
  const kopf = [
    '"EXTF"', '700', '21', '"Buchungsstapel"', '12', stempel, '', '"KR"', '"KRNL"', '',
    zelle(konten.beraternummer ?? '', true) || '', zelle(konten.mandantennummer ?? '', true) || '',
    wj, '4', jjjjmmtt(zeitraum.von), jjjjmmtt(zeitraum.bis), '"Kundenrechnungen KRNL"', '"KRNL"', '1', '0', '0',
    '"EUR"', '', '', '', '', '', '', '', '', '',
  ].join(';')

  const zeilen: string[] = []
  for (const b of belege) {
    for (const g of b.gruppen) {
      if (!(Math.abs(g.brutto) > 0)) continue
      const text = `${b.art === 'rechnung' ? 'Rechnung' : 'Gutschrift'} ${b.nummer} ${b.kunde}${b.auftrag ? ` / ${b.auftrag}` : ''}`
      const felder = [
        zelle(Math.abs(g.brutto)),               // Umsatz
        zelle(b.art === 'rechnung' ? 'S' : 'H'), // Soll/Haben am Debitor
        zelle('EUR'),
        '', '', '',                              // Kurs, Basis-Umsatz, WKZ Basis
        zelle(b.kundennummer || konten.debitorenkonto),
        zelle(erloeskonto(konten, g.steuersatz)),
        '',                                      // BU-Schlüssel: Automatikkonto
        zelle(ddmm(b.rechnungsdatum)),
        zelle(b.nummer.slice(0, 36)),
        zelle(b.auftrag ?? ''),
        '',                                      // Skonto
        zelle(text.slice(0, 60)),
        '', '', '', '', '', '', '', '', '', '', '', '', '',
      ]
      zeilen.push(felder.join(';'))
    }
  }
  return [kopf, SPALTEN.map((n) => `"${ascii(n)}"`).join(';'), ...zeilen].join('\r\n') + '\r\n'
}

/** Steuergruppen eines Belegs aus seinen Positionen (Brutto je Satz). */
export function steuergruppen(positionen: { steuersatz: number; brutto: number }[]): { steuersatz: number; brutto: number }[] {
  const map = new Map<number, number>()
  for (const p of positionen) map.set(Number(p.steuersatz), Math.round(((map.get(Number(p.steuersatz)) ?? 0) + Number(p.brutto)) * 100) / 100)
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([steuersatz, brutto]) => ({ steuersatz, brutto }))
}
