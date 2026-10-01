import bwipjs from 'bwip-js/node'

/**
 * Etiketten der Druckbrücke (Fertigungs- und Artikel-Etikett, Druckarten
 * aus 0087) — der rechnende Teil ohne Datenbank und ohne PDF: Format des
 * Zieldruckers, Wahl des Symbols, Strichmuster und die Aufteilung der
 * Fläche. Unter blankem Node testbar (tests/etiketten.test.ts); gerendert
 * wird in etikett-pdf.ts (Entscheidungslog 2026-10-01).
 *
 * Barcodes gehen als Vektor (Balken als ein Pfad) ins PDF statt als Bild:
 * der Etikettendrucker rastert sie selbst — nichts verschwimmt, wenn
 * SumatraPDF das Etikett einpasst (`fit`), saubere Kanten bei 203 und
 * 300 dpi. Kodiert wird mit bwip-js (für Belege ohnehin im Projekt); hier
 * wird nur dessen Rohmuster (Balken-/Lückenbreiten) übernommen.
 */

/** Format, wenn der Zieldrucker keine Maße hat (Browser, A4-Ersatz). */
export const ETIKETT_STANDARD_MM = { breite: 100, hoehe: 50 } as const

/** Mehr Etiketten nimmt ein Druckwunsch nicht an (je Variante gilt die Grenze der Tabelle: 500). */
export const MAX_ETIKETTEN_JE_DRUCK = 2000
export const MAX_ANZAHL_JE_VARIANTE = 500

const PT_JE_MM = 72 / 25.4

export function mmZuPt(mm: number): number {
  return mm * PT_JE_MM
}

export interface EtikettFormat {
  breiteMm: number
  hoeheMm: number
  breitePt: number
  hoehePt: number
}

function mass(wert: number | string | null | undefined): number | null {
  if (wert === null || wert === undefined || wert === '') return null
  const n = Number(wert)
  return Number.isFinite(n) && n >= 15 && n <= 400 ? n : null
}

/**
 * Seitenformat = Etikett des Zieldruckers (`drucker.breite_mm × hoehe_mm`,
 * in dieser Lage). Fehlt ein Maß oder ist es unplausibel, gilt 100 × 50 mm.
 */
export function etikettFormat(
  breiteMm?: number | string | null,
  hoeheMm?: number | string | null,
): EtikettFormat {
  const b = mass(breiteMm)
  const h = mass(hoeheMm)
  const breite = b !== null && h !== null ? b : ETIKETT_STANDARD_MM.breite
  const hoehe = b !== null && h !== null ? h : ETIKETT_STANDARD_MM.hoehe
  return { breiteMm: breite, hoeheMm: hoehe, breitePt: mmZuPt(breite), hoehePt: mmZuPt(hoehe) }
}

// --- Symbolwahl --------------------------------------------------------------

export type Symbologie = 'code128' | 'ean13'

