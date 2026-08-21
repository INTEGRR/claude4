/**
 * Struktur-Regeln einer Prozessversion — PUR (kein Datenbank-, kein
 * Next-Import), damit sie unter blankem Node prüfbar sind.
 *
 * Dieselben Regeln stehen hart in `prozess_version_aktivieren` (SQL): das ist
 * die letzte Instanz und bleibt es. Hier laufen sie schon beim ENTWURF —
 * BUG/00015 hat gezeigt, warum: die KI baute einen XOR-Schritt mit zwei
 * bedingungslosen Kanten, der Entwurf entstand klaglos, und erst beim
 * Aktivieren kam die Fehlermeldung — an einer Stelle, an der niemand mehr
 * etwas ändern konnte. Ein Entwurf, der nicht aktivierbar ist, ist keiner.
 *
 * Rückgabe: die erste verletzte Regel als Satz, den ein Mensch (und die KI,
 * die daraufhin nachbessert) versteht — oder null.
 */

export interface PruefSchritt {
  code: string
  art: string
}

export interface PruefUebergang {
  von: string
  nach: string
  bedingung?: unknown
}

/**
 * XOR: höchstens EINE bedingungslose Kante je Verzweigung, und die zuletzt.
 * Die Reihenfolge im Array ist die Prüfreihenfolge (sie wird als `sequence`
 * gespeichert) — eine bedingungslose Kante in der Mitte würde alles danach
 * unerreichbar machen.
 */
export function xorRegeln(
  schritte: PruefSchritt[],
  uebergaenge: PruefUebergang[],
): string | null {
  for (const s of schritte) {
    if (s.art !== 'xor') continue
    const raus = uebergaenge.filter((u) => u.von === s.code)
    const ohne = raus.filter((u) => u.bedingung == null)
    if (raus.length > 1 && ohne.length > 1) {
      return (
        `XOR-Schritt „${s.code}": ${ohne.length} Kanten ohne Bedingung — bei einer ` +
        'Verzweigung darf höchstens eine bedingungslos sein (der Standardweg). Die ' +
        'übrigen brauchen eine bedingung {"feld","op","wert"} auf einem Feld des Belegs.'
      )
    }
    if (ohne.length === 1 && raus.at(-1) !== ohne[0]) {
      return (
        `XOR-Schritt „${s.code}": die bedingungslose Kante (→ ${ohne[0].nach}) muss als ` +
        'LETZTE stehen — sonst greift sie, bevor die Bedingungen geprüft werden.'
      )
    }
  }
  return null
}

/** Jeder Schritt braucht einen Weg von einem Start aus. */
export function erreichbarkeit(
  schritte: PruefSchritt[],
  uebergaenge: PruefUebergang[],
): string | null {
  const erreicht = new Set(schritte.filter((s) => s.art === 'start').map((s) => s.code))
  for (let runde = 0; runde < schritte.length; runde++) {
    const vorher = erreicht.size
    for (const u of uebergaenge) if (erreicht.has(u.von)) erreicht.add(u.nach)
    if (erreicht.size === vorher) break
  }
  const unerreichbar = schritte.filter((s) => !erreicht.has(s.code)).map((s) => s.code)
  return unerreichbar.length > 0
    ? `Nicht vom Start erreichbar: ${unerreichbar.join(', ')} — jeder Schritt braucht einen Weg dorthin.`
    : null
}

/** Kahn-Abbau: bleiben Knoten übrig, gibt es eine Schleife. */
export function azyklik(schritte: PruefSchritt[], uebergaenge: PruefUebergang[]): string | null {
  const offen = new Set(schritte.map((s) => s.code))
  for (let runde = 0; runde < schritte.length; runde++) {
    const ohneEingang = [...offen].filter(
      (c) => !uebergaenge.some((u) => u.nach === c && offen.has(u.von)),
    )
    if (ohneEingang.length === 0) break
    for (const c of ohneEingang) offen.delete(c)
  }
  return offen.size > 0
    ? `Der Prozess enthält eine Schleife (${[...offen].join(', ')}) — Schleifen sind nicht ` +
        'erlaubt. Wiederholungen bildet man als eigenen Zustand oder als neuen Vorgang ab.'
    : null
}

/** Alle Strukturregeln in der Reihenfolge, in der sie am meisten erklären. */
export function entwurfPruefen(
  schritte: PruefSchritt[],
  uebergaenge: PruefUebergang[],
): string | null {
  return (
    xorRegeln(schritte, uebergaenge) ??
    erreichbarkeit(schritte, uebergaenge) ??
    azyklik(schritte, uebergaenge)
  )
}
