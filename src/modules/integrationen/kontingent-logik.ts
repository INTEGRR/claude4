/**
 * Kontingent (0136, Entscheidungslog 2026-11-27) — die Verteilung, ohne
 * Datenbank und ohne Netz.
 *
 * Aufgabe: den freien Bestand jedes Teils so auf die Shop-Angebote
 * verteilen, dass die Summe nie mehr verspricht, als da ist:
 *
 *     für jedes Teil:  Σ (Kontingent des Angebots × Bedarf je Stück)  ≤  frei
 *
 * Verteilt wird nach Gewicht (erwartete Nachfrage) im Wasserfüll-Verfahren:
 * alle Angebote wachsen im Verhältnis ihrer Gewichte, bis das erste Teil
 * aufgebraucht ist oder ein Angebot seinen Deckel erreicht; wer daran
 * hängt, bleibt stehen, die übrigen wachsen weiter. Am Ende wird
 * abgerundet (nie auf) und der Rest in ganzen Stücken nach Gewicht
 * vergeben, solange alle Teile reichen.
 */

export interface Abnehmer {
  /** Eindeutig über Varianten und Zweitangebote. */
  id: string
  /** Teile je Stück. Leer = hängt an keinem Bestand (dann gilt der Deckel). */
  bedarf: { komponente: string; je: number }[]
  /** Höchstens so viel — die Menge, die das Angebot ohne Teilen bekäme. */
  deckel: number
  /** Erwartete Nachfrage im Verhältnis zu den anderen (> 0). */
  gewicht: number
  /**
   * Eigener Vorrat, der nur diesem Artikel gehört (fertige Tastatur im
   * Regal): Schlüssel und Menge. Mehrere Angebote desselben Artikels
   * teilen ihn sich.
   */
  eigen?: { schluessel: string; menge: number }
}

const EPS = 1e-9

/**
 * Verteilt die Pools auf die Abnehmer. Rückgabe: ganze Stück je Abnehmer.
 * Garantie (im Test bewiesen): für jedes Teil gilt Σ Stück × Bedarf ≤ Pool,
 * und kein Abnehmer liegt über seinem Deckel.
 */
export function kontingentVerteilen(
  abnehmer: Abnehmer[],
  pool: Map<string, number>,
  /** Wird gefüllt: wie viele Stück je Abnehmer aus dem eigenen Vorrat kommen. */
  ausEigen?: Map<string, number>,
): Map<string, number> {
  const ergebnis = new Map<string, number>()
  const rest = new Map<string, number>()
  for (const [k, v] of pool) rest.set(k, Math.max(Number(v) || 0, 0))
  const gewicht = (a: Abnehmer) => (Number.isFinite(a.gewicht) && a.gewicht > 0 ? a.gewicht : 1)
  const deckel = (a: Abnehmer) => Math.max(Math.floor(Number(a.deckel) || 0), 0)

  // 1. Eigener Vorrat: je Schlüssel nach Gewicht auf die Angebote des Artikels.
  const basis = new Map<string, number>()
  const gruppen = new Map<string, Abnehmer[]>()
  for (const a of abnehmer) {
    basis.set(a.id, 0)
    if (a.eigen && a.eigen.menge > 0 && deckel(a) > 0) {
      gruppen.set(a.eigen.schluessel, [...(gruppen.get(a.eigen.schluessel) ?? []), a])
    }
  }
  for (const gruppe of gruppen.values()) {
    let vorrat = Math.floor(Math.max(...gruppe.map((a) => a.eigen!.menge)))
    const sortiert = [...gruppe].sort((x, y) => gewicht(y) - gewicht(x) || x.id.localeCompare(y.id))
    // Reihum in ganzen Stücken, das schwerste Angebot zuerst.
    let bewegt = true
    while (vorrat > 0 && bewegt) {
      bewegt = false
      for (const a of sortiert) {
        if (vorrat <= 0) break
        if (basis.get(a.id)! < deckel(a)) {
          basis.set(a.id, basis.get(a.id)! + 1)
          vorrat--
          bewegt = true
        }
      }
    }
  }

  // 2. Wasserfüllen über die geteilten Teile.
  const x = new Map<string, number>()
  const aktiv = new Set<string>()
  const nachId = new Map(abnehmer.map((a) => [a.id, a]))
  for (const a of abnehmer) {
    x.set(a.id, 0)
    const frei = deckel(a) - basis.get(a.id)!
    if (frei <= 0) continue
    if (a.bedarf.length === 0) {
      // Hängt an keinem Bestand („immer verfügbar"): der Deckel gilt.
      x.set(a.id, frei)
      continue
    }
    // Ein Teil ohne Pool heißt: nichts da.
    if (a.bedarf.some((b) => (rest.get(b.komponente) ?? 0) <= EPS)) continue
    aktiv.add(a.id)
  }
  for (let runde = 0; aktiv.size > 0 && runde < 10_000; runde++) {
    // Größter gemeinsamer Schritt λ: jedes aktive Angebot wächst um λ × Gewicht.
    const last = new Map<string, number>()
    for (const id of aktiv) {
      const a = nachId.get(id)!
      for (const b of a.bedarf) last.set(b.komponente, (last.get(b.komponente) ?? 0) + gewicht(a) * b.je)
    }
    let lambda = Number.POSITIVE_INFINITY
    for (const [k, l] of last) if (l > EPS) lambda = Math.min(lambda, (rest.get(k) ?? 0) / l)
    for (const id of aktiv) {
      const a = nachId.get(id)!
      lambda = Math.min(lambda, (deckel(a) - basis.get(id)! - x.get(id)!) / gewicht(a))
    }
    if (!Number.isFinite(lambda) || lambda < 0) lambda = 0
    for (const id of aktiv) {
      const a = nachId.get(id)!
      x.set(id, x.get(id)! + lambda * gewicht(a))
    }
    for (const [k, l] of last) rest.set(k, Math.max((rest.get(k) ?? 0) - lambda * l, 0))
    // Wer am Deckel oder an einem leeren Teil hängt, bleibt stehen.
    let entfernt = 0
    for (const id of [...aktiv]) {
      const a = nachId.get(id)!
      const amDeckel = deckel(a) - basis.get(id)! - x.get(id)! <= EPS
      const teilLeer = a.bedarf.some((b) => (rest.get(b.komponente) ?? 0) <= EPS * Math.max(b.je, 1))
      if (amDeckel || teilLeer) {
        aktiv.delete(id)
        entfernt++
      }
    }
    if (entfernt === 0 && lambda <= EPS) break
  }

  // 3. Abrunden — und die Pools mit den GANZEN Stücken neu rechnen.
  const ganz = new Map<string, number>()
  const frei = new Map<string, number>()
  for (const [k, v] of pool) frei.set(k, Math.max(Number(v) || 0, 0))
  for (const a of abnehmer) {
    const stueck = Math.min(Math.floor(x.get(a.id)! + EPS), Math.max(deckel(a) - basis.get(a.id)!, 0))
    ganz.set(a.id, stueck)
    for (const b of a.bedarf) frei.set(b.komponente, (frei.get(b.komponente) ?? 0) - stueck * b.je)
  }
  // Sicherheitsnetz gegen Rundungsfehler: solange ein Teil überzogen wäre,
  // gibt das leichteste beteiligte Angebot ein Stück zurück.
  for (let schutz = 0; schutz < 100_000; schutz++) {
    const ueberzogen = [...frei].find(([, v]) => v < -EPS)?.[0]
    if (!ueberzogen) break
    const opfer = abnehmer
      .filter((a) => ganz.get(a.id)! > 0 && a.bedarf.some((b) => b.komponente === ueberzogen))
      .sort((p, q) => gewicht(p) - gewicht(q) || q.id.localeCompare(p.id))[0]
    if (!opfer) break
    ganz.set(opfer.id, ganz.get(opfer.id)! - 1)
    for (const b of opfer.bedarf) frei.set(b.komponente, frei.get(b.komponente)! + b.je)
  }

  // 4. Der Rest in ganzen Stücken: größter abgerundeter Anteil zuerst.
  const kandidaten = abnehmer
    .filter((a) => a.bedarf.length > 0)
    .sort(
      (p, q) =>
        (x.get(q.id)! - ganz.get(q.id)!) - (x.get(p.id)! - ganz.get(p.id)!) ||
        gewicht(q) - gewicht(p) ||
        p.id.localeCompare(q.id),
    )
  let vergeben = true
  for (let runde = 0; vergeben && runde < 1000; runde++) {
    vergeben = false
    for (const a of kandidaten) {
      if (basis.get(a.id)! + ganz.get(a.id)! >= deckel(a)) continue
      if (a.bedarf.some((b) => (frei.get(b.komponente) ?? 0) + EPS < b.je)) continue
      ganz.set(a.id, ganz.get(a.id)! + 1)
      for (const b of a.bedarf) frei.set(b.komponente, frei.get(b.komponente)! - b.je)
      vergeben = true
    }
  }

  for (const a of abnehmer) {
    ergebnis.set(a.id, basis.get(a.id)! + ganz.get(a.id)!)
    ausEigen?.set(a.id, basis.get(a.id)!)
  }
  return ergebnis
}

