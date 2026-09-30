import type { Sprache } from './mail-vorlagen.ts'

/**
 * Einkaufsprojekt (0097), pur: Beschriftungen, Staffeln aus Text lesen,
 * der Positionsblock der Anfrage je Sprache und die Zusammenfassung des
 * Angebotsvergleichs. Frei von Datenbank-Importen — Registry, Oberfläche
 * und Unit-Tests teilen es.
 */

export const PROJEKT_ARTEN = {
  nachproduktion: 'Nachproduktion',
  neuteil: 'Neuteil',
  werkzeug: 'Werkzeug / Form',
  muster: 'Muster',
  betriebsausstattung: 'Betriebsausstattung',
} as const
export type ProjektArt = keyof typeof PROJEKT_ARTEN
export const PROJEKT_ART_NAMEN = Object.keys(PROJEKT_ARTEN) as [ProjektArt, ...ProjektArt[]]

export const FRACHT_MODI = { see: 'See', luft: 'Luft', express: 'Express' } as const
export type FrachtModus = keyof typeof FRACHT_MODI
export const FRACHT_MODUS_NAMEN = Object.keys(FRACHT_MODI) as [FrachtModus, ...FrachtModus[]]

export const ANFRAGE_STATUS = {
  entwurf: 'Entwurf',
  angefragt: 'Angefragt',
  angebot: 'Angebot da',
  abgesagt: 'Abgesagt',
} as const

/** Hinweise aus einstand_schaetzen — was der Schätzung fehlt. */
export const HINWEISE = {
  kein_preis: 'kein Preis für diese Position',
  kein_kurs: 'kein Wechselkurs',
  unter_staffel: 'Menge unter der kleinsten Staffel',
  unter_moq: 'Menge unter MOQ',
  kein_gewicht: 'kein Gewicht — Fracht fehlt',
  kein_frachtsatz: 'kein Frachtsatz',
  kein_hs: 'kein HS-Code — Zoll fehlt',
  kein_zollsatz: 'kein Zollsatz zum HS-Code',
  abgelaufen: 'Angebot abgelaufen',
} as const
export type Hinweis = keyof typeof HINWEISE

/** Hinweise, ohne die ein Angebot nicht vergleichbar ist (Einstand fehlt ganz). */
const BLOCKIEREND: readonly string[] = ['kein_preis', 'kein_kurs']

/**
 * Zahl aus deutscher oder englischer Schreibweise: „0,85", „0.85",
 * „1.234,5", „1,234.5". Bei `mengen` gilt „1.000" als tausend (deutsch),
 * bei Preisen als 1,0 — Preise mit Tausenderpunkt sind im Einkauf selten,
 * Mengen mit Dezimalpunkt auch.
 */
