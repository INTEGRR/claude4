import type { Sprache } from './mail-vorlagen.ts'

/**
 * Pflichtdokumente (0108), pur: die Namen der Dokumente in der Sprache des
 * Lieferanten bzw. Spediteurs — für die Nachfrage-Mail (Vorlage
 * „dokumente_nachfragen", Platzhalter {{dokumente}}). Die Regeln selbst sind
 * Daten (pflichtdokument_regeln), welche fehlen, rechnet die Sicht
 * einkauf_offene_pflichtdokumente.
 */

export type PflichtModell = 'purchase_order' | 'eingangs_sendung'
export const PFLICHT_MODELLE: [PflichtModell, ...PflichtModell[]] = ['purchase_order', 'eingangs_sendung']

type Namen = Record<Sprache, string>

const NAMEN: Record<string, Namen> = {
  pi: { de: 'Proforma Invoice (PI)', en: 'Proforma invoice (PI)', zh: '形式发票 (PI)' },
  ci: { de: 'Commercial Invoice (CI)', en: 'Commercial invoice (CI)', zh: '商业发票 (CI)' },
  packing_list: { de: 'Packliste (Packing List)', en: 'Packing list', zh: '装箱单 (Packing List)' },
  rechnung: { de: 'Endrechnung', en: 'Final invoice', zh: '正式发票' },
  bl_awb: { de: 'Konnossement bzw. Luftfrachtbrief (B/L, AWB)', en: 'Bill of lading / air waybill (B/L, AWB)', zh: '提单 / 空运单 (B/L, AWB)' },
  zollbescheid: { de: 'Zollbescheid / Einfuhrabgabenbescheid', en: 'Customs assessment notice', zh: '海关缴税通知' },
}

/** Bei der Sendung ist die „Rechnung" die des Spediteurs. */
const SENDUNG_NAMEN: Record<string, Namen> = {
  rechnung: { de: 'Frachtrechnung (Spediteur)', en: 'Freight invoice', zh: '运费发票' },
}

export function dokumentName(art: string, modell: PflichtModell, sprache: Sprache): string {
  const n = (modell === 'eingangs_sendung' ? SENDUNG_NAMEN[art] : undefined) ?? NAMEN[art]
  return n?.[sprache] ?? art
}

/** Aufzählung für die Mail: je Dokument eine Zeile „- …", doppelte Arten einmal. */
export function dokumenteListe(arten: string[], modell: PflichtModell, sprache: Sprache): string {
  return [...new Set(arten)].map((a) => `- ${dokumentName(a, modell, sprache)}`).join('\n')
}
