/**
 * Bestandsabgleich, vollständige Liste (Entscheidungslog 2026-11-28) — die
 * reine Einordnung, ohne Datenbank: wie stehen Shop-Stand und KRNL-Meldung
 * eines Angebots zueinander?
 */

export type Einordnung =
  /** Beide Seiten gleich: kaufbar bleibt kaufbar, aus bleibt aus. */
  | 'gleich'
  /** Im Shop kaufbar, KRNL würde 0 melden — der Artikel ginge aus dem Verkauf. */
  | 'nur_shop'
  /** Im Shop ausverkauft, KRNL würde eine Menge melden — der Artikel ginge in den Verkauf. */
  | 'nur_krnl'
  /** Lagerartikel, beide kaufbar, andere Zahl. */
  | 'menge'
  /** Entwurf, archiviert oder im Shop nicht mehr vorhanden: Kunden sehen das Angebot nicht. */
  | 'unsichtbar'

export interface BestandZeile {
  /** Variante in KRNL (auch beim Zweitangebot: der Artikel dahinter). */
  variant_id: string
  template_id: string
  produkt: string
  variante: string
  sku: string | null
  /** Auftragsgefertigt (Tastatur) — sonst Lagerartikel. */
  mto: boolean
  zweitangebot: boolean
  /** Shop: Produktstatus (ACTIVE, UNLISTED, DRAFT, ARCHIVED), FEHLT = beim letzten Lesen nicht mehr dabei, null = nie gelesen. */
  status: string | null
  shop: number | null
  shopKaufbar: boolean
  /** Der Shop verkauft dieses Angebot auch ohne Bestand weiter. */
  ohneBestand: boolean
  krnl: number
  grund: string
  einordnung: Einordnung
}

/**
 * Wie stehen Shop und KRNL zueinander? Bei Tastaturen zählt nur kaufbar
 * ja/nein (die feste Menge ist keine Bestandszahl), bei Lagerartikeln auch
 * die Zahl.
 */
export function einordnen(z: {
  status: string | null
  shopKaufbar: boolean
  shop: number | null
  krnl: number
  mto: boolean
  ohneBestand: boolean
}): Einordnung {
  if (z.status === 'DRAFT' || z.status === 'ARCHIVED' || z.status === 'FEHLT') return 'unsichtbar'
  const krnlKaufbar = z.krnl > 0 || z.ohneBestand
  if (z.shopKaufbar && !krnlKaufbar) return 'nur_shop'
  if (!z.shopKaufbar && krnlKaufbar) return 'nur_krnl'
  if (z.shopKaufbar && !z.mto && !z.ohneBestand && z.shop !== null && z.shop !== z.krnl) return 'menge'
  return 'gleich'
}
