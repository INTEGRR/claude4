/**
 * Shopify-Bestellexport (CSV) → Historie-Bestellungen (0089).
 *
 * Shopify liefert per API ohne den geschützten Scope read_all_orders nur die
 * letzten 60 Tage. Der Export im Shop-Admin (Bestellungen → Exportieren →
 * „Alle Bestellungen", CSV) kennt diese Grenze nicht. Ein Export hat je
 * Position eine Zeile; die Bestellfelder (Status, Summen, Adresse) stehen
 * nur in der ERSTEN Zeile einer Bestellung.
 *
 * Pur und ohne Abhängigkeiten — läuft im Browser (Vorschau, Pakete) und in
 * den Tests. Netto-Rechnung: shopify-preise.ts.
 */
import {
  exportPositionenNetto,
  runden,
  satzAusName,
  satzProzent,
  steuernInklusiveAus,
} from './shopify-preise.ts'

/** CSV nach RFC 4180: Anführungszeichen, "" als Escape, Zeilenumbrüche im Feld, BOM. */
export function csvLesen(text: string): string[][] {
  const zeilen: string[][] = []
  let zeile: string[] = []
  let feld = ''
  let inAnf = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (inAnf) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          feld += '"'
          i++
        } else inAnf = false
      } else feld += c
    } else if (c === '"') inAnf = true
    else if (c === ',') {
      zeile.push(feld)
      feld = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      zeile.push(feld)
      zeilen.push(zeile)
      zeile = []
      feld = ''
    } else feld += c
  }
  if (feld !== '' || zeile.length > 0) {
    zeile.push(feld)
    zeilen.push(zeile)
  }
  // Leerzeilen (z. B. Dateiende) fallen weg.
  return zeilen.filter((z) => z.some((f) => f.trim() !== ''))
}

export type HistorieStatus = 'erfuellt' | 'storniert' | 'offen'

export interface HistoriePosition {
  sku: string | null
  name: string
  menge: number
  stueckNetto: number
}

export interface HistorieBestellung {
  /** Shopify-Order-ID (Spalte „Id"), falls im Export. */
  id: string | null
  /** Bestellname, z. B. „#38690". */
  name: string
  /** ISO-Zeitpunkt der Bestellung. */
  datum: string
  email: string | null
  kunde: string
  land: string | null
  status: HistorieStatus
  waehrung: string
  /** Steuersatz in Prozent (19). */
  steuersatz: number
  versandNetto: number
  positionen: HistoriePosition[]
}

/** Zahl aus dem Export (Punkt als Dezimaltrenner, leer = 0). */
function zahl(roh: string | undefined): number {
  const t = (roh ?? '').trim()
  if (t === '') return 0
  const n = Number(t.includes(',') && !t.includes('.') ? t.replace(',', '.') : t)
  return Number.isFinite(n) ? n : 0
}

/** „2024-05-03 12:34:56 +0200" → ISO; unbekanntes Format bleibt, wie es ist. */
export function exportDatum(roh: string): string {
  const m = roh.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/)
  if (!m) return roh.trim()
  return `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${m[3]}:${m[4]}`
}

function status(finanz: string, erfuellung: string, storniert: string): HistorieStatus {
  if (storniert.trim() !== '' || finanz.trim().toLowerCase() === 'refunded') return 'storniert'
  if (erfuellung.trim().toLowerCase() === 'fulfilled') return 'erfuellt'
  return 'offen'
}

export interface LeseErgebnis {
  bestellungen: HistorieBestellung[]
  /** Pflichtspalten, die im Export fehlen — dann ist es kein Bestellexport. */
  fehlendeSpalten: string[]
}

const PFLICHT = ['Name', 'Created at', 'Lineitem quantity', 'Lineitem name', 'Lineitem price']

