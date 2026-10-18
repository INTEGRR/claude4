/**
 * Statusleiste einer Belegseite (Entscheidungslog 2026-10-18, UX-Audit M1):
 * die Stufen des Prozesses als Leiste, der aktuelle Stand hervorgehoben.
 * Gespeist aus der Prozessdefinition (Chamäleon) — jede Firma sieht ihre
 * eigenen Stufen. Der Belegstatus bleibt die einzige Zustandswahrheit:
 * eine Stufe ist der Zustand, den ein Schritt hinterlässt (prozess_schritte.zustand).
 *
 * Hauptpfad = die nicht optionalen Schritte mit Zustand, nach `sequence`,
 * ohne Abbruch-Zustände (Storno, Ablehnung — die erscheinen nur, wenn der
 * Beleg dort steht). Pur, damit unter blankem Node testbar.
 */

/** Zustände, die einen Ablauf abbrechen statt ihn fortzusetzen. */
export const ABBRUCH_ZUSTAENDE: readonly string[] = ['cancel', 'storniert', 'abgelehnt', 'abgebrochen', 'verworfen']

export function istAbbruch(zustand: string | null | undefined): boolean {
  return zustand != null && ABBRUCH_ZUSTAENDE.includes(zustand)
}

export interface LeistenSchritt {
  code: string
  name: string
  art: string
  optional: boolean
  abgeschaltet?: boolean
  zustand: string | null
  sequence: number
}

export interface Stufe {
  zustand: string
  /** Name des Schritts, der in diesen Zustand führt (Rückfall-Beschriftung). */
  schritt: string
  stand: 'erledigt' | 'aktuell' | 'offen'
}

export interface Leiste {
  stufen: Stufe[]
  /** Der Beleg steht in einem Abbruch-Zustand (oder einem Zustand außerhalb des Hauptpfads). */
  abseits: string | null
}

const OHNE_STUFE = new Set(['start', 'ende', 'xor'])

export function hauptpfad(schritte: LeistenSchritt[]): { zustand: string; schritt: string }[] {
  const gesehen = new Set<string>()
  const pfad: { zustand: string; schritt: string }[] = []
  for (const s of [...schritte].sort((a, b) => a.sequence - b.sequence)) {
    if (OHNE_STUFE.has(s.art) || s.optional || s.abgeschaltet || !s.zustand || istAbbruch(s.zustand)) continue
    if (gesehen.has(s.zustand)) continue
    gesehen.add(s.zustand)
    pfad.push({ zustand: s.zustand, schritt: s.name })
  }
  return pfad
}

export function leiste(schritte: LeistenSchritt[], aktuell: string | null): Leiste {
  const pfad = hauptpfad(schritte)
  const index = aktuell == null ? -1 : pfad.findIndex((p) => p.zustand === aktuell)
  const stufen: Stufe[] = pfad.map((p, i) => ({
    ...p,
    stand: index < 0 ? 'offen' : i < index ? 'erledigt' : i === index ? 'aktuell' : 'offen',
  }))
  return { stufen, abseits: aktuell != null && index < 0 ? aktuell : null }
}

/**
 * Folgestufen, die keine eigenen Belegzustände haben (Verkauf: Geliefert,
 * Berechnet — Teilprozesse bzw. abgeleitete Stände). Die Seite liefert ihren
 * Stand; ist eine davon begonnen, gilt die zuletzt aktuelle Stufe als erledigt.
 */
export function mitFolgestufen(l: Leiste, folge: { name: string; stand: Stufe['stand'] }[]): Leiste {
  if (folge.length === 0) return l
  const begonnen = folge.some((f) => f.stand !== 'offen')
  const stufen = l.stufen.map((s) => (begonnen && s.stand === 'aktuell' ? { ...s, stand: 'erledigt' as const } : s))
  return { ...l, stufen: [...stufen, ...folge.map((f) => ({ zustand: `folge:${f.name}`, schritt: f.name, stand: f.stand }))] }
}
