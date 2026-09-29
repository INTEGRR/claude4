/**
 * Druckwege auflösen — der rechnende Teil ohne Datenbank (Migration 0087,
 * Entscheidungslog 2026-09-29). Jeder Druck geht an den Drucker, den der
 * Arbeitsplatz für diese Druckart eingetragen hat; hat der Platz keinen,
 * an den Ersatzdrucker der Druckart (Weg ohne Arbeitsplatz); gibt es auch
 * den nicht, öffnet das PDF im Browser.
 */

export const DRUCKARTEN = [
  'versandlabel',
  'packzettel',
  'fertigungszettel',
  'fertigungsetikett',
  'artikeletikett',
] as const
export type Druckart = (typeof DRUCKARTEN)[number]

export const DRUCKART_LABELS: Record<Druckart, string> = {
  versandlabel: 'Versandlabel (DHL)',
  packzettel: 'Packzettel/Lieferschein',
  fertigungszettel: 'Fertigungszettel (A4)',
  fertigungsetikett: 'Fertigungsetikett',
  artikeletikett: 'Artikel-Etikett',
}

/** Welcher Druckertyp eine Druckart üblicherweise druckt (Vorschlag in der Auswahl). */
export const DRUCKART_TYP: Record<Druckart, 'label' | 'a4'> = {
  versandlabel: 'label',
  packzettel: 'a4',
  fertigungszettel: 'a4',
  fertigungsetikett: 'label',
  artikeletikett: 'label',
}

export const ARBEITSPLATZ_ARTEN = ['fertigung', 'versand', 'lager', 'sonstiges'] as const
export type ArbeitsplatzArt = (typeof ARBEITSPLATZ_ARTEN)[number]

export const ARBEITSPLATZ_ART_LABELS: Record<ArbeitsplatzArt, string> = {
  fertigung: 'Fertigung',
  versand: 'Versand',
  lager: 'Lager',
  sonstiges: 'Sonstiges',
}

export interface Druckweg {
  /** null = Ersatz für alle Arbeitsplätze ohne eigenen Weg. */
  work_center_id: string | null
  druckart: string
  drucker_id: string
}

export interface Treffer {
  druckerId: string
  /** true, wenn der Ersatzdrucker einspringt, weil der Platz keinen eigenen hat. */
  ersatz: boolean
}

/** Erst der Weg des Arbeitsplatzes, dann der Ersatz — sonst null (= Browser). */
export function druckerFuer(
  wege: readonly Druckweg[],
  arbeitsplatzId: string | null,
  druckart: Druckart,
): Treffer | null {
  if (arbeitsplatzId) {
    const eigen = wege.find((w) => w.work_center_id === arbeitsplatzId && w.druckart === druckart)
    if (eigen) return { druckerId: eigen.drucker_id, ersatz: false }
  }
  const ersatz = wege.find((w) => w.work_center_id === null && w.druckart === druckart)
  return ersatz ? { druckerId: ersatz.drucker_id, ersatz: true } : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Eine ID aus fremder Hand (Arbeitsplatz-Cookie, Drucker-Parameter des
 * Agenten) — nur eine wohlgeformte UUID zählt, kleingeschrieben. Ob der
 * Datensatz existiert und aktiv ist, prüft die Datenbank beim Nachschlagen.
 */
export function idOderNull(wert: string | null | undefined): string | null {
  const v = wert?.trim()
  return v && UUID.test(v) ? v.toLowerCase() : null
}
