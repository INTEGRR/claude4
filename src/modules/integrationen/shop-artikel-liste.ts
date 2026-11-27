import type { TeilInfo, WeitererArtikel } from './shop-verfuegbarkeit'

/**
 * Shop-Verfügbarkeit, Ansicht „Teile und Artikel" (Entscheidungslog
 * 2026-11-27): EINE Liste statt zwei Karten untereinander. Jede Zeile ist ein
 * Artikel, der in der Stückliste einer Shop-Tastatur steckt, selbst im Shop
 * angeboten wird — oder beides. Rein: zusammenführen, filtern, suchen;
 * geblättert wird auf der Seite.
 */
export interface ListenZeile {
  id: string
  sku: string | null
  name: string
  frei: number
  /** In so vielen Shop-Tastaturen verbaut (0 = kein Stücklistenartikel). */
  stuecklisten: number
  /** Was für Tastaturen zählt (nach „aus unter"/„zurückhalten") — nur Stücklistenartikel. */
  nutzbar: number | null
  /** Einzelverkauf im Shop — null = wird selbst nicht im Shop angeboten. */
  shop: WeitererArtikel | null
  oosUnter: number | null
  zurueck: boolean
}

export type JaNein = 'ja' | 'nein' | null

export function jaNein(wert: string | string[] | undefined): JaNein {
  const v = Array.isArray(wert) ? wert[0] : wert
  return v === 'ja' || v === 'nein' ? v : null
}

export function artikelListe(
  teile: (TeilInfo & { artikel: number })[],
  weitere: WeitererArtikel[],
): ListenZeile[] {
  const zeilen = new Map<string, ListenZeile>()
  for (const t of teile) {
    zeilen.set(t.id, {
      id: t.id, sku: t.sku, name: t.name, frei: t.frei, stuecklisten: t.artikel, nutzbar: t.nutzbar,
      shop: null, oosUnter: t.oosUnter, zurueck: t.zurueck,
    })
  }
  for (const w of weitere) {
    const da = zeilen.get(w.id)
    if (da) da.shop = w
    else {
      zeilen.set(w.id, {
        id: w.id, sku: w.sku, name: w.name, frei: w.frei, stuecklisten: 0, nutzbar: null,
        shop: w, oosUnter: w.oosUnter, zurueck: w.zurueck,
      })
    }
  }
  return [...zeilen.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

const klein = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')

/** Filter „Stücklistenartikel ja/nein", „Shopartikel ja/nein" und Suche (jedes Wort in Name oder Artikelnummer). */
export function listeFiltern(
  zeilen: ListenZeile[],
  f: { stueckliste: JaNein; shop: JaNein; q: string },
): ListenZeile[] {
  const woerter = klein(f.q).split(/\s+/).filter(Boolean)
  return zeilen.filter((z) => {
    if (f.stueckliste === 'ja' && z.stuecklisten === 0) return false
    if (f.stueckliste === 'nein' && z.stuecklisten > 0) return false
    if (f.shop === 'ja' && !z.shop) return false
    if (f.shop === 'nein' && z.shop) return false
    if (woerter.length === 0) return true
    const text = klein(`${z.name} ${z.sku ?? ''}`)
    return woerter.every((w) => text.includes(w))
  })
}