/** Prüft die Garantie — für Tests und den Lasttest. Leere Liste = alles in Ordnung. */
export function kontingentVerletzungen(
  abnehmer: Abnehmer[],
  pool: Map<string, number>,
  kontingent: Map<string, number>,
  /** Aufteilung des eigenen Vorrats aus kontingentVerteilen. */
  ausEigen: Map<string, number> = new Map(),
): string[] {
  const fehler: string[] = []
  const verbrauch = new Map<string, number>()
  const eigenGenutzt = new Map<string, number>()
  const eigenDa = new Map<string, number>()
  for (const a of abnehmer) {
    const k = kontingent.get(a.id) ?? 0
    if (k < 0 || !Number.isInteger(k)) fehler.push(`${a.id}: ${k} ist keine ganze, nicht negative Menge`)
    if (k > Math.max(Math.floor(a.deckel), 0)) fehler.push(`${a.id}: ${k} über dem Deckel ${a.deckel}`)
    // Was aus dem eigenen Vorrat kommt, braucht keine Teile.
    const nimmt = Math.min(ausEigen.get(a.id) ?? 0, k)
    if (nimmt > 0 && !a.eigen) fehler.push(`${a.id}: ${nimmt} aus eigenem Vorrat, den es nicht gibt`)
    if (a.eigen) {
      eigenGenutzt.set(a.eigen.schluessel, (eigenGenutzt.get(a.eigen.schluessel) ?? 0) + nimmt)
      eigenDa.set(a.eigen.schluessel, Math.max(Math.floor(a.eigen.menge), 0))
    }
    const ausTeilen = k - nimmt
    for (const b of a.bedarf) verbrauch.set(b.komponente, (verbrauch.get(b.komponente) ?? 0) + ausTeilen * b.je)
  }
  for (const [k, v] of eigenGenutzt) {
    if (v > (eigenDa.get(k) ?? 0)) fehler.push(`Eigener Vorrat ${k}: ${v} vergeben, ${eigenDa.get(k) ?? 0} da`)
  }
  for (const [k, v] of verbrauch) {
    const da = Math.max(pool.get(k) ?? 0, 0)
    if (v > da + 1e-6) fehler.push(`Teil ${k}: ${v} vergeben, ${da} frei`)
  }
  return fehler
}