/** Liest einen Shopify-Bestellexport in Historie-Bestellungen. */
export function bestellungenAusExport(text: string): LeseErgebnis {
  const [kopf, ...daten] = csvLesen(text)
  if (!kopf) return { bestellungen: [], fehlendeSpalten: PFLICHT }
  const spalte = new Map(kopf.map((k, i) => [k.trim(), i]))
  const fehlendeSpalten = PFLICHT.filter((p) => !spalte.has(p))
  if (fehlendeSpalten.length > 0) return { bestellungen: [], fehlendeSpalten }
  const wert = (z: string[], k: string) => {
    const i = spalte.get(k)
    return i === undefined ? '' : (z[i] ?? '')
  }

  // Zeilen je Bestellung sammeln; Bestellfelder aus der ersten Zeile.
  const gruppen = new Map<string, string[][]>()
  for (const z of daten) {
    const name = wert(z, 'Name').trim()
    if (!name) continue
    const g = gruppen.get(name)
    if (g) g.push(z)
    else gruppen.set(name, [z])
  }

  const bestellungen: HistorieBestellung[] = []
  for (const [name, zeilen] of gruppen) {
    const kopfzeile = zeilen.find((z) => wert(z, 'Financial Status').trim() !== '') ?? zeilen[0]
    const summen = {
      zwischensumme: zahl(wert(kopfzeile, 'Subtotal')),
      versand: zahl(wert(kopfzeile, 'Shipping')),
      steuern: zahl(wert(kopfzeile, 'Taxes')),
      gesamt: zahl(wert(kopfzeile, 'Total')),
    }
    const inklusive = steuernInklusiveAus(summen)
    const genannt = satzAusName(wert(kopfzeile, 'Tax 1 Name'))
    const basis = inklusive
      ? summen.zwischensumme + summen.versand - summen.steuern
      : summen.zwischensumme + summen.versand
    const satz =
      summen.steuern > 0
        ? (genannt ?? (basis > 0 ? summen.steuern / basis : 0))
        : 0

    const exportZeilen = zeilen.map((z) => ({
      menge: zahl(wert(z, 'Lineitem quantity')),
      preis: zahl(wert(z, 'Lineitem price')),
      rabatt: zahl(wert(z, 'Lineitem discount')),
    }))
    // Ohne Zwischensumme (ältere Exporte) auf die Zeilenwerte selbst skalieren.
    const zwischen =
      wert(kopfzeile, 'Subtotal').trim() === ''
        ? exportZeilen.reduce((s, z) => s + Math.max(0, z.menge * z.preis - z.rabatt), 0)
        : summen.zwischensumme
    const preise = exportPositionenNetto(exportZeilen, zwischen, satz, inklusive)

    const land = (wert(kopfzeile, 'Shipping Country') || wert(kopfzeile, 'Billing Country')).trim()
    const kunde =
      wert(kopfzeile, 'Billing Name').trim() ||
      wert(kopfzeile, 'Shipping Name').trim() ||
      wert(kopfzeile, 'Email').trim() ||
      'Unbekannter Kunde'
    const id = wert(kopfzeile, 'Id').trim()

    bestellungen.push({
      id: /^\d+$/.test(id) ? id : null,
      name,
      datum: exportDatum(wert(kopfzeile, 'Created at')),
      email: wert(kopfzeile, 'Email').trim() || null,
      kunde,
      land: /^[A-Za-z]{2}$/.test(land) ? land.toUpperCase() : null,
      status: status(
        wert(kopfzeile, 'Financial Status'),
        wert(kopfzeile, 'Fulfillment Status'),
        wert(kopfzeile, 'Cancelled at'),
      ),
      waehrung: wert(kopfzeile, 'Currency').trim() || 'EUR',
      steuersatz: satzProzent(satz),
      versandNetto: runden(inklusive && satz > 0 ? summen.versand / (1 + satz) : summen.versand, 2),
      positionen: zeilen
        .map((z, i) => ({
          sku: wert(z, 'Lineitem sku').trim() || null,
          name: wert(z, 'Lineitem name').trim() || 'Position',
          menge: exportZeilen[i].menge,
          stueckNetto: preise[i],
        }))
        .filter((p) => p.menge > 0),
    })
  }
  return { bestellungen, fehlendeSpalten: [] }
}

/** Tage, in denen offene Bestellungen dem Live-Import gehören (API-Fenster). */
export const LIVE_FENSTER_TAGE = 60

/**
 * Was wird übernommen? Abgeschlossene (erfüllt, storniert/erstattet) immer;
 * offene nur, wenn sie älter als das API-Fenster sind — jüngere holt und
 * bearbeitet der Live-Import (Lieferung, Fertigung).
 */
export function wirdUebernommen(b: HistorieBestellung, jetzt: Date = new Date()): boolean {
  if (b.status !== 'offen') return true
  const alter = (jetzt.getTime() - new Date(b.datum).getTime()) / 86_400_000
  return Number.isFinite(alter) && alter > LIVE_FENSTER_TAGE
}

/** Kennzahlen für die Vorschau vor dem Import. */
export function vorschau(bestellungen: HistorieBestellung[], jetzt: Date = new Date()) {
  const genommen = bestellungen.filter((b) => wirdUebernommen(b, jetzt))
  const daten = genommen.map((b) => b.datum).filter(Boolean).sort()
  const umsatz = genommen
    .filter((b) => b.status !== 'storniert')
    .reduce((s, b) => s + b.positionen.reduce((t, p) => t + p.menge * p.stueckNetto, 0), 0)
  return {
    gesamt: bestellungen.length,
    uebernommen: genommen.length,
    offenJung: bestellungen.length - genommen.length,
    storniert: genommen.filter((b) => b.status === 'storniert').length,
    von: daten[0] ?? null,
    bis: daten.at(-1) ?? null,
    umsatzNetto: runden(umsatz, 2),
    skus: [...new Set(genommen.flatMap((b) => b.positionen.map((p) => p.sku)).filter(Boolean))] as string[],
  }
}
