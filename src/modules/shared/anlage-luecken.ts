/**
 * Anlage-Lücken eines Verkaufsprodukts (A6): was fehlt, damit aus einer
 * Bestellung von selbst Fertigung oder Einkauf wird. Rein — die Seiten
 * (Produkt, Produktliste, Shop-Verfügbarkeit) zeigen dieselben Sätze.
 */
export interface AnlageStand {
  route_buy: boolean
  route_manufacture: boolean
  /** aktive Stücklisten des Produkts */
  stuecklisten: number
  /** Positionen über alle aktiven Stücklisten */
  positionen: number
  /** aktive Varianten ohne Artikelnummer */
  ohne_sku: number
  varianten: number
}

export interface AnlageLuecke {
  art: 'route' | 'stueckliste' | 'positionen' | 'sku'
  text: string
}

export function anlageLuecken(s: AnlageStand): AnlageLuecke[] {
  const luecken: AnlageLuecke[] = []
  if (!s.route_buy && !s.route_manufacture) {
    luecken.push({
      art: 'route',
      text: 'Keine Route (weder Einkaufen noch Fertigen) — aus Bedarf entsteht kein Vorschlag und kein Auftrag.',
    })
  }
  if (s.route_manufacture && s.stuecklisten === 0) {
    luecken.push({
      art: 'stueckliste',
      text: 'Route „Fertigen", aber keine Stückliste — es entsteht kein Fertigungsauftrag, der Shop bekommt keine baubare Menge.',
    })
  } else if (s.route_manufacture && s.positionen === 0) {
    luecken.push({ art: 'positionen', text: 'Die Stückliste hat keine Positionen.' })
  }
  if (s.ohne_sku > 0) {
    luecken.push({
      art: 'sku',
      text:
        s.ohne_sku === s.varianten
          ? 'Keine Variante hat eine Artikelnummer.'
          : `${s.ohne_sku} von ${s.varianten} Varianten ohne Artikelnummer.`,
    })
  }
  return luecken
}
