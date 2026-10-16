import { createElement as h, type ReactElement } from 'react'
import { StyleSheet, Text, View } from '@react-pdf/renderer'
import { sql } from '@/db/client'

/**
 * Gemeinsamer Rahmen aller Belege im Haus-Layout (Kundenrechnung 0115,
 * Reparaturauftrag 2026-10-16): Firmendaten, Anschriftblock, Stile,
 * Zahlen- und Datumsformat, der dreispaltige Fuß mit den Pflichtangaben
 * und die Seitenzahl. Bewusst ohne JSX (createElement), damit die
 * Prozesstests dieselben Dokumente unter blankem Node rendern.
 */

export interface Firma {
  name?: string
  street?: string
  house?: string
  zip?: string
  city?: string
  country?: string
  email?: string
  phone?: string
  web?: string
  ust_id?: string
  steuernummer?: string
  registergericht?: string
  handelsregister?: string
  geschaeftsfuehrung?: string
  iban?: string
  bic?: string
  bank?: string
}

export interface Anschrift {
  name?: string | null
  company?: string | null
  street?: string | null
  house?: string | null
  street2?: string | null
  zip?: string | null
  city?: string | null
  country?: string | null
  vat?: string | null
}

const LAENDER: Record<string, string> = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', NL: 'Niederlande', BE: 'Belgien', FR: 'Frankreich',
  IT: 'Italien', ES: 'Spanien', PL: 'Polen', DK: 'Dänemark', SE: 'Schweden', FI: 'Finnland', NO: 'Norwegen',
  LU: 'Luxemburg', CZ: 'Tschechien', GB: 'Vereinigtes Königreich', US: 'USA', IE: 'Irland', PT: 'Portugal',
}

export const belegStile = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 110, paddingHorizontal: 48, fontSize: 9.5, fontFamily: 'Helvetica', color: '#111' },
  kopf: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 26 },
  marke: { fontSize: 20, fontFamily: 'Helvetica-Bold', letterSpacing: 2 },
  absender: { fontSize: 7, color: '#444', marginBottom: 8 },
  anschriftBlock: { width: '55%' },
  anschrift: { fontSize: 10.5, lineHeight: 1.35 },
  daten: { width: '40%' },
  datenZeile: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  datenLabel: { fontSize: 8, color: '#444' },
  datenWert: { fontSize: 8.5, textAlign: 'right', maxWidth: '60%' },
  nummerLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  nummerWert: { fontSize: 12, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  titel: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 10, marginBottom: 12 },
  text: { fontSize: 9.5, lineHeight: 1.4, marginBottom: 8 },
  kopfzeile: { flexDirection: 'row', backgroundColor: '#ececec', paddingVertical: 5, paddingHorizontal: 4, fontFamily: 'Helvetica-Bold' },
  zeile: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 4, borderBottomWidth: 0.5, borderBottomColor: '#ddd' },
  cPos: { width: 28 },
  cText: { flex: 1, paddingRight: 8 },
  cMenge: { width: 62, textAlign: 'right' },
  cPreis: { width: 80, textAlign: 'right' },
  cSumme: { width: 86, textAlign: 'right' },
  fett: { fontFamily: 'Helvetica-Bold' },
  klein: { fontSize: 7.5, color: '#555' },
  summen: { marginTop: 10, alignItems: 'flex-end' },
  summeZeile: { flexDirection: 'row', width: 300, paddingVertical: 4, paddingHorizontal: 6 },
  summeGrau: { backgroundColor: '#ececec' },
  summeLabel: { flex: 1 },
  summeWert: { width: 110, textAlign: 'right' },
  hinweis: { marginTop: 18, fontSize: 9, lineHeight: 1.4 },
  fuss: { position: 'absolute', bottom: 34, left: 48, right: 48, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7, color: '#555', lineHeight: 1.35 },
  fussSpalte: { width: '30%' },
  seite: { position: 'absolute', bottom: 22, right: 48, fontSize: 7, color: '#555' },
})