export function zahlLesen(roh: string, art: 'menge' | 'preis' = 'preis'): number | null {
  let s = roh.replace(/[\s']/g, '').replace(/[^\d.,-]/g, '')
  if (!s || !/\d/.test(s)) return null
  const punkt = s.lastIndexOf('.')
  const komma = s.lastIndexOf(',')
  if (punkt >= 0 && komma >= 0) {
    const dezimal = punkt > komma ? '.' : ','
    const tausend = dezimal === '.' ? ',' : '.'
    s = s.split(tausend).join('').replace(dezimal, '.')
  } else if (komma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) && art === 'menge' ? s.replace(/,/g, '') : s.replace(',', '.')
  } else if (punkt >= 0 && art === 'menge' && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export interface Staffel {
  ab_menge: number
  preis: number
}

/**
 * Staffeln aus Text, eine je Zeile: „500: 0,85", „ab 1.000 = 0,72",
 * „2000 pcs → 0.65". Eine Zeile nur mit Preis gilt ab 1 Stück. Leere
 * Zeilen und Kommentare (#) zählen nicht; unlesbare Zeilen kommen als
 * Fehler zurück statt still zu verschwinden.
 */
export function staffelnLesen(text: string): { staffeln: Staffel[]; fehler: string[] } {
  const staffeln: Staffel[] = []
  const fehler: string[] = []
  for (const roh of text.split(/\r?\n/)) {
    const zeile = roh.trim()
    if (!zeile || zeile.startsWith('#')) continue
    const paar = zeile.match(/^(?:ab\s*)?([\d.,'\s]+?)\s*(?:stk\.?|stück|pcs|pc|件)?\s*(?::|=|→|->|;|\t|\s)\s*(?:[a-z¥$€]{0,4}\s*)?([\d.,]+)\s*[a-z¥$€]{0,4}\s*$/i)
    const allein = zeile.match(/^(?:[a-z¥$€]{0,4}\s*)?([\d.,]+)\s*[a-z¥$€]{0,4}$/i)
    let ab: number | null = null
    let preis: number | null = null
    if (paar) {
      ab = zahlLesen(paar[1], 'menge')
      preis = zahlLesen(paar[2], 'preis')
    } else if (allein) {
      ab = 1
      preis = zahlLesen(allein[1], 'preis')
    }
    if (ab === null || preis === null || ab <= 0 || preis < 0) {
      fehler.push(`„${zeile}" ist keine Staffel (Format „Menge: Preis")`)
      continue
    }
    const vorhanden = staffeln.findIndex((s) => s.ab_menge === ab)
    if (vorhanden >= 0) staffeln[vorhanden] = { ab_menge: ab, preis }
    else staffeln.push({ ab_menge: ab, preis })
  }
  staffeln.sort((a, b) => a.ab_menge - b.ab_menge)
  return { staffeln, fehler }
}

/** Staffeln zurück in die Eingabeform (zum Bearbeiten). */
export function staffelnText(staffeln: { ab_menge: number | string; preis: number | string }[]): string {
  return staffeln
    .map((s) => `${Number(s.ab_menge).toLocaleString('de-DE')}: ${String(Number(s.preis)).replace('.', ',')}`)
    .join('\n')
}

/** Die Staffel, die bei `menge` gilt — größte ab_menge ≤ Menge, sonst die kleinste (wie einstand_schaetzen). */
export function staffelFuer<T extends { ab_menge: number }>(staffeln: T[], menge: number): T | undefined {
  const passend = staffeln.filter((s) => s.ab_menge <= menge).sort((a, b) => b.ab_menge - a.ab_menge)
  return passend[0] ?? [...staffeln].sort((a, b) => a.ab_menge - b.ab_menge)[0]
}

// --- Anfrage-Text -------------------------------------------------------

const EINHEITEN: Record<string, Record<Sprache, string>> = {
  Stück: { de: 'Stück', en: 'pcs', zh: '件' },
  Dutzend: { de: 'Dutzend', en: 'dozen', zh: '打' },
  Hundert: { de: 'Hundert', en: 'hundreds', zh: '百' },
}

export function einheitText(uom: string | null | undefined, sprache: Sprache): string {
  const u = uom || 'Stück'
  return EINHEITEN[u]?.[sprache] ?? u
}

const TEXTE: Record<Sprache, { referenz: string; menge: string; termin: string; offen: string; datum: (d: string) => string }> = {
  de: {
    referenz: 'Unsere Referenz',
    menge: 'Menge',
    termin: 'Gewünschter Liefertermin',
    offen: 'nach Absprache',
    datum: (d) => d.split('-').reverse().join('.'),
  },
  en: { referenz: 'Our reference', menge: 'Quantity', termin: 'Required delivery date', offen: 'to be agreed', datum: (d) => d },
  zh: { referenz: '我方参考编号', menge: '数量', termin: '期望交期', offen: '可协商', datum: (d) => d },
}

export interface AnfragePosition {
  bezeichnung: string
  menge: number
  einheit?: string | null
  spezifikation?: string | null
}

/**
 * Der Positionsblock der Anfrage in der Sprache des Lieferanten —
 * Referenz (EP-Nummer: Antworten finden so ihr Projekt), Positionen mit
 * Menge, Liefertermin. Der Zielpreis steht bewusst NICHT darin.
 */
export function anfrageBlock(
  sprache: Sprache,
  projekt: { nummer: string; titel: string; zieltermin?: string | null },
  positionen: AnfragePosition[],
): string {
  const t = TEXTE[sprache]
  const zahl = (n: number) => (sprache === 'de' ? n.toLocaleString('de-DE') : n.toLocaleString('en-US'))
  const trenner = sprache === 'zh' ? '：' : ': '
  const zeilen = positionen.map((p, i) => {
    const spez = p.spezifikation?.trim() ? ` (${p.spezifikation.trim().replace(/\s*\n\s*/g, '; ')})` : ''
    return `${i + 1}. ${p.bezeichnung}${spez} – ${t.menge}${trenner}${zahl(p.menge)} ${einheitText(p.einheit, sprache)}`
  })
  return [
    `${t.referenz}${trenner}${projekt.nummer} – ${projekt.titel}`,
    '',
    ...zeilen,
    '',
    `${t.termin}${trenner}${projekt.zieltermin ? t.datum(projekt.zieltermin) : t.offen}`,
  ].join('\n')
}

/** Die leeren Stichpunkte der Anfrage-Vorlagen (0094) je Sprache. */
const VORLAGEN_STICHPUNKTE: Record<Sprache, RegExp> = {
  de: /- Artikel:[^\n]*\n- Menge\(n\):[^\n]*\n- Gewünschter Liefertermin:[^\n]*/,
  en: /- Part:[^\n]*\n- Quantity\/quantities:[^\n]*\n- Required delivery date:[^\n]*/,
  zh: /- 产品：[^\n]*\n- 数量：[^\n]*\n- 期望交期：[^\n]*/,
}

/**
 * Setzt den Positionsblock in den Vorlagentext: an die Stelle der leeren
 * Stichpunkte der Standardvorlage; hat jemand die Vorlage umgeschrieben,
 * nach dem ersten Absatz (hinter der Anrede).
 */
export function anfrageBlockEinsetzen(text: string, block: string, sprache: Sprache): string {
  const muster = VORLAGEN_STICHPUNKTE[sprache]
  if (muster.test(text)) return text.replace(muster, () => block)
  const absatz = text.indexOf('\n\n')
  if (absatz < 0) return `${text}\n\n${block}`
  const zweiter = text.indexOf('\n\n', absatz + 2)
  const stelle = zweiter < 0 ? text.length : zweiter
  return `${text.slice(0, stelle)}\n\n${block}${text.slice(stelle)}`
}

/** Betreff der Anfrage je Sprache — die EP-Nummer darin ordnet Antworten zu. */
export function anfrageBetreff(sprache: Sprache, projekt: { nummer: string; titel: string }): string {
  const vorsatz = { de: 'Preisanfrage', en: 'Request for quotation', zh: '询价' }[sprache]
  return `${vorsatz} ${projekt.nummer} – ${projekt.titel}`
}

// --- Angebotsvergleich --------------------------------------------------

export interface EinstandZeile {
  position_id: string
  menge: number | string
  einstand_eur: number | string | null
  zielpreis_eur: number | string | null
  hinweise: string[]
}

export interface AngebotSumme {
  /** Summe Einstand × Menge über alle Positionen (EUR), null wenn eine Position fehlt. */
  gesamt: number | null
  /** Summe Zielpreis × Menge, soweit Zielpreise gesetzt sind. */
  ziel: number | null
  /** Abweichung zum Ziel in %, nur wenn für jede Position ein Zielpreis steht. */
  abweichungPct: number | null
  vollstaendig: boolean
  hinweise: string[]
}

export function angebotSumme(zeilen: EinstandZeile[]): AngebotSumme {
  let gesamt = 0
  let ziel = 0
  let alleZiele = zeilen.length > 0
  let vollstaendig = zeilen.length > 0
  const hinweise = new Set<string>()
  for (const z of zeilen) {
    for (const h of z.hinweise) hinweise.add(h)
    const menge = Number(z.menge)
    if (z.einstand_eur === null || z.hinweise.some((h) => BLOCKIEREND.includes(h))) vollstaendig = false
    else gesamt += Number(z.einstand_eur) * menge
    if (z.zielpreis_eur === null) alleZiele = false
    else ziel += Number(z.zielpreis_eur) * menge
  }
  const hatZiel = zeilen.some((z) => z.zielpreis_eur !== null)
  return {
    gesamt: vollstaendig ? Math.round(gesamt * 100) / 100 : null,
    ziel: hatZiel ? Math.round(ziel * 100) / 100 : null,
    abweichungPct: vollstaendig && alleZiele && ziel > 0 ? Math.round(((gesamt - ziel) / ziel) * 1000) / 10 : null,
    vollstaendig,
    hinweise: [...hinweise],
  }
}

/** Das günstigste vollständige Angebot (nicht verworfen) — die Markierung im Vergleich. */
export function bestesAngebot(angebote: { id: string; verworfen: boolean; summe: AngebotSumme }[]): string | null {
  const kandidaten = angebote.filter((a) => !a.verworfen && a.summe.gesamt !== null)
  if (!kandidaten.length) return null
  return kandidaten.reduce((best, a) => (a.summe.gesamt! < best.summe.gesamt! ? a : best)).id
}
