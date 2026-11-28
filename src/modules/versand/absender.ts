/** Anschrift der Firma, wie sie in settings.company steht — mit optionalem Versandabsender. */
export interface FirmaAdresse {
  name: string
  street: string
  house: string
  zip: string
  city: string
  versand_name?: string
  versand_street?: string
  versand_house?: string
  versand_zip?: string
  versand_city?: string
}

/**
 * Absender auf dem Versandlabel (Entscheidungslog 2026-11-28): das Lager,
 * wenn es nicht am Firmensitz liegt — dorthin schickt der Paketdienst
 * Unzustellbares zurück. Gepflegt unter Einstellungen → Firma als
 * „Versandabsender"; gilt, sobald Straße, PLZ und Ort gesetzt sind (eine
 * halbe Adresse wird nie mit dem Firmensitz gemischt). Sonst der Firmensitz.
 * Belege (Rechnung, Angebot) nehmen weiter den Firmensitz.
 */
export function versandAbsender<T extends FirmaAdresse>(firma: T): T {
  const strasse = firma.versand_street?.trim()
  const plz = firma.versand_zip?.trim()
  const ort = firma.versand_city?.trim()
  if (!strasse || !plz || !ort) return firma
  return {
    ...firma,
    name: firma.versand_name?.trim() || firma.name,
    street: strasse,
    house: firma.versand_house?.trim() ?? '',
    zip: plz,
    city: ort,
  }
}
