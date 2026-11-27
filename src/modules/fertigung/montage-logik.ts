/**
 * Montage-Übersicht (0141, Entscheidungslog 2026-11-27): offene
 * Fertigungsmengen als Baum — erst nach einem Stichwort im Produktnamen
 * (HE / MX), dann je Attribut in der eingestellten Reihenfolge (Mounting
 * Plate, Switches). Rein, ohne Datenbank: die Seite und die Live-Abfrage
 * rechnen mit denselben Funktionen.
 */
export interface MontageEinstellung {
  /** Stichwörter im Produktnamen als oberste Ebene; leer = keine Namens-Ebene. */
  nameTeile: string[]
  /** Attributnamen als weitere Ebenen, in dieser Reihenfolge. */
  attribute: string[]
}

export const MONTAGE_STANDARD: MontageEinstellung = { nameTeile: [], attribute: [] }

export interface MontageZeile {
  /** Produktname (Vorlage), z. B. „NATIVE 1800 HE (QWERTZ) Plague Black". */
  produkt: string
  /** Attributwerte der Variante: Attributname → Wert. */
  werte: Record<string, string>
  /** Noch zu bauen (Soll − gebaut) über alle offenen Fertigungsaufträge der Variante. */
  offen: number
}

export interface MontageKnoten {
  /** Pfad von oben, eindeutig — Schlüssel für Animation und Vergleich. */
  schluessel: string
  label: string
  offen: number
  kinder: MontageKnoten[]
}

export const OHNE = '—'
export const SONSTIGE = 'Sonstige'

const klein = (s: string) => s.toLowerCase()

/** Welches Stichwort steht als eigenes Wort im Produktnamen? Das erste der Liste gewinnt; keins → „Sonstige". */
export function nameTeil(produkt: string, teile: string[]): string {
  const woerter = klein(produkt).split(/[^a-z0-9äöüß]+/i).filter(Boolean)
  for (const t of teile) {
    const gesucht = klein(t).split(/\s+/).filter(Boolean)
    if (gesucht.length === 0) continue
    for (let i = 0; i + gesucht.length <= woerter.length; i++) {
      if (gesucht.every((w, j) => woerter[i + j] === w)) return t
    }
  }
  return SONSTIGE
}

/** Der Pfad einer Zeile durch die Ebenen, z. B. ['HE', 'FR4', 'Gateron - Jade Max']. */
export function montagePfad(z: MontageZeile, e: MontageEinstellung): string[] {
  const pfad: string[] = []
  if (e.nameTeile.length > 0) pfad.push(nameTeil(z.produkt, e.nameTeile))
  for (const a of e.attribute) pfad.push(z.werte[a] ?? OHNE)
  // Ohne jede Ebene bleibt das Produkt selbst die Gruppe.
  return pfad.length > 0 ? pfad : [z.produkt]
}

/** Baum der offenen Mengen; je Ebene die größte Gruppe zuerst. */
export function montageBaum(zeilen: MontageZeile[], e: MontageEinstellung): { gesamt: number; knoten: MontageKnoten[] } {
  const wurzel: MontageKnoten = { schluessel: '', label: '', offen: 0, kinder: [] }
  for (const z of zeilen) {
    if (!(z.offen > 0)) continue
    wurzel.offen += z.offen
    let k = wurzel
    for (const label of montagePfad(z, e)) {
      const schluessel = k.schluessel ? `${k.schluessel} › ${label}` : label
      let kind = k.kinder.find((x) => x.label === label)
      if (!kind) {
        kind = { schluessel, label, offen: 0, kinder: [] }
        k.kinder.push(kind)
      }
      kind.offen += z.offen
      k = kind
    }
  }
  const sortieren = (k: MontageKnoten) => {
    k.kinder.sort((a, b) => b.offen - a.offen || a.label.localeCompare(b.label, 'de'))
    k.kinder.forEach(sortieren)
  }
  sortieren(wurzel)
  // Die Namens-Ebene behält die eingestellte Reihenfolge (HE vor MX), „Sonstige" hinten.
  if (e.nameTeile.length > 0) {
    const rang = (label: string) => {
      const i = e.nameTeile.indexOf(label)
      return i < 0 ? e.nameTeile.length : i
    }
    wurzel.kinder.sort((a, b) => rang(a.label) - rang(b.label))
  }
  return { gesamt: wurzel.offen, knoten: wurzel.kinder }
}

/** Die größten Bündel ganz unten im Baum — „12 × HE · FR4 · Jade Max". */
export function montageBuendel(knoten: MontageKnoten[], hoechstens = 6): { schluessel: string; pfad: string[]; offen: number }[] {
  const blaetter: { schluessel: string; pfad: string[]; offen: number }[] = []
  const lauf = (k: MontageKnoten, pfad: string[]) => {
    const hier = [...pfad, k.label]
    if (k.kinder.length === 0) blaetter.push({ schluessel: k.schluessel, pfad: hier, offen: k.offen })
    else for (const c of k.kinder) lauf(c, hier)
  }
  for (const k of knoten) lauf(k, [])
  return blaetter.sort((a, b) => b.offen - a.offen || a.schluessel.localeCompare(b.schluessel, 'de')).slice(0, hoechstens)
}

/** „HE, MX" → ['HE', 'MX'] — Eingabe der Einstellung, ohne Leeres und Doppeltes. */
export function listeAusText(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean))].slice(0, 12)
}
