import 'server-only'
import { cache } from 'react'
import { sql } from '@/db/client'
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

/** Die Mengeneinheiten für die Teil-Kurzanlage — je Anfrage einmal gelesen. */
export const kurzEinheiten = cache(async (): Promise<string[]> => {
  const zeilen = await sql<{ name: string }[]>`
    select u.name from uoms u where u.active order by (u.name = 'Stück') desc, u.category_id, u.ratio`
  return zeilen.map((z) => z.name)
})

/**
 * Artikel: für den Verkauf verkaufbar; als Teil (Einkauf, Stückliste) mit
 * Einheit, Einstandspreis und Kaufen/Fertigen (A4) — genug, damit Bedarf,
 * Kalkulation und Beschaffung vom ersten Moment an stimmen.
 */
export function kurzArtikel(
  user: User,
  zweck: 'einkauf' | 'verkauf',
  einheiten: string[] = [],
): Kurzanlage | undefined {
  if (!canWrite(user.rollen, 'produkte', user.befugnisse)) return undefined
  const felder: Kurzanlage['felder'] = [
    { name: 'name', label: 'Bezeichnung', pflicht: true },
    { name: 'sku', label: 'Artikelnummer (optional)', platzhalter: 'z. B. RF-002' },
  ]
  if (zweck === 'einkauf') {
    if (einheiten.length > 1) {
      felder.push({
        name: 'einheit',
        label: 'Einheit',
        art: 'wahl',
        vorgabe: einheiten[0],
        optionen: einheiten.map((e) => ({ wert: e, text: e })),
      })
    }
    felder.push(
      { name: 'kosten', label: 'Einstandspreis je Einheit (optional)', art: 'zahl', platzhalter: 'z. B. 0,35' },
      {
        name: 'beschaffung',
        label: 'Beschaffung',
        art: 'wahl',
        vorgabe: 'kaufen',
        optionen: [
          { wert: 'kaufen', text: 'Kaufen' },
          { wert: 'fertigen', text: 'Selbst fertigen' },
        ],
      },
    )
  }
  return {
    titel: zweck === 'einkauf' ? 'Neues Teil' : 'Neuer Artikel',
    was: zweck === 'einkauf' ? 'Teil' : 'Artikel',
    felder,
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
