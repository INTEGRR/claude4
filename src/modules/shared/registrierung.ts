/**
 * Prüfregeln des Registrierungsformulars der öffentlichen Startseite —
 * EINE Quelle für beide Seiten: das Formular prüft damit vorab (damit
 * niemand für einen Tippfehler auf den Server wartet), der Endpunkt prüft
 * damit verbindlich. Bewusst rein: kein Datenbank-, kein Next-Import, damit
 * die Regeln unter blankem Node testbar bleiben.
 */

export const EMAIL_MUSTER = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Feldlängen — zugleich die Obergrenze gegen Müll-Fluten. */
export const LAENGEN = {
  firma: 160,
  ansprechpartner: 120,
  email: 160,
  telefon: 60,
  nutzer: 20,
  heutiges_system: 40,
  ablauf: 4000,
} as const

export type RegistrierungsFeld = keyof typeof LAENGEN

export interface RegistrierungsDaten {
  firma: string
  ansprechpartner: string
  email: string
  telefon: string
  nutzer: string
  heutiges_system: string
  ablauf: string
}

export type RegistrierungsFehler = Partial<Record<RegistrierungsFeld, string>>

/** Beschneidet jedes Feld auf seine Höchstlänge und trimmt. */
export function normalisiereRegistrierung(roh: Record<string, unknown>): RegistrierungsDaten {
  const feld = (name: RegistrierungsFeld) =>
    String(roh[name] ?? '').trim().slice(0, LAENGEN[name])
  return {
    firma: feld('firma'),
    ansprechpartner: feld('ansprechpartner'),
    email: feld('email'),
    telefon: feld('telefon'),
    nutzer: feld('nutzer'),
    heutiges_system: feld('heutiges_system'),
    ablauf: feld('ablauf'),
  }
}

/**
 * Pflichtfelder: Firma, Ansprechpartner, gültige E-Mail und die eigentliche
 * Frage („welcher Ablauf klemmt?"). Telefon, Nutzerzahl und Altsystem sind
 * freiwillig — sie erhöhen nur die Qualität des Erstgesprächs.
 */
export function pruefeRegistrierung(daten: RegistrierungsDaten): RegistrierungsFehler {
  const fehler: RegistrierungsFehler = {}
  if (!daten.firma) fehler.firma = 'Bitte Unternehmen angeben.'
  if (!daten.ansprechpartner) fehler.ansprechpartner = 'Bitte Ansprechpartner angeben.'
  if (!EMAIL_MUSTER.test(daten.email)) fehler.email = 'Gültige E-Mail nötig.'
  if (!daten.ablauf) fehler.ablauf = 'Kurz beschreiben, welcher Ablauf klemmt.'
  return fehler
}
