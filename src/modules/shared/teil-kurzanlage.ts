/**
 * Teil-Kurzanlage (A4): aus den Feldern der Auswahlbox werden die Parameter
 * von `produkte.produkt_anlegen`. Rein, damit die Regeln testbar bleiben:
 * „Selbst fertigen" ist nicht einkaufbar, ein Preis mit Komma zählt.
 */
export interface TeilParameter {
  einkaufbar: boolean
  route: 'kaufen' | 'fertigen'
  einheit?: string
  einstandspreis?: number
}

export function teilAusKurzanlage(werte: Record<string, string>): TeilParameter | { fehler: string } {
  const fertigen = (werte.beschaffung ?? 'kaufen') === 'fertigen'
  const roh = (werte.kosten ?? '').trim().replace(/\s|€/g, '').replace(',', '.')
  let einstandspreis: number | undefined
  if (roh) {
    einstandspreis = Number(roh)
    if (!Number.isFinite(einstandspreis) || einstandspreis < 0) {
      return { fehler: 'Einstandspreis bitte als Zahl angeben, z. B. 0,35' }
    }
  }
  const einheit = (werte.einheit ?? '').trim() || undefined
  return {
    einkaufbar: !fertigen,
    route: fertigen ? 'fertigen' : 'kaufen',
    ...(einheit ? { einheit } : {}),
    ...(einstandspreis !== undefined ? { einstandspreis } : {}),
  }
}
