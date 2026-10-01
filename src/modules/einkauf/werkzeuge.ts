/**
 * Werkzeuge/Formen (0107), pur: Beschriftungen und die Lebensdauer-Regel —
 * geteilt von Registry, Ausführung, Oberfläche und Unit-Tests.
 */

export const WERKZEUG_ARTEN = {
  form: 'Form (Spritzguss/Guss)',
  stanzwerkzeug: 'Stanz-/Schneidwerkzeug',
  vorrichtung: 'Vorrichtung/Lehre',
  sonstiges: 'Sonstiges',
} as const
export type WerkzeugArt = keyof typeof WERKZEUG_ARTEN
export const WERKZEUG_ART_NAMEN = Object.keys(WERKZEUG_ARTEN) as [WerkzeugArt, ...WerkzeugArt[]]

export const EIGENTUEMER = { wir: 'Wir', lieferant: 'Lieferant' } as const
export type Eigentuemer = keyof typeof EIGENTUEMER
export const EIGENTUEMER_NAMEN = Object.keys(EIGENTUEMER) as [Eigentuemer, ...Eigentuemer[]]

export const WERKZEUG_STATUS = {
  in_auftrag: 'In Auftrag',
  aktiv: 'Aktiv',
  gesperrt: 'Gesperrt',
  ausgemustert: 'Ausgemustert',
} as const
export type WerkzeugStatus = keyof typeof WERKZEUG_STATUS
export const WERKZEUG_STATUS_NAMEN = Object.keys(WERKZEUG_STATUS) as [WerkzeugStatus, ...WerkzeugStatus[]]

/** Ab diesem Anteil der Lebensdauer erinnert KRNL (regelbasierte Wiedervorlage, 0107). */
export const LEBENSDAUER_WARNUNG = 0.9

/**
 * Stand der Lebensdauer: Anteil in Prozent (abgerundet) und die Stufe —
 * `bald` ab 90 % (wie die Sicht einkauf_regel_wiedervorlagen), `ueber` ab
 * 100 %. Ohne Lebensdauer gibt es keinen Anteil.
 */
export function lebensdauer(
  zaehler: number,
  lebensdauerSchuss: number | null | undefined,
): { pct: number | null; stufe: 'ok' | 'bald' | 'ueber' | 'unbekannt' } {
  if (!lebensdauerSchuss || lebensdauerSchuss <= 0) return { pct: null, stufe: 'unbekannt' }
  const anteil = zaehler / lebensdauerSchuss
  return {
    pct: Math.floor(anteil * 100),
    stufe: anteil >= 1 ? 'ueber' : anteil >= LEBENSDAUER_WARNUNG ? 'bald' : 'ok',
  }
}

/**
 * Darf gebucht werden? Positive Schüsse nur an Werkzeugen in Betrieb (oder
 * noch in Auftrag — Erstbemusterung T0 läuft vor der Freigabe); Korrekturen
 * nach unten immer, aber nie unter null.
 */
export function schussBuchbar(status: WerkzeugStatus, zaehler: number, anzahl: number): string | null {
  if (anzahl === 0) return 'Bitte eine Anzahl ungleich 0 angeben.'
  if (zaehler + anzahl < 0) return `Der Zähler stünde dann unter 0 (aktuell ${zaehler}).`
  if (anzahl > 0 && (status === 'gesperrt' || status === 'ausgemustert')) {
    return `Das Werkzeug ist ${WERKZEUG_STATUS[status].toLowerCase()} — Schüsse nur an Werkzeugen in Betrieb (Korrekturen nach unten gehen).`
  }
  return null
}
