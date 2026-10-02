/**
 * Kontakt aus der Kurzanlage (Auswahlbox): ein Namensfeld, Firma oder
 * Person. Bei Personen ist das letzte Wort der Nachname — „Anna Maria
 * Müller" → Vorname „Anna Maria", Nachname „Müller"; ein einzelnes Wort ist
 * der Nachname. Rein, damit es ohne Datenbank testbar ist.
 */
export interface KontaktKurz {
  name?: string
  vorname?: string
  nachname?: string
  is_company: boolean
  is_customer: boolean
  is_vendor: boolean
  email?: string
}

export function kontaktAusKurzanlage(
  rolle: 'kunde' | 'lieferant',
  werte: Record<string, string>,
): KontaktKurz | { fehler: string } {
  const name = (werte.name ?? '').trim().replace(/\s+/g, ' ')
  if (!name) return { fehler: 'Bitte einen Namen angeben' }
  const art = werte.art || (rolle === 'lieferant' ? 'firma' : 'person')
  const email = (werte.email ?? '').trim() || undefined
  const basis = { is_customer: rolle === 'kunde', is_vendor: rolle === 'lieferant', email }
  if (art === 'firma') return { ...basis, name, is_company: true }
  const teile = name.split(' ')
  const nachname = teile.pop()!
  return { ...basis, vorname: teile.length ? teile.join(' ') : undefined, nachname, is_company: false }
}
