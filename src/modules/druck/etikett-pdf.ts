import { createElement as h, type ReactElement } from 'react'
import { Document, Page, Path, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { date, qty } from '../shared/format.ts'
import {
  type ArtikeletikettLayout,
  type CodeMasse,
  type EtikettFormat,
  type FertigungsetikettLayout,
  type Strichcode,
  ZEILENHOEHE,
  artikelCode,
  artikeletikettLayout,
  balkenPfad,
  fertigungsetikettLayout,
  strichcode,
} from './etikett-layout.ts'

/**
 * Fertigungsetikett und Artikel-Etikett als PDF — eine Seite je Etikett,
 * Seitengröße = Etikett des Zieldruckers (etikett-layout.ts). Für die
 * Druckbrücke (Agent druckt mit `fit`) und für den Browser, wenn kein
 * Drucker eingerichtet ist (Entscheidungslog 2026-10-01).
 *
 * Bewusst ohne JSX (`createElement`) und ohne Datenbank: die Daten kommen
 * fertig herein (etiketten.ts lädt sie), so rendern Unit- und Prozesstests
 * unter blankem Node denselben Code wie die App.
 */

export interface FertigungsetikettDaten {
  number: string
  /** Produkt samt Variante (variant_display_name). */
  produkt: string
  sku: string | null
  menge: number
  einheit: string
  termin: string | Date | null
  auftrag: string | null
  shopifyName: string | null
  kunde: string | null
  komponenten: number
}

export interface ArtikeletikettDaten {
  /** Produktname (Vorlage). */
  name: string
  /** Merkmale der Variante, z. B. „Farbe: Weiß · Schalter: Linear". */
  merkmale: string
  sku: string | null
  barcode: string | null
}

const SCHWARZ = '#000'

function codeBild(code: Strichcode, masse: CodeMasse): ReactElement {
  return h(
    Svg,
    { width: masse.breitePt, height: masse.hoehePt, viewBox: `0 0 ${masse.breitePt} ${masse.hoehePt}` },
    h(Path, { d: balkenPfad(code, masse), fill: SCHWARZ }),
  )
}

function zeile(text: string, schriftPt: number, extra: Record<string, unknown> = {}): ReactElement {
  return h(
    Text,
    {
      style: {
        fontSize: schriftPt,
        lineHeight: ZEILENHOEHE,
        maxLines: 1,
        textOverflow: 'ellipsis',
        ...extra,
      },
    },
    text,
  )
}

/**
 * Eine Etikettenseite. Der Inhalt steckt in einem Kasten genau der
 * Innenfläche, der nicht umbricht und überstehenden Text abschneidet — so
 * bleibt es bei EINER Seite je Etikett in voller Etikettengröße, auch wenn
 * ein Name länger ist als geschätzt (die Kopienzahl stimmt immer).
 * Kinder als einzelne Argumente (nicht als Liste) — so braucht React keine
 * Schlüssel.
 */
function seite(format: EtikettFormat, randPt: number, luftPt: number, kinder: ReactElement[], key: string) {
  return h(
    Page,
    {
      key,
      size: [format.breitePt, format.hoehePt],
      style: { padding: randPt, fontFamily: 'Helvetica', color: SCHWARZ },
    },
    h(
      View,
      {
        wrap: false,
        style: {
          // Ein Hauch unter der Innenhöhe: Rundung darf den Kasten nicht
          // „größer als die Seite" machen (react-pdf warnt sonst).
          height: format.hoehePt - 2 * randPt - 0.05,
          overflow: 'hidden',
          flexDirection: 'column',
          // Kürzere Inhalte (Code gekappt, große Etiketten) stehen mittig.
          justifyContent: 'center',
          gap: luftPt,
        },
      },
      ...kinder,
    ),
  )
}

// --- Fertigungsetikett ---------------------------------------------------------

function detailText(d: FertigungsetikettDaten): string {
  return [
    d.sku ? `SKU ${d.sku}` : null,
    d.termin ? `Termin ${date(d.termin)}` : null,
    d.komponenten > 0 ? `${d.komponenten} Komponente${d.komponenten === 1 ? '' : 'n'}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function auftragText(d: FertigungsetikettDaten): string | null {
  if (!d.auftrag) return null
  return `Auftrag ${d.auftrag}${d.shopifyName ? ` (${d.shopifyName})` : ''}${d.kunde ? ` · ${d.kunde}` : ''}`
}

/** Aufbau und Maße eines Fertigungsetiketts — getrennt vom Rendern, damit Tests sie prüfen können. */
export function fertigungsetikettPlan(d: FertigungsetikettDaten, format: EtikettFormat) {
  const code = strichcode(d.number, 'code128')
  const auftrag = auftragText(d)
  const layout = fertigungsetikettLayout(format, code, { name: d.produkt, mitAuftrag: auftrag !== null })
  return { code, layout, details: detailText(d), auftrag }
}

function fertigungsetikettSeite(d: FertigungsetikettDaten, format: EtikettFormat, key: string) {
  const { code, layout, details, auftrag } = fertigungsetikettPlan(d, format)
  const l: FertigungsetikettLayout = layout
  const kinder: ReactElement[] = [
    h(View, { style: { alignItems: 'center' } }, codeBild(code, l.code)),
    h(
      View,
      { style: { flexDirection: 'row', justifyContent: 'space-between', gap: l.luftPt } },
      zeile(d.number, l.schrift.nummer, { fontFamily: 'Helvetica-Bold', flexGrow: 1, flexShrink: 1 }),
      zeile(`${qty(d.menge)} ${d.einheit}`, l.schrift.nummer, { fontFamily: 'Helvetica-Bold', flexShrink: 0 }),
    ),
    zeile(d.produkt, l.schrift.name, { fontFamily: 'Helvetica-Bold', maxLines: l.nameZeilen }),
  ]
  if (l.details && details) kinder.push(zeile(details, l.schrift.text))
  if (l.auftrag && auftrag) kinder.push(zeile(auftrag, l.schrift.text))
  return seite(format, l.randPt, l.luftPt, kinder, key)
}

/** Ein PDF mit einem Etikett je Fertigungsauftrag. */
export async function fertigungsetikettenPdf(
  etiketten: readonly FertigungsetikettDaten[],
  format: EtikettFormat,
): Promise<Buffer> {
  if (etiketten.length === 0) throw new Error('Keine Fertigungsaufträge für Etiketten.')
  const dokument = h(
    Document,
    { title: `Fertigungsetiketten ${etiketten.map((e) => e.number).join(', ')}`, creator: 'KRNL' },
    ...etiketten.map((d, i) => fertigungsetikettSeite(d, format, `mo-${i}`)),
  )
  return renderToBuffer(dokument)
}

// --- Artikel-Etikett -------------------------------------------------------------

/** Aufbau und Maße eines Artikel-Etiketts; null, wenn die Variante weder Barcode noch SKU hat. */
export function artikeletikettPlan(d: ArtikeletikettDaten, format: EtikettFormat) {
  const wahl = artikelCode(d.barcode, d.sku)
  if (!wahl) return null
  const code = strichcode(wahl.wert, wahl.symbol)
  const skuZeile = Boolean(d.sku && d.sku.trim() !== wahl.wert)
  const layout = artikeletikettLayout(format, code, { name: d.name, merkmale: d.merkmale, skuZeile })
  return { code, layout }
}

function artikeletikettSeite(d: ArtikeletikettDaten, format: EtikettFormat, key: string) {
  const plan = artikeletikettPlan(d, format)
  if (!plan) {
    throw new Error(`„${d.name}" hat weder Barcode noch SKU — ohne Code kein Artikel-Etikett.`)
  }
  const l: ArtikeletikettLayout = plan.layout
  const kinder: ReactElement[] = [
    zeile(d.name, l.schrift.name, { fontFamily: 'Helvetica-Bold', maxLines: l.nameZeilen }),
  ]
  if (l.merkmalZeilen > 0 && d.merkmale) {
    kinder.push(zeile(d.merkmale, l.schrift.merkmale, { maxLines: l.merkmalZeilen }))
  }
  kinder.push(
    h(
      View,
      { style: { alignItems: 'center' } },
      codeBild(plan.code, l.code),
      zeile(plan.code.wert, l.schrift.klartext, { fontFamily: 'Courier-Bold', letterSpacing: 0.5 }),
    ),
  )
  if (l.sku && d.sku) kinder.push(zeile(`SKU ${d.sku}`, l.schrift.sku, { fontFamily: 'Helvetica-Bold' }))
  return seite(format, l.randPt, l.luftPt, kinder, key)
}

/** Ein PDF mit `anzahl` gleichen Etiketten je Position, in der Reihenfolge der Positionen. */
export async function artikeletikettenPdf(
  positionen: readonly { daten: ArtikeletikettDaten; anzahl: number }[],
  format: EtikettFormat,
): Promise<Buffer> {
  const seiten: ReactElement[] = []
  for (const [p, { daten, anzahl }] of positionen.entries()) {
    for (let i = 0; i < anzahl; i++) seiten.push(artikeletikettSeite(daten, format, `v${p}-${i}`))
  }
  if (seiten.length === 0) throw new Error('Keine Artikel-Etiketten zu drucken.')
  return renderToBuffer(h(Document, { title: 'Artikel-Etiketten', creator: 'KRNL' }, ...seiten))
}
