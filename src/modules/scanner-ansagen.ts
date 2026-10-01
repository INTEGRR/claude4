/**
 * Sprachansagen des Scanfelds (Entscheidungslog 2026-10-01): feste, kurze
 * Sätze je Ereignis — gesprochen mit derselben Stimme wie „Sprechen". Nur
 * dieser Katalog ist abrufbar (keine freien Texte → keine missbrauchbare
 * Sprachausgabe), die Sätze werden einmal erzeugt und zwischengespeichert.
 * Rein rechnend, ohne Importe: Server-Route und Browser nutzen ihn beide.
 */
export const ANSAGEN = {
  lieferung: 'Lieferung geladen. Artikel scannen.',
  eingang: 'Wareneingang geladen.',
  transfer: 'Transfer geladen.',
  fertigung: 'Fertigungsauftrag geladen.',
  passt: 'Passt.',
  zeile_voll: 'Position vollständig.',
  alles_voll: 'Alles vollständig. Zum Abschluss nochmal scannen.',
  falscher_artikel: 'Falscher Artikel.',
  schon_voll: 'Menge schon erreicht.',
  nicht_komplett: 'Noch nicht alles im Paket.',
  rueckstand: 'Nicht alles vollständig. Der Rest geht in den Rückstand.',
  soll_uebernommen: 'Sollmengen übernommen. Zum Buchen nochmal scannen.',
  bestaetigen: 'Zum Buchen nochmal scannen.',
  label_bestaetigen: 'Alles im Paket. Nochmal scannen für das Label.',
  gebucht: 'Gebucht.',
  versandfertig: 'Versandfertig. Das Label kommt.',
  nicht_gefunden: 'Nicht gefunden.',
  wartet_fertigung: 'Wartet noch auf die Fertigung.',
  schon_erledigt: 'Schon erledigt.',
  keine_rechte: 'Keine Berechtigung.',
  fehler: 'Fehler. Bitte auf den Bildschirm schauen.',
} as const

export type AnsageSchluessel = keyof typeof ANSAGEN

export const ANSAGE_SCHLUESSEL = Object.keys(ANSAGEN) as AnsageSchluessel[]

/** Stand der Sätze — ändert sich ein Text, hier hochzählen (Browser-Cache). */
export const ANSAGE_STAND = '1'

export function istAnsage(wert: string): wert is AnsageSchluessel {
  return Object.hasOwn(ANSAGEN, wert)
}

/** Fehlermeldung des Servers → passende Ansage (Klartext bleibt am Bildschirm). */
export function ansageFuerFehler(text: string | null | undefined): AnsageSchluessel {
  const t = text ?? ''
  if (/nicht gefunden|kein beleg|keine lieferung gefunden/i.test(t)) return 'nicht_gefunden'
  if (/wartet auf die fertigung/i.test(t)) return 'wartet_fertigung'
  if (/bereits|storniert|abgeschlossen/i.test(t)) return 'schon_erledigt'
  if (/rechte|vorbehalten|nicht angemeldet|berechtigung/i.test(t)) return 'keine_rechte'
  return 'fehler'
}
