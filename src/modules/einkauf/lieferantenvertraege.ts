import { zahlLesen } from './einkaufsprojekt.ts'

/**
 * Lieferantenverträge (0107), pur: Beschriftungen, die Lage eines Vertrags
 * für die Anzeige und das Lesen einer Preisliste aus Text — geteilt von
 * Registry, Ausführung, Oberfläche und Unit-Tests. Laufzeitende und
 * Kündigungsstichtag rechnet die Datenbank (lieferantenvertrag_ende/
 * _stichtag) — hier wird nur gelesen, was sie liefert, damit Liste,
 * Wiedervorlage und Akte dieselbe Wahrheit zeigen.
 *
 * Nicht verwechseln: `vertraege` sind die Fixkosten-Verträge der Finanzen.
 */

export const VERTRAG_ARTEN = {
  nda: 'NDA (Geheimhaltung)',
  qsv: 'QSV (Qualitätssicherung)',
  rahmenvertrag: 'Rahmenvertrag',
  preisliste: 'Preisliste',
} as const
export type VertragArt = keyof typeof VERTRAG_ARTEN
export const VERTRAG_ART_NAMEN = Object.keys(VERTRAG_ARTEN) as [VertragArt, ...VertragArt[]]

/** Arten, aus denen Lieferantenpreise entstehen können. */
export const MIT_PREISEN: readonly VertragArt[] = ['preisliste', 'rahmenvertrag']

export const VERTRAG_STATUS = { aktiv: 'Aktiv', gekuendigt: 'Gekündigt', beendet: 'Beendet' } as const
export type VertragStatus = keyof typeof VERTRAG_STATUS
export const VERTRAG_STATUS_NAMEN = Object.keys(VERTRAG_STATUS) as [VertragStatus, ...VertragStatus[]]

/** Lage für Schild und Liste — aus Status und den Daten der Datenbank. */
export const VERTRAG_LAGEN = {
  aktiv: 'Aktiv',
  faellig: 'Frist läuft',
  abgelaufen: 'Abgelaufen',
  gekuendigt: 'Gekündigt',
  beendet: 'Beendet',
} as const
export type VertragLage = keyof typeof VERTRAG_LAGEN

function tageZurueck(iso: string, tage: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - tage)
  return d.toISOString().slice(0, 10)
}

/**
 * Wo steht ein Vertrag heute? `ende`/`stichtag` kommen aus
 * lieferantenvertrag_ende/_stichtag (ISO-Datum oder null = unbefristet).
 * „Frist läuft" gilt ab Stichtag − Vorlauf — dieselbe Regel wie die Sicht
 * einkauf_regel_wiedervorlagen.
 */
export function vertragsLage(
  v: { status: VertragStatus; ende: string | null; stichtag: string | null; erinnerung_tage: number },
  heute: string,
): VertragLage {
  if (v.status === 'beendet') return 'beendet'
  if (v.status === 'gekuendigt') return v.ende && v.ende < heute ? 'beendet' : 'gekuendigt'
  if (!v.ende) return 'aktiv'
  if (v.ende < heute) return 'abgelaufen'
  if (v.stichtag && tageZurueck(v.stichtag, v.erinnerung_tage) <= heute) return 'faellig'
  return 'aktiv'
}

export interface PreislistenZeile {
  produkt: string
  ab_menge: number
  preis: number
}

const EINHEIT = String.raw`(?:stk\.?|stück|pcs|pc|件)?`
const WAEHRUNG = '[a-z¥$€]{0,4}'
/** „SKU / 500: 0,72" — Artikel, Menge, Preis. */
const MIT_MENGE = new RegExp(
  String.raw`^(.+?)\s*\/\s*(?:ab\s*)?([\d.,'\s]+?)\s*${EINHEIT}\s*(?::|=|→|->)\s*(?:${WAEHRUNG}\s*)?([\d.,]+)\s*${WAEHRUNG}\s*$`,
  'i',
)
/** „SKU: 0,72" — ab 1 Stück. */
const OHNE_MENGE = new RegExp(String.raw`^(.+?)\s*(?::|=|→|->)\s*(?:${WAEHRUNG}\s*)?([\d.,]+)\s*${WAEHRUNG}\s*$`, 'i')

/**
 * Preisliste aus Text, eine Zeile je Preis:
 *   „KC-PBT-01 / 500: 0,72"   (Artikel / ab Menge: Preis)
 *   „KC-PBT-01: 0,85"         (ab 1 Stück)
 *   „KC-PBT-01;1000;0.65"     bzw. tabgetrennt aus Excel kopiert.
 * Leere Zeilen und Kommentare (#) zählen nicht; unlesbare Zeilen kommen als
 * Fehler zurück statt still zu verschwinden (wie staffelnLesen). Doppelte
 * Artikel/Mengen-Paare: die letzte Zeile gilt.
 */
export function preislisteLesen(text: string): { zeilen: PreislistenZeile[]; fehler: string[] } {
  const zeilen: PreislistenZeile[] = []
  const fehler: string[] = []
  for (const roh of text.split(/\r?\n/)) {
    const zeile = roh.trim()
    if (!zeile || zeile.startsWith('#')) continue
    let produkt: string | undefined
    let menge: number | null = 1
    let preis: number | null = null

    if (/[\t;]/.test(zeile)) {
      const teile = zeile.split(/[\t;]+/).map((t) => t.trim()).filter(Boolean)
      if (teile.length === 3) {
        produkt = teile[0]
        menge = zahlLesen(teile[1], 'menge')
        preis = zahlLesen(teile[2], 'preis')
      } else if (teile.length === 2) {
        produkt = teile[0]
        preis = zahlLesen(teile[1], 'preis')
      }
    } else {
      const mit = zeile.match(MIT_MENGE)
      const ohne = mit ? null : zeile.match(OHNE_MENGE)
      if (mit) {
        produkt = mit[1].trim()
        menge = zahlLesen(mit[2], 'menge')
        preis = zahlLesen(mit[3], 'preis')
      } else if (ohne) {
        produkt = ohne[1].trim()
        preis = zahlLesen(ohne[2], 'preis')
      }
    }

    if (!produkt || menge === null || preis === null || menge <= 0 || preis < 0) {
      fehler.push(`„${zeile}" ist keine Preiszeile (Format „Artikel / Menge: Preis")`)
      continue
    }
    const vorhanden = zeilen.findIndex((z) => z.produkt.toLowerCase() === produkt!.toLowerCase() && z.ab_menge === menge)
    if (vorhanden >= 0) zeilen[vorhanden] = { produkt, ab_menge: menge, preis }
    else zeilen.push({ produkt, ab_menge: menge, preis })
  }
  return { zeilen, fehler }
}