export const geld = (wert: number, waehrung = 'EUR') =>
  `${Number(wert).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${waehrung}`
export const menge = (wert: number) =>
  Number(wert).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const datum = (iso: string | null | undefined) =>
  iso ? new Date(iso.slice(0, 10)).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : '—'
export const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

export function anschriftZeilen(a: Anschrift): string[] {
  const land = a.country && a.country !== 'DE' ? (LAENDER[a.country] ?? a.country) : a.country === 'DE' ? 'Deutschland' : null
  return [
    a.company && a.company !== a.name ? a.company : null,
    a.name,
    [a.street, a.house].filter(Boolean).join(' ') || null,
    a.street2,
    [a.zip, a.city].filter(Boolean).join(' ') || null,
    land,
  ].filter((z): z is string => Boolean(z))
}

/** Absenderzeile über dem Anschriftfenster: „Firma · Straße 1 · 12345 Ort". */
export function absenderZeile(firma: Firma): string {
  return [firma.name, [firma.street, firma.house].filter(Boolean).join(' '), [firma.zip, firma.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join('  ·  ')
}

/** Eine Zeile im Datenblock rechts (Label links, Wert rechts); fett für die Belegnummer. */
export function datenZeile(label: string, wert: string | null | undefined, fett = false): ReactElement {
  const s = belegStile
  return h(
    View,
    { style: s.datenZeile },
    h(Text, { style: fett ? s.nummerLabel : s.datenLabel }, label),
    h(Text, { style: fett ? s.nummerWert : s.datenWert }, wert ?? '—'),
  )
}

/** Dreispaltiger Fuß mit Anschrift, Kontakt/Bank und den Pflichtangaben der GmbH — auf jeder Seite. */
export function belegFuss(firma: Firma): ReactElement {
  const s = belegStile
  return h(
    View,
    { style: s.fuss, fixed: true },
    h(View, { style: s.fussSpalte },
      h(Text, null, firma.name ?? ''),
      h(Text, null, [firma.street, firma.house].filter(Boolean).join(' ')),
      h(Text, null, [firma.zip, firma.city].filter(Boolean).join(' ')),
      h(Text, null, firma.country === 'DEU' || !firma.country ? 'Deutschland' : firma.country)),
    h(View, { style: s.fussSpalte },
      firma.email ? h(Text, null, `E-Mail: ${firma.email}`) : null,
      firma.phone ? h(Text, null, `Telefon: ${firma.phone}`) : null,
      firma.web ? h(Text, null, `Web: ${firma.web}`) : null,
      firma.iban ? h(Text, null, `IBAN: ${firma.iban}${firma.bic ? ` · BIC: ${firma.bic}` : ''}`) : null,
      firma.bank ? h(Text, null, firma.bank) : null),
    h(View, { style: s.fussSpalte },
      firma.registergericht ? h(Text, null, `Amtsgericht ${firma.registergericht}`) : null,
      firma.handelsregister ? h(Text, null, `HR-Nr.: ${firma.handelsregister}`) : null,
      firma.ust_id ? h(Text, null, `USt-ID: ${firma.ust_id}`) : null,
      firma.steuernummer ? h(Text, null, `Steuer-Nr.: ${firma.steuernummer}`) : null,
      firma.geschaeftsfuehrung ? h(Text, null, `Geschäftsführung: ${firma.geschaeftsfuehrung}`) : null),
  )
}

/** „Seite n von m" unten rechts, auf jeder Seite. */
export function seitenzahl(): ReactElement {
  return h(Text, {
    style: belegStile.seite,
    fixed: true,
    render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Seite ${pageNumber} von ${totalPages}`,
  })
}

/** Firmendaten aus den Einstellungen (Absender, Fuß). */
export async function firmaLaden(): Promise<Firma> {
  const [zeile] = await sql<{ value: Firma | null }[]>`select value from settings where key = 'company'`
  return zeile?.value ?? {}
}
