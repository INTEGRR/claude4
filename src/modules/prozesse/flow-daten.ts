/**
 * Datenaufbereitung fürs Prozessdiagramm — rein und DB-frei, damit unter
 * Node testbar. Positionen berechnet ELK (flow-layout.ts, serverseitig),
 * gerendert wird mit React Flow (prozess-flow.tsx).
 *
 * Hier entsteht, WAS das Diagramm zeigt: Schrittart, Verknüpfung
 * (Aktion/Job/Ereignis/Teilprozess), Belegzustand, Rollen, Laufzeit-Zustand
 * (aktuell/erledigt/abgeschaltet) und der Fortschritt von Teilprozessen.
 */

export type FlowArt =
  | 'start'
  | 'aktion'
  | 'dienst'
  | 'ereignis'
  | 'matching'
  | 'prozess'
  | 'xor'
  | 'ende'

export interface FlowSchritt {
  code: string
  name: string
  art: FlowArt
  optional?: boolean
  abgeschaltet?: boolean
  /** Verknüpfung je Art: Registry-Aktion, Job, Ereignis-Topic, Kindprozess. */
  aktion?: string | null
  job_kind?: string | null
  ereignis?: string | null
  teilprozess?: string | null
  /** Belegzustand NACH dem Schritt (Standort-Mapping). */
  zustand?: string | null
  rollen?: string[] | null
  /** Nur mit Beleg: Stand des Teilprozesses (art = prozess). */
  teilprozessStand?: { gesamt: number; fertig: number } | null
}

export interface FlowKante {
  von: string
  nach: string
  sequence: number
  beschriftung?: string | null
}

export interface FlowKnoten {
  id: string
  breite: number
  hoehe: number
  daten: FlowSchritt & {
    aktuell: boolean
    erledigt: boolean
    verknuepfung: string | null
  }
}

export interface FlowVerbindung {
  id: string
  von: string
  nach: string
  beschriftung: string | null
  /** Kante zwischen erledigten Schritten bzw. zum aktuellen hin — gedimmt/betont. */
  erledigt: boolean
  aktiv: boolean
}

/** Knotengrößen — ELK braucht sie vorab, der Renderer hält sie ein. */
export const MASSE: Record<'rund' | 'xor' | 'schritt', { b: number; h: number }> = {
  rund: { b: 132, h: 40 },
  xor: { b: 56, h: 56 },
  schritt: { b: 232, h: 66 },
}

export function flowDaten(
  schritte: FlowSchritt[],
  kanten: FlowKante[],
  aktuellerSchritt?: string | null,
): { knoten: FlowKnoten[]; verbindungen: FlowVerbindung[] } {
  const codes = new Set(schritte.map((s) => s.code))
  const gueltig = kanten.filter((k) => codes.has(k.von) && codes.has(k.nach))

  // Erledigt = alle Vorfahren des aktuellen Schritts.
  const erledigt = new Set<string>()
  if (aktuellerSchritt && codes.has(aktuellerSchritt)) {
    const rueckwaerts = [aktuellerSchritt]
    while (rueckwaerts.length > 0) {
      const code = rueckwaerts.pop()!
      for (const k of gueltig.filter((k) => k.nach === code)) {
        if (!erledigt.has(k.von)) {
          erledigt.add(k.von)
          rueckwaerts.push(k.von)
        }
      }
    }
  }

  const knoten: FlowKnoten[] = schritte.map((s) => {
    const masse =
      s.art === 'start' || s.art === 'ende'
        ? MASSE.rund
        : s.art === 'xor'
          ? MASSE.xor
          : MASSE.schritt
    // Start/Ende-Pillen wachsen mit dem Text, statt ihn abzuschneiden.
    const breite =
      s.art === 'start' || s.art === 'ende'
        ? Math.max(masse.b, Math.round(s.name.length * 7.2) + 52)
        : masse.b
    return {
      id: s.code,
      breite,
      hoehe: masse.h,
      daten: {
        ...s,
        aktuell: s.code === aktuellerSchritt,
        erledigt: erledigt.has(s.code),
        verknuepfung: s.aktion ?? s.job_kind ?? s.ereignis ?? s.teilprozess ?? null,
      },
    }
  })

  const verbindungen: FlowVerbindung[] = gueltig
    .sort((a, b) => a.sequence - b.sequence)
    .map((k) => ({
      id: `${k.von}->${k.nach}`,
      von: k.von,
      nach: k.nach,
      beschriftung: k.beschriftung ?? null,
      erledigt:
        (erledigt.has(k.von) || k.von === aktuellerSchritt) &&
        (erledigt.has(k.nach) || k.nach === aktuellerSchritt),
      aktiv: k.von === aktuellerSchritt,
    }))

  return { knoten, verbindungen }
}