/** Prüfziffer einer EAN-13 aus den ersten zwölf Ziffern (Gewichte 1, 3, 1, 3 …). */
export function ean13Pruefziffer(zwoelf: string): number {
  if (!/^\d{12}$/.test(zwoelf)) throw new Error(`„${zwoelf}" sind keine zwölf Ziffern`)
  let summe = 0
  for (let i = 0; i < 12; i++) summe += Number(zwoelf[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (summe % 10)) % 10
}

export function ean13Gueltig(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13Pruefziffer(code.slice(0, 12)) === Number(code[12])
}

/**
 * Der Code des Artikel-Etiketts: der Barcode der Variante (gültige EAN-13
 * als EAN, alles andere als Code 128), sonst die SKU als Code 128 — dieselbe
 * Wahl wie Fertigungszettel und Packzettel, damit der Gegenscan am Packtisch
 * (scanGleich: Barcode oder SKU) jedes Etikett erkennt.
 */
export function artikelCode(
  barcode: string | null | undefined,
  sku: string | null | undefined,
): { wert: string; symbol: Symbologie } | null {
  const b = barcode?.trim()
  if (b) return { wert: b, symbol: ean13Gueltig(b) ? 'ean13' : 'code128' }
  const s = sku?.trim()
  return s ? { wert: s, symbol: 'code128' } : null
}

// --- Strichmuster --------------------------------------------------------------

export interface Strichcode {
  symbol: Symbologie
  wert: string
  /** Breite des Symbols ohne Ruhezonen, in Modulen (schmalste Strichbreite). */
  module: number
  /** Ruhezone je Seite in Modulen (Code 128: 10, EAN-13: 11). */
  ruhezone: number
  /** Die Balken: Anfang und Breite in Modulen, gezählt ab dem ersten Balken. */
  balken: { x: number; breite: number }[]
}

/** Kodiert den Wert und liefert die Balken (bwip-js-Rohmuster: Balken, Lücke, Balken …). */
export function strichcode(wert: string, symbol: Symbologie = 'code128'): Strichcode {
  let roh: { sbs?: number[] }[]
  try {
    roh = bwipjs.raw(symbol, wert, '') as { sbs?: number[] }[]
  } catch {
    throw new Error(
      `„${wert}" lässt sich nicht als ${symbol === 'ean13' ? 'EAN-13' : 'Code 128'} drucken`,
    )
  }
  const sbs = roh[0]?.sbs ?? []
  const balken: { x: number; breite: number }[] = []
  let x = 0
  sbs.forEach((breite, i) => {
    if (i % 2 === 0) balken.push({ x, breite })
    x += breite
  })
  return { symbol, wert, module: x, ruhezone: symbol === 'ean13' ? 11 : 10, balken }
}

/** Breiteste Strichbreite: 0,4 mm — breiter bringt dem Scanner nichts mehr. */
export const MODUL_MAX_MM = 0.4

export interface CodeMasse {
  /** Breite eines Moduls in pt. */
  modulPt: number
  /** Breite samt Ruhezonen in pt. */
  breitePt: number
  hoehePt: number
}

/** So breit wie möglich (höchstens MODUL_MAX_MM je Modul), samt Ruhezonen in der verfügbaren Breite. */
export function codeMasse(code: Strichcode, verfuegbarPt: number, hoehePt: number): CodeMasse {
  const gesamt = code.module + 2 * code.ruhezone
  const modulPt = Math.min(mmZuPt(MODUL_MAX_MM), verfuegbarPt / gesamt)
  return { modulPt, breitePt: modulPt * gesamt, hoehePt }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Die Balken als EIN SVG-Pfad (Rechtecke, Koordinaten in pt, Ruhezone links
 * eingerechnet) — die Fläche des Symbols ist `masse.breitePt × hoehePt`.
 */
export function balkenPfad(code: Strichcode, masse: CodeMasse): string {
  const m = masse.modulPt
  return code.balken
    .map((b) => {
      const x = r3((code.ruhezone + b.x) * m)
      const w = r3(b.breite * m)
      return `M${x} 0h${w}v${r3(masse.hoehePt)}h${-w}Z`
    })
    .join('')
}

// --- Aufteilung der Fläche -----------------------------------------------------

/** Zeilenabstand als Vielfaches der Schriftgröße. */
export const ZEILENHOEHE = 1.18
/** Darunter wird der Barcode unzuverlässig — erst Text kürzen, dann den Code. */
export const CODE_MIN_MM = 8

/** Maßstab gegenüber dem Standardetikett 100 × 50 mm, begrenzt auf 0,5 … 1,6. */
export function etikettMassstab(format: EtikettFormat): number {
  const s = Math.min(format.breiteMm / ETIKETT_STANDARD_MM.breite, format.hoeheMm / ETIKETT_STANDARD_MM.hoehe)
  return Math.min(1.6, Math.max(0.5, s))
}

function schrift(basis: number, s: number, min: number): number {
  return Math.max(min, Math.round(basis * s * 10) / 10)
}

/**
 * Grobe Zeilenzahl eines Texts (Helvetica, mittlere Zeichenbreite) — nur
 * für die Flächenplanung; abgeschnitten wird beim Rendern mit Ellipse.
 */
export function geschaetzteZeilen(text: string, schriftPt: number, breitePt: number, fett = false): number {
  if (!text) return 0
  const zeichenBreite = schriftPt * (fett ? 0.58 : 0.53)
  return Math.max(1, Math.ceil((text.length * zeichenBreite) / Math.max(breitePt, 1)))
}

interface Grundmasse {
  s: number
  randPt: number
  luftPt: number
  innenBreitePt: number
  innenHoehePt: number
}

function grundmasse(format: EtikettFormat): Grundmasse {
  const s = etikettMassstab(format)
  const randPt = mmZuPt(Math.max(1.5, 2.5 * s))
  return {
    s,
    randPt,
    luftPt: mmZuPt(Math.max(0.6, 1.2 * s)),
    innenBreitePt: format.breitePt - 2 * randPt,
    innenHoehePt: format.hoehePt - 2 * randPt,
  }
}

export interface FertigungsetikettLayout {
  format: EtikettFormat
  randPt: number
  luftPt: number
  innenBreitePt: number
  schrift: { nummer: number; name: number; text: number }
  nameZeilen: number
  details: boolean
  auftrag: boolean
  code: CodeMasse
}

/**
 * Fertigungsetikett: oben der Code der MO-Nummer, darunter Nummer und
 * Menge groß, Produkt/Variante, Details (SKU · Termin · Komponenten),
 * Verkaufsauftrag und Kunde. Wird der Code zu flach, fallen zuerst die
 * zweite Namenszeile, dann Auftrag, dann Details weg.
 */
export function fertigungsetikettLayout(
  format: EtikettFormat,
  code: Strichcode,
  inhalt: { name: string; mitAuftrag: boolean },
): FertigungsetikettLayout {
  const g = grundmasse(format)
  const f = {
    nummer: schrift(17, g.s, 9),
    name: schrift(10, g.s, 6),
    text: schrift(8, g.s, 5.5),
  }
  let nameZeilen = Math.min(2, geschaetzteZeilen(inhalt.name, f.name, g.innenBreitePt, true))
  let auftrag = inhalt.mitAuftrag
  let details = true

  const codeHoehe = () => {
    const bloecke = [f.nummer, nameZeilen * f.name, details ? f.text : 0, auftrag ? f.text : 0]
    const text = bloecke.reduce((a, b) => a + b * ZEILENHOEHE, 0)
    const luecken = bloecke.filter((b) => b > 0).length
    return g.innenHoehePt - text - luecken * g.luftPt
  }
  const schritte: (() => void)[] = [
    () => { nameZeilen = Math.min(nameZeilen, 1) },
    () => { auftrag = false },
    () => { details = false },
  ]
  for (const schritt of schritte) {
    if (codeHoehe() >= mmZuPt(CODE_MIN_MM)) break
    schritt()
  }
  const hoehe = Math.min(mmZuPt(18 * g.s), Math.max(mmZuPt(4), codeHoehe()))
  return {
    format,
    randPt: g.randPt,
    luftPt: g.luftPt,
    innenBreitePt: g.innenBreitePt,
    schrift: f,
    nameZeilen,
    details,
    auftrag,
    code: codeMasse(code, g.innenBreitePt, hoehe),
  }
}

export interface ArtikeletikettLayout {
  format: EtikettFormat
  randPt: number
  luftPt: number
  innenBreitePt: number
  schrift: { name: number; merkmale: number; klartext: number; sku: number }
  nameZeilen: number
  merkmalZeilen: number
  /** SKU als eigene Zeile — nur, wenn der Code nicht schon die SKU ist. */
  sku: boolean
  code: CodeMasse
}

/**
 * Artikel-Etikett: Name, Merkmale der Variante, der Code mit Klartext
 * darunter und — wenn der Code ein Barcode ist — die SKU. Zu flach?
 * Erst Merkmale und Name auf eine Zeile, dann SKU, dann Merkmale weg.
 */
export function artikeletikettLayout(
  format: EtikettFormat,
  code: Strichcode,
  inhalt: { name: string; merkmale: string; skuZeile: boolean },
): ArtikeletikettLayout {
  const g = grundmasse(format)
  const f = {
    name: schrift(12, g.s, 7),
    merkmale: schrift(8.5, g.s, 5.5),
    klartext: schrift(9, g.s, 5.5),
    sku: schrift(9, g.s, 5.5),
  }
  let nameZeilen = Math.min(2, geschaetzteZeilen(inhalt.name, f.name, g.innenBreitePt, true))
  let merkmalZeilen = Math.min(2, geschaetzteZeilen(inhalt.merkmale, f.merkmale, g.innenBreitePt))
  let sku = inhalt.skuZeile

  const codeHoehe = () => {
    const bloecke = [nameZeilen * f.name, merkmalZeilen * f.merkmale, f.klartext, sku ? f.sku : 0]
    const text = bloecke.reduce((a, b) => a + b * ZEILENHOEHE, 0)
    const luecken = bloecke.filter((b) => b > 0).length
    return g.innenHoehePt - text - luecken * g.luftPt
  }
  const schritte: (() => void)[] = [
    () => { merkmalZeilen = Math.min(merkmalZeilen, 1) },
    () => { nameZeilen = Math.min(nameZeilen, 1) },
    () => { sku = false },
    () => { merkmalZeilen = 0 },
  ]
  for (const schritt of schritte) {
    if (codeHoehe() >= mmZuPt(CODE_MIN_MM)) break
    schritt()
  }
  const hoehe = Math.min(mmZuPt(20 * g.s), Math.max(mmZuPt(4), codeHoehe()))
  return {
    format,
    randPt: g.randPt,
    luftPt: g.luftPt,
    innenBreitePt: g.innenBreitePt,
    schrift: f,
    nameZeilen,
    merkmalZeilen,
    sku,
    code: codeMasse(code, g.innenBreitePt, hoehe),
  }
}

// --- Positionen im Link (PDF im Browser) ---------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface EtikettPosition {
  variantId: string
  anzahl: number
}

/** `<uuid>:<anzahl>,…` — so reisen Artikel-Etiketten in den Browser-Link. */
export function positionenAlsParameter(positionen: readonly EtikettPosition[]): string {
  return positionen.map((p) => `${p.variantId}:${p.anzahl}`).join(',')
}

/**
 * Gegenstück zu positionenAlsParameter: nur wohlgeformte IDs, Anzahl auf
 * 1 … 500 begrenzt, gleiche Varianten zusammengefasst, insgesamt höchstens
 * MAX_ETIKETTEN_JE_DRUCK — fremde Links drucken keine 10.000 Seiten.
 */
export function positionenAusParameter(text: string | null | undefined): EtikettPosition[] {
  const summe = new Map<string, number>()
  for (const teil of (text ?? '').split(',')) {
    const [id, anzahlText] = teil.trim().split(':')
    if (!id || !UUID.test(id)) continue
    const anzahl = Math.trunc(Number(anzahlText ?? '1'))
    if (!Number.isFinite(anzahl) || anzahl < 1) continue
    const schluessel = id.toLowerCase()
    summe.set(schluessel, Math.min(MAX_ANZAHL_JE_VARIANTE, (summe.get(schluessel) ?? 0) + anzahl))
  }
  const ergebnis: EtikettPosition[] = []
  let gesamt = 0
  for (const [variantId, anzahl] of summe) {
    const rest = MAX_ETIKETTEN_JE_DRUCK - gesamt
    if (rest <= 0) break
    ergebnis.push({ variantId, anzahl: Math.min(anzahl, rest) })
    gesamt += Math.min(anzahl, rest)
  }
  return ergebnis
}
