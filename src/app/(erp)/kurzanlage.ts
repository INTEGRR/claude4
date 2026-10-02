import 'server-only'
import type { Kurzanlage } from '@/components/kurzanlage-typen'
import type { User } from '@/modules/auth'
import { canWrite, hatRolle } from '@/modules/auth/permissions'
import { artikelKurzAnlegen, kategorieKurzAnlegen, kontaktKurzAnlegen } from './kurzanlage-actions'

/**
 * Die Kurzanlagen der Auswahlboxen — je Thema einmal beschrieben, an jeder
 * Box mit `kurzanlage={kurzLieferant(user)}` eingeschaltet. Ohne
 * Schreibrecht im Bereich gibt es kein Angebot (`undefined`), statt eines
 * Formulars, das am Torwächter scheitert.
 */

const EMAIL = { name: 'email', label: 'E-Mail (optional)', art: 'email' as const, platzhalter: 'name@firma.com' }

export function kurzLieferant(user: User, was = 'Lieferant'): Kurzanlage | undefined {
  if (!canWrite(user.rollen, 'kontakte', user.befugnisse)) return undefined
  return {
    titel: `Neuer ${was}`,
    was,
    felder: [{ name: 'name', label: 'Firmenname', pflicht: true }, EMAIL],
    aktion: kontaktKurzAnlegen.bind(null, 'lieferant'),
  }
}

export function kurzKunde(user: User): Kurzanlage | undefined {
  if (!canWrite(user.rollen, 'kontakte', user.befugnisse)) return undefined
  return {
    titel: 'Neuer Kunde',
    was: 'Kunde',
    felder: [
      { name: 'name', label: 'Name', pflicht: true, platzhalter: 'Vor- und Nachname bzw. Firma' },
      {
        name: 'art',
        label: 'Art',
        art: 'wahl',
        vorgabe: 'person',
        optionen: [
          { wert: 'person', text: 'Person' },
          { wert: 'firma', text: 'Firma' },
        ],
      },
      EMAIL,
    ],
    aktion: kontaktKurzAnlegen.bind(null, 'kunde'),
  }
}

/** Artikel: für den Einkauf einkaufbar (Kaufteil), für den Verkauf verkaufbar. */
export function kurzArtikel(user: User, zweck: 'einkauf' | 'verkauf'): Kurzanlage | undefined {
  if (!canWrite(user.rollen, 'produkte', user.befugnisse)) return undefined
  return {
    titel: zweck === 'einkauf' ? 'Neuer Einkaufsartikel' : 'Neuer Artikel',
    was: 'Artikel',
    felder: [
      { name: 'name', label: 'Bezeichnung', pflicht: true },
      { name: 'sku', label: 'Artikelnummer (optional)', platzhalter: 'z. B. RF-002' },
    ],
    aktion: artikelKurzAnlegen.bind(null, zweck),
  }
}

export function kurzKategorie(user: User): Kurzanlage | undefined {
  if (!hatRolle(user.rollen, 'admin')) return undefined
  return {
    titel: 'Neue Kategorie',
    was: 'Kategorie',
    felder: [{ name: 'name', label: 'Name', pflicht: true }],
    aktion: kategorieKurzAnlegen,
  }
}
