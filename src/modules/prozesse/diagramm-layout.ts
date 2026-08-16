/**
 * Layout für Prozessdiagramme — rein und DB-frei, damit unter Node testbar.
 *
 * Spalten-Layout statt Sugiyama: Prozesse sind azyklisch (die Aktivierung
 * erzwingt das) und haben wenige Zweige. Zeile = längster Pfad vom Start
 * (Rang), Spalte = Zweig: die erste ausgehende Kante bleibt in der Spalte
 * des Vorgängers, jede weitere öffnet rechts eine neue; Zusammenführungen
 * fallen auf die kleinste Spalte ihrer Vorgänger zurück.
 */

export interface LayoutSchritt {
  code: string
  name: string
  art: 'start' | 'aktion' | 'dienst' | 'ereignis' | 'matching' | 'prozess' | 'xor' | 'ende'
  optional?: boolean
  abgeschaltet?: boolean
}

export interface LayoutKante {
  von: string
  nach: string
  sequence: number
  beschriftung?: string | null
}

export interface Knoten extends LayoutSchritt {
  x: number
  y: number
  breite: number
  hoehe: number
  aktuell: boolean
  erledigt: boolean
}

export interface Kante {
  pfad: string
  beschriftung?: string | null
  textX: number
  textY: number
}

export interface Diagramm {
  breite: number
  hoehe: number
  knoten: Knoten[]
  kanten: Kante[]
}

const KNOTEN_B = 176
const KNOTEN_H = 40
const XOR_SEITE = 48
const SPALTE_B = 216
const ZEILE_H = 76
const RAND = 16

export function layout(
  schritte: LayoutSchritt[],
  kanten: LayoutKante[],
  aktuellerSchritt?: string | null,
): Diagramm {
  const codes = new Set(schritte.map((s) => s.code))
  const gueltig = kanten.filter((k) => codes.has(k.von) && codes.has(k.nach))

  // Rang = längster Pfad vom Start (Bellman über topologische Reihenfolge).
  const rang = new Map<string, number>()
  for (const s of schritte) rang.set(s.code, 0)
  // Kahn-Reihenfolge; der Graph ist validiert azyklisch, die Schleife hier
  // bricht defensiv trotzdem ab.
  const eingang = new Map<string, number>()
  for (const s of schritte) eingang.set(s.code, 0)
  for (const k of gueltig) eingang.set(k.nach, (eingang.get(k.nach) ?? 0) + 1)
  const reihe: string[] = schritte.filter((s) => (eingang.get(s.code) ?? 0) === 0).map((s) => s.code)
  const topo: string[] = []
  for (let i = 0; i < reihe.length && topo.length <= schritte.length; i++) {
    const code = reihe[i]
    topo.push(code)
    for (const k of gueltig.filter((k) => k.von === code)) {
      rang.set(k.nach, Math.max(rang.get(k.nach) ?? 0, (rang.get(code) ?? 0) + 1))
      const rest = (eingang.get(k.nach) ?? 1) - 1
      eingang.set(k.nach, rest)
      if (rest === 0) reihe.push(k.nach)
    }
  }

  // Spalten: erste Kante erbt, weitere öffnen rechts; Joins nehmen das Minimum.
  const spalte = new Map<string, number>()
  for (const code of topo) {
    if (!spalte.has(code)) spalte.set(code, 0)
    const ausgehend = gueltig
      .filter((k) => k.von === code)
      .sort((a, b) => a.sequence - b.sequence)
    ausgehend.forEach((k, index) => {
      const vorschlag = (spalte.get(code) ?? 0) + index
      const bisher = spalte.get(k.nach)
      spalte.set(k.nach, bisher === undefined ? vorschlag : Math.min(bisher, vorschlag))
    })
  }

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

  const position = new Map<string, Knoten>()
  const knoten: Knoten[] = schritte.map((s) => {
    const istXor = s.art === 'xor'
    const b = istXor ? XOR_SEITE : KNOTEN_B
    const h = istXor ? XOR_SEITE : KNOTEN_H
    const k: Knoten = {
      ...s,
      breite: b,
      hoehe: h,
      x: RAND + (spalte.get(s.code) ?? 0) * SPALTE_B + (KNOTEN_B - b) / 2,
      y: RAND + (rang.get(s.code) ?? 0) * ZEILE_H,
      aktuell: s.code === aktuellerSchritt,
      erledigt: erledigt.has(s.code),
    }
    position.set(s.code, k)
    return k
  })

  // Orthogonale Kanten: senkrecht raus, waagerecht auf halber Höhe, senkrecht rein.
  const kantenAus: Kante[] = gueltig.map((k) => {
    const von = position.get(k.von)!
    const nach = position.get(k.nach)!
    const x1 = von.x + von.breite / 2
    const y1 = von.y + von.hoehe
    const x2 = nach.x + nach.breite / 2
    const y2 = nach.y
    const mitte = y1 + Math.max(12, (y2 - y1) / 2)
    const pfad =
      x1 === x2
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${mitte} L ${x2} ${mitte} L ${x2} ${y2}`
    return {
      pfad,
      beschriftung: k.beschriftung,
      textX: x1 === x2 ? x1 + 8 : (x1 + x2) / 2,
      textY: mitte - 4,
    }
  })

  const breite = Math.max(...knoten.map((k) => k.x + k.breite)) + RAND
  const hoehe = Math.max(...knoten.map((k) => k.y + k.hoehe)) + RAND
  return { breite, hoehe, knoten, kanten: kantenAus }
}
