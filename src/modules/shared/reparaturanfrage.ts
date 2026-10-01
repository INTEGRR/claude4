/**
 * Reparaturanfrage aus dem Kundenformular — die Prüfregeln, pur.
 *
 * Eine Quelle für Formular (Browser), API-Route (Server), das Formular im
 * Shop (App Proxy, modules/reparatur/) und den Executor, der die Anfrage
 * annimmt: kein Datenbank-, kein Next-Import, damit das
 * Modul unter blankem Node testbar bleibt (Muster shared/registrierung.ts).
 *
 * Die Feldnamen sind zugleich die feld_definitionen des Prozesses
 * reparatur_anfrage (Migration 0082) — die Werte landen im zusatz-jsonb des
 * Vorgangs. Ein Test gleicht beide Listen ab.
 */
import { EMAIL_MUSTER } from './registrierung.ts'

export const ANFRAGE_FELDER = [
  'kontakt_name',
  'email',
  'telefon',
  'strasse',
  'hausnummer',
  'plz',
  'ort',
  'land',
  'fehlerbeschreibung',
  'bestellnummer',
] as const

export type AnfrageFeld = (typeof ANFRAGE_FELDER)[number]
export type Anfrage = Record<AnfrageFeld, string>

/** Obergrenzen je Feld — beschneiden statt abweisen (Müll-Fluten kosten so nichts). */
export const LAENGEN: Record<AnfrageFeld, number> = {
  kontakt_name: 120,
  email: 160,
  telefon: 60,
  strasse: 160,
  hausnummer: 20,
  plz: 20,
  ort: 120,
  land: 8, // bewusst länger als der Code: ein falscher Wert soll auffallen, nicht passend geschnitten werden
  fehlerbeschreibung: 4000,
  bestellnummer: 60,
}

/** Pflichtfelder — dieselben im Formular (Website und Shop), in der Route und bei der Annahme. */
export const ANFRAGE_PFLICHT: readonly AnfrageFeld[] = [
  'kontakt_name',
  'email',
  'strasse',
  'hausnummer',
  'plz',
  'ort',
  'land',
  'fehlerbeschreibung',
]

/**
 * Beschriftungen für Kunden — eine Quelle für das Formular auf der Website
 * (service/reparatur/anfrageformular.tsx) und das im Shop
 * (modules/reparatur/shop-seiten.ts). Bewusst nicht die Labels der
 * feld_definitionen: die sind für Mitarbeiter („Land (ISO-2)").
 */
export const ANFRAGE_BESCHRIFTUNG: Record<AnfrageFeld, string> = {
  kontakt_name: 'Name',
  email: 'E-Mail',
  telefon: 'Telefon',
  strasse: 'Straße',
  hausnummer: 'Hausnummer',
  plz: 'PLZ',
  ort: 'Ort',
  land: 'Land',
  fehlerbeschreibung: 'Was funktioniert nicht?',
  bestellnummer: 'Bestellnummer',
}

export const ANFRAGE_PLATZHALTER: Partial<Record<AnfrageFeld, string>> = {
  bestellnummer: 'z. B. #1042',
  fehlerbeschreibung:
    'z. B. „Die Leertaste prellt — jeder zweite Anschlag kommt doppelt. Seit etwa zwei Wochen."',
}

/** Länderauswahl beider Formulare (ISO-2-Code und Anzeigename). */
export const ANFRAGE_LAENDER: readonly { code: string; name: string }[] = [
  { code: 'DE', name: 'Deutschland' },
  { code: 'AT', name: 'Österreich' },
  { code: 'CH', name: 'Schweiz' },
  { code: 'NL', name: 'Niederlande' },
  { code: 'BE', name: 'Belgien' },
  { code: 'FR', name: 'Frankreich' },
  { code: 'DK', name: 'Dänemark' },
  { code: 'PL', name: 'Polen' },
]

/** Mindestlänge der Fehlerbeschreibung — Prüfregel unten, im Shop zusätzlich als minlength. */
export const FEHLERBESCHREIBUNG_MIN = 10

const LAND_MUSTER = /^[A-Z]{2}$/

export function normalisiereAnfrage(roh: Record<string, unknown>): Anfrage {
  const daten = {} as Anfrage
  for (const feld of ANFRAGE_FELDER) {
    // Einzeilige Felder: Mehrfach-Leerraum zusammenziehen; die
    // Fehlerbeschreibung behält ihre Zeilenumbrüche.
    const roher = String(roh[feld] ?? '')
    const wert = (feld === 'fehlerbeschreibung' ? roher : roher.replace(/\s+/g, ' '))
      .trim()
      .slice(0, LAENGEN[feld])
    daten[feld] = wert
  }
  daten.land = (daten.land || 'DE').toUpperCase()
  return daten
}

/** Feldfehler in Klartext — leer heißt: alles in Ordnung. */
export function pruefeAnfrage(daten: Anfrage): Partial<Record<AnfrageFeld, string>> {
  const fehler: Partial<Record<AnfrageFeld, string>> = {}
  for (const feld of ANFRAGE_PFLICHT) {
    if (!daten[feld]) fehler[feld] = 'Bitte ausfüllen'
  }
  if (daten.email && !EMAIL_MUSTER.test(daten.email)) fehler.email = 'Bitte eine gültige E-Mail-Adresse angeben'
  if (daten.land && !LAND_MUSTER.test(daten.land)) fehler.land = 'Land als zweistelliger ISO-Code (z. B. DE)'
  if (daten.fehlerbeschreibung && daten.fehlerbeschreibung.length < FEHLERBESCHREIBUNG_MIN) {
    fehler.fehlerbeschreibung = 'Bitte kurz beschreiben, was nicht funktioniert'
  }
  return fehler
}

export interface AnfrageKontakt {
  name: string
  email: string
  telefon?: string
  strasse: string
  hausnummer: string
  plz: string
  ort: string
  land: string
  fehlerbeschreibung: string
  bestellnummer?: string
}

/**
 * Kontakt aus dem zusatz-jsonb eines Vorgangs — für den Executor, der die
 * Anfrage annimmt. Wirft in Klartext, wenn das Nötigste fehlt (eine
 * telefonisch erfasste Anfrage kann unvollständig sein).
 */
export function kontaktAusAnfrage(zusatz: Record<string, unknown>): AnfrageKontakt {
  const daten = normalisiereAnfrage(zusatz)
  const fehler = pruefeAnfrage(daten)
  const fehlende = Object.keys(fehler)
  if (fehlende.length > 0) {
    throw new Error(
      `Die Anfrage ist unvollständig (${fehlende.join(', ')}) — in der Details-Karte ergänzen, dann erneut annehmen.`,
    )
  }
  return {
    name: daten.kontakt_name,
    email: daten.email,
    telefon: daten.telefon || undefined,
    strasse: daten.strasse,
    hausnummer: daten.hausnummer,
    plz: daten.plz,
    ort: daten.ort,
    land: daten.land,
    fehlerbeschreibung: daten.fehlerbeschreibung,
    bestellnummer: daten.bestellnummer || undefined,
  }
}
