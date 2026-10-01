import type { Area } from '../auth/permissions.ts'

/**
 * Belege, an die Einkaufsdokumente (0092) hängen dürfen — pur und
 * app-frei, geteilt von Registry (Schema-Enum), Ausführung (Tabelle für
 * den Existenz-Check, Bereich für das Leserecht) und Oberfläche. Wächst mit
 * den Stufen (Einkaufsprojekt, Sendung, Bemusterung …).
 */
export const DOKUMENT_MODELLE = {
  partner: { tabelle: 'partners', bereich: 'einkauf', label: 'Lieferant' },
  purchase_order: { tabelle: 'purchase_orders', bereich: 'einkauf', label: 'Bestellung' },
  vendor_bill: { tabelle: 'vendor_bills', bereich: 'einkauf', label: 'Lieferantenrechnung' },
  product_template: { tabelle: 'product_templates', bereich: 'produkte', label: 'Artikel' },
  mail_thread: { tabelle: 'mail_threads', bereich: 'einkauf', label: 'Mail-Thread' },
  einkaufsprojekt: { tabelle: 'einkaufsprojekte', bereich: 'einkauf', label: 'Einkaufsprojekt' },
  bemusterung: { tabelle: 'bemusterungen', bereich: 'einkauf', label: 'Muster-Runde' },
  werkzeug: { tabelle: 'werkzeuge', bereich: 'einkauf', label: 'Werkzeug' },
  lieferantenvertrag: { tabelle: 'lieferantenvertraege', bereich: 'einkauf', label: 'Lieferantenvertrag' },
  eingangs_sendung: { tabelle: 'eingangs_sendungen', bereich: 'einkauf', label: 'Eingangssendung' },
} satisfies Record<string, { tabelle: string; bereich: Area; label: string }>

export type DokumentModell = keyof typeof DOKUMENT_MODELLE

export const DOKUMENT_MODELL_NAMEN = Object.keys(DOKUMENT_MODELLE) as [DokumentModell, ...DokumentModell[]]

/** Dokumentarten wie im Enum dokument_art (0092), mit deutscher Beschriftung. */
export const DOKUMENT_ARTEN = {
  zeichnung: 'Zeichnung',
  gerber: 'Gerber',
  step: 'STEP/3D',
  ai: 'AI-Datei (Druck)',
  bom: 'Stückliste (BOM)',
  angebot: 'Angebot',
  pi: 'Proforma Invoice',
  ci: 'Commercial Invoice',
  packing_list: 'Packing List',
  rechnung: 'Rechnung',
  bl_awb: 'B/L bzw. AWB',
  zollbescheid: 'Zollbescheid',
  vertrag: 'Vertrag',
  nda: 'NDA',
  foto: 'Foto',
  bestellung: 'Bestellung (PDF)',
  sonstiges: 'Sonstiges',
} as const

export type DokumentArt = keyof typeof DOKUMENT_ARTEN

export const DOKUMENT_ART_NAMEN = Object.keys(DOKUMENT_ARTEN) as [DokumentArt, ...DokumentArt[]]

/** Art aus dem Dateinamen raten — nur Vorbelegung, der Mensch korrigiert. */
export function artAusDateiname(name: string): DokumentArt {
  const n = name.toLowerCase()
  if (/\.(step|stp|stl|x_t|iges?)$/.test(n)) return 'step'
  if (/gerber|\.(gbr|gtl|gbl|gko|drl|xln)$/.test(n)) return 'gerber'
  if (/\.ai$/.test(n)) return 'ai'
  if (/\b(bom|stückliste|stueckliste)\b/.test(n)) return 'bom'
  if (/\b(pi|proforma)\b/.test(n)) return 'pi'
  if (/packing[\s_-]?list|\bpl\b/.test(n)) return 'packing_list'
  if (/commercial[\s_-]?invoice|\bci\b/.test(n)) return 'ci'
  if (/invoice|rechnung/.test(n)) return 'rechnung'
  if (/quot|angebot|offer/.test(n)) return 'angebot'
  if (/\b(bl|awb|bill of lading)\b/.test(n)) return 'bl_awb'
  if (/\bnda\b/.test(n)) return 'nda'
  if (/\.(dwg|dxf)$|drawing|zeichnung/.test(n)) return 'zeichnung'
  if (/\.(jpe?g|png|heic|webp)$/.test(n)) return 'foto'
  return 'sonstiges'
}

/**
 * Was der Dokument-Leser des Agenten (0109) an die KI gibt: PDF und Bilder
 * direkt; Excel ist ohne Tabellen-Parser „nicht lesbar" (bewusst keine neue
 * Abhängigkeit, Entscheidungslog 2026-10-01); alles andere (STEP, Gerber …)
 * wird nicht gelesen.
 */
export function dokumentLesbarkeit(mime: string | null | undefined, name: string): 'pdf' | 'bild' | 'excel' | 'nicht_lesbar' {
  const m = (mime ?? '').toLowerCase()
  const n = name.toLowerCase()
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(m)) return 'bild'
  if (/\.(xlsx?|xlsm|ods)$/.test(n) || m.includes('spreadsheet') || m.includes('ms-excel')) return 'excel'
  return 'nicht_lesbar'
}

/** Ordnername für Drive: ohne Schrägstriche, sinnvoll gekürzt. */
export function ordnerName(roh: string): string {
  const s = roh.replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim()
  return (s || 'Ohne Namen').slice(0, 100)
}

/** Upload-Stücke: 4 MiB (Vielfaches von 256 KiB, unter der Vercel-Grenze von 4,5 MB). */
export const STUECK_BYTES = 4 * 1024 * 1024
/** Obergrenze je Datei (STEP-Pakete, Gerber-Zips). */
export const MAX_DATEI_BYTES = 2 * 1024 * 1024 * 1024
