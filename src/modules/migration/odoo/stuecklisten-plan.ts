/**
 * Odoo-Stücklisten in ein bestehendes KRNL übernehmen — der rechnende Teil
 * ohne Datenbank (Migration 0090, Entscheidungslog 2026-09-29).
 *
 * Ausgangslage: Tastaturen und Switch-Tester stehen schon in KRNL (aus
 * Shopify, je Farbe/Layout eigene Varianten mit SKU). In Odoo hängen die
 * Stücklisten an Vorlagen mit Attributen; Zeilen gelten per Filter nur für
 * bestimmte Varianten. Der Plan löst jede Odoo-Variante wie Odoo selbst
 * auf, ordnet Fertigprodukte und Komponenten per SKU (sonst Barcode) zu und
 * schreibt je KRNL-Vorlage EINE Stückliste wie in Odoo: Zeilen, die nur
 * manche Varianten brauchen, bekommen einen Variantenfilter („Auf Varianten
 * anwenden") aus den KRNL-Attributwerten (seit 2026-09-30; Shopify teilt
 * Produkte anders auf als Odoo, Namen weichen ab — deshalb abgeleitet aus
 * den Varianten, nicht per Namen übersetzt). Nur wenn das nicht eindeutig
 * geht oder nicht jede aktive Variante eine Odoo-Stückliste hat, entstehen
 * Varianten-Stücklisten.
 *
 * Grundsätze:
 *   - Zugeordnete KRNL-Artikel werden nie umbenannt; Preis und Bestand nur,
 *     wo KRNL 0 hat.
 *   - Hart statt still: eine Stückliste mit ungelöster Einheit wird nicht
 *     geschrieben, sondern mit Grund gemeldet.
 *   - Von Hand angelegte KRNL-Stücklisten bleiben unangetastet.
 *   - Bestände (seit 2026-09-30) nicht nur für Komponenten: jeder Artikel
 *     mit Odoo-Lagerbestand, der per SKU/Barcode/Verweis zu einer
 *     KRNL-Variante passt (Fertigprodukte wie der Switch-Tester, Zubehör wie
 *     Deskmats), bekommt ihn — ebenfalls nur, wo KRNL 0 hat.
 */

// --- Eingaben -----------------------------------------------------------------

export interface OdooVariante {
  id: number
  tmplId: number
  code: string | null
  barcode: string | null
  name: string
  ptavIds: number[]
  standardPreis: number
  gewichtKg: number | null
  uomId: number
  aktiv: boolean
}

export interface OdooVorlage {
  id: number
  name: string
  uomId: number
  fertigen: boolean
  aufAuftrag: boolean
}

export interface OdooPtav {
  id: number
  attributId: number
}

export interface OdooBom {
  id: number
  tmplId: number
  variantId: number | null
  menge: number
  uomId: number
  typ: string
  verbrauch: string
  sequenz: number
}

export interface OdooBomZeile {
  id: number
  bomId: number
  variantId: number
  menge: number
  uomId: number
  sequenz: number
  filterPtavIds: number[]
}

export interface OdooUom {
  id: number
  name: string
  /** Odoo-factor: so viele dieser Einheit ergeben eine Referenzeinheit der Kategorie. */
  faktor: number
  kategorieId: number
}

export interface OdooLieferantenpreis {
  tmplId: number
  variantId: number | null
  partnerId: number
  partnerName: string
  partnerEmail: string | null
  preis: number
  minMenge: number
  lieferzeitTage: number
  waehrung: string
  produktCode: string | null
}

/** Ein Odoo-Artikel mit Bestand an internen Lagerorten (alle, nicht nur Stücklisten-Teile). */
export interface OdooLagerArtikel {
  id: number
  code: string | null
  barcode: string | null
  name: string
  menge: number
  standardPreis: number
}

export interface OdooDaten {
  varianten: OdooVariante[]
  vorlagen: OdooVorlage[]
  ptavs: OdooPtav[]
  boms: OdooBom[]
  bomZeilen: OdooBomZeile[]
  uoms: OdooUom[]
  lieferanten: OdooLieferantenpreis[]
  /** Bestand an internen Lagerorten je Odoo-Variante. */
  bestand: Record<number, number>
  /** Alle Odoo-Artikel mit Lagerbestand > 0 (Fertigprodukte, Zubehör, Komponenten). */
  lagerArtikel?: OdooLagerArtikel[]
}

export interface KrnlVariante {
  id: string
  templateId: string
  sku: string | null
  barcode: string | null
  aktiv: boolean
  standardCost: number
  uomName: string
  bestand: number
}

export interface KrnlUom {
  name: string
  kategorie: string
  /** KRNL-ratio: so viele Referenzeinheiten ist EINE dieser Einheit. */
  ratio: number
}

export interface KrnlDaten {
  varianten: KrnlVariante[]
  uoms: KrnlUom[]
  /** Vorlagen bzw. Varianten mit einer von Hand angelegten Stückliste. */
  manuelleStuecklisten: { templateId: string; variantId: string | null }[]
  /** Frühere Übernahmen: Odoo-Varianten-ID → KRNL-Variante (auch ohne SKU wiedererkannt). */
  verweise?: Record<number, string>
  /** Attributwerte der KRNL-Varianten (Anker der Variantenfilter). */
  werte?: { variantId: string; attributId: string; ptavId: string; name: string }[]
}

// --- Ergebnis -------------------------------------------------------------------

export interface PlanZeile {
  /** Odoo-Varianten-ID der Komponente. */
  komponente: number
  menge: number
  uomName: string
  /** „Auf Varianten anwenden": KRNL-Attributwerte (leer = alle Varianten). */
  filter?: string[]
  /** Anzeige des Filters, z. B. „Mounting Plate: PC". */
  filterText?: string
  /** Reihenfolge wie in der Odoo-Stückliste (Position der ersten Zeile). */
  folge?: number
}

export interface PlanKomponente {
  odooId: number
  code: string | null
  name: string
  krnlId: string | null
  /** Einheit in KRNL (für neue: aus Odoo übersetzt). */
  uomName: string | null
  gewichtG: number | null
  /** Einkaufspreis setzen (nur wo KRNL 0 hat bzw. bei neuen). */
  preis: number | null
  /** Bestand einbuchen (nur wo KRNL 0 hat). */
  bestand: number | null
  lieferanten: OdooLieferantenpreis[]
}

export interface PlanStueckliste {
  templateId: string
  /** null = Vorlagen-Stückliste für alle Varianten. */
  variantId: string | null
  odooBomIds: number[]
  typ: 'manufacture' | 'kit'
  verbrauch: 'blocked' | 'allowed' | 'warning'
  zeilen: PlanZeile[]
  /** Anzeige: für welche SKUs. */
  skus: string[]
}

export interface PlanFertigprodukt {
  odooId: number
  code: string | null
  name: string
  krnlId: string | null
  status: 'zugeordnet' | 'fehlt' | 'blockiert'
  grund?: string
}

/** Bestand eines Artikels, der keine Stücklisten-Komponente ist. */
export interface PlanLagerbestand {
  odooId: number
  code: string | null
  name: string
  menge: number
  krnlId: string | null
  krnlSku: string | null
  /** Einkaufspreis setzen, damit der Bestand bewertet ist (nur wo KRNL 0 hat). */
  preis: number | null
  /** buchen = KRNL hat 0; vorhanden = KRNL hat schon Bestand (bleibt); fehlt = keine passende Variante. */
  status: 'buchen' | 'vorhanden' | 'fehlt'
}

export interface Plan {
  fertigprodukte: PlanFertigprodukt[]
  komponenten: PlanKomponente[]
  lagerbestaende: PlanLagerbestand[]
  stuecklisten: PlanStueckliste[]
  routen: { templateId: string; fertigen: boolean; aufAuftrag: boolean; skus: string[] }[]
  blockiert: { was: string; grund: string }[]
}

// --- Einheiten ------------------------------------------------------------------

const UOM_NAMEN: Record<string, string> = {
  units: 'Stück',
  unit: 'Stück',
  'unit(s)': 'Stück',
  stück: 'Stück',
  stk: 'Stück',
  pcs: 'Stück',
  dozens: 'Dutzend',
  dutzend: 'Dutzend',
  kg: 'kg',
  g: 'g',
  m: 'm',
  mm: 'mm',
}

/** KRNL-Einheit zu einem Odoo-Einheitennamen — oder null. */
export function krnlUomName(odooName: string, krnl: KrnlUom[]): string | null {
  const n = odooName.trim().toLowerCase()
  const ziel = UOM_NAMEN[n] ?? krnl.find((u) => u.name.toLowerCase() === n)?.name ?? null
  return ziel && krnl.some((u) => u.name === ziel) ? ziel : null
}

/** Menge von einer Odoo-Einheit in eine andere derselben Kategorie. */
export function odooUmrechnen(menge: number, von: OdooUom, nach: OdooUom): number {
  if (von.kategorieId !== nach.kategorieId) {
    throw new Error(`Einheit „${von.name}" passt nicht zu „${nach.name}"`)
  }
  return (menge / von.faktor) * nach.faktor
}

/** Menge von einer KRNL-Einheit in eine andere derselben Kategorie. */
export function krnlUmrechnen(menge: number, von: KrnlUom, nach: KrnlUom): number {
  if (von.kategorie !== nach.kategorie) {
    throw new Error(`Einheit „${von.name}" passt nicht zu „${nach.name}"`)
  }
  return (menge * von.ratio) / nach.ratio
}

// --- Odoo-Auflösung ---------------------------------------------------------------

/**
 * Gilt eine Stücklistenzeile für eine Variante? Odoo-Logik: ohne Filter
 * immer; mit Filter muss die Variante JE ATTRIBUT einen der Filterwerte
 * tragen (Farbe=Weiß UND Layout=ISO-DE, nicht ODER).
 */
export function zeileGilt(
  filterPtavIds: number[],
  variantePtavIds: number[],
  ptavAttribut: Map<number, number>,
): boolean {
  if (filterPtavIds.length === 0) return true
  const jeAttribut = new Map<number, number[]>()
  for (const id of filterPtavIds) {
    const attr = ptavAttribut.get(id) ?? -id
    jeAttribut.set(attr, [...(jeAttribut.get(attr) ?? []), id])
  }
  const hat = new Set(variantePtavIds)
  return [...jeAttribut.values()].every((werte) => werte.some((w) => hat.has(w)))
}

/** Die Stückliste, die Odoo für eine Variante nimmt: Varianten- vor Vorlagen-Stückliste. */
export function bomFuer(v: OdooVariante, boms: OdooBom[]): OdooBom | null {
  const kandidaten = boms
    .filter((b) => b.tmplId === v.tmplId && (b.variantId === null || b.variantId === v.id))
    .sort((a, b) => {
      const va = a.variantId === v.id ? 0 : 1
      const vb = b.variantId === v.id ? 0 : 1
      return va - vb || a.sequenz - b.sequenz || a.id - b.id
    })
  return kandidaten[0] ?? null
}

const TYP: Record<string, 'manufacture' | 'kit'> = { normal: 'manufacture', phantom: 'kit' }
const VERBRAUCH: Record<string, 'blocked' | 'allowed' | 'warning'> = {
  strict: 'blocked',
  flexible: 'allowed',
  warning: 'warning',
}

// --- Plan -------------------------------------------------------------------------

function normCode(s: string | null | undefined): string | null {
  const t = s?.trim()
  return t ? t.toLowerCase() : null
}

/**
 * Eine Vorlagen-Stückliste mit Variantenfiltern aus den Listen je Variante
 * ableiten. Je Zeile (Komponente, Menge, Einheit) die Menge S der Varianten,
 * die sie brauchen; alle → ohne Filter, sonst ein Filter aus den
 * Attributwerten von S (Odoo-Semantik: je Attribut einer der Werte, über
 * Attribute alle). Trifft der Filter mehr Varianten als S, wird S nach dem
 * Attribut mit den meisten Werten geteilt (mehrere gefilterte Zeilen), bis
 * jeder Teil genau passt. Liefert null, wenn das nicht eindeutig geht (zwei
 * Varianten mit gleichen Werten, aber verschiedenen Listen, oder Varianten
 * ohne Attributwerte).
 */
export function vorlagenZeilen(
  eintraege: { variantId: string; zeilen: PlanZeile[] }[],
  werte: { variantId: string; attributId: string; ptavId: string; name: string }[],
): PlanZeile[] | null {
  const varianten = eintraege.map((e) => e.variantId)
  if (varianten.length === 1) return eintraege[0].zeilen.map((z) => ({ ...z, filter: [], filterText: '' }))
  const jeVariante = new Map<string, Map<string, string>>()
  const namen = new Map<string, string>()
  for (const w of werte) {
    if (!varianten.includes(w.variantId)) continue
    if (!jeVariante.has(w.variantId)) jeVariante.set(w.variantId, new Map())
    jeVariante.get(w.variantId)!.set(w.attributId, w.ptavId)
    namen.set(w.ptavId, w.name)
  }
  const attribute = [...new Set([...jeVariante.values()].flatMap((m) => [...m.keys()]))].sort()
  if (attribute.length === 0) return null
  const wert = (v: string, a: string) => jeVariante.get(v)?.get(a) ?? null
  // Jede Variante braucht jeden Attributwert; gleiche Werte → gleiche Liste.
  const schluessel = (z: PlanZeile) => `${z.komponente}:${z.menge}:${z.uomName}`
  const tupelListe = new Map<string, string>()
  for (const e of eintraege) {
    if (attribute.some((a) => wert(e.variantId, a) === null)) return null
    const tupel = attribute.map((a) => wert(e.variantId, a)).join('&')
    const liste = e.zeilen.map(schluessel).sort().join('|')
    if (tupelListe.has(tupel) && tupelListe.get(tupel) !== liste) return null
    tupelListe.set(tupel, liste)
  }
  const alleWerte = new Map(attribute.map((a) => [a, new Set(varianten.map((v) => wert(v, a)!))]))
  type Filter = Map<string, Set<string>>
  const passt = (v: string, f: Filter) => [...f].every(([a, ws]) => ws.has(wert(v, a)!))
  const kasten = (S: string[]): Filter => {
    const f: Filter = new Map()
    for (const a of attribute) {
      const inS = new Set(S.map((v) => wert(v, a)!))
      if (inS.size < alleWerte.get(a)!.size) f.set(a, inS)
    }
    return f
  }
  const abdecken = (S: string[]): Filter[] => {
    const f = kasten(S)
    if (varianten.filter((v) => passt(v, f)).length === S.length) return [f]
    const [teilen] = attribute
      .map((a) => [a, new Set(S.map((v) => wert(v, a))).size] as const)
      .filter(([, n]) => n > 1)
      .sort((x, y) => y[1] - x[1])
    if (!teilen) return [f]
    const teile = new Map<string, string[]>()
    for (const v of S) teile.set(wert(v, teilen[0])!, [...(teile.get(wert(v, teilen[0])!) ?? []), v])
    return [...teile.values()].flatMap(abdecken)
  }

  const zeilen = new Map<string, { zeile: PlanZeile; varianten: string[] }>()
  for (const e of eintraege) {
    for (const z of e.zeilen) {
      const k = schluessel(z)
      if (!zeilen.has(k)) zeilen.set(k, { zeile: z, varianten: [] })
      zeilen.get(k)!.varianten.push(e.variantId)
    }
  }
  const ergebnis: PlanZeile[] = []
  for (const { zeile, varianten: S } of zeilen.values()) {
    if (S.length === varianten.length) {
      ergebnis.push({ ...zeile, filter: [], filterText: '' })
      continue
    }
    for (const f of abdecken(S)) {
      const ptavs = [...f.values()].flatMap((ws) => [...ws]).sort()
      ergebnis.push({ ...zeile, filter: ptavs, filterText: ptavs.map((p) => namen.get(p) ?? p).join(', ') })
    }
  }
  // Probe: jede Variante bekommt über die Filter genau ihre Liste.
  for (const e of eintraege) {
    const gilt = ergebnis.filter((z) => {
      const f: Filter = new Map()
      for (const p of z.filter ?? []) {
        const a = attribute.find((x) => alleWerte.get(x)!.has(p))!
        f.set(a, new Set([...(f.get(a) ?? []), p]))
      }
      return passt(e.variantId, f)
    })
    if (gilt.map(schluessel).sort().join('|') !== e.zeilen.map(schluessel).sort().join('|')) return null
  }
  // Reihenfolge wie in Odoo (gefilterte Zeilen stehen, wo sie in Odoo stehen).
  return ergebnis.sort((a, b) => (a.folge ?? Infinity) - (b.folge ?? Infinity))
}

export function stuecklistenPlan(odoo: OdooDaten, krnl: KrnlDaten): Plan {
  const plan: Plan = { fertigprodukte: [], komponenten: [], lagerbestaende: [], stuecklisten: [], routen: [], blockiert: [] }

  const uomOdoo = new Map(odoo.uoms.map((u) => [u.id, u]))
  const uomKrnl = new Map(krnl.uoms.map((u) => [u.name, u]))
  const vorlage = new Map(odoo.vorlagen.map((t) => [t.id, t]))
  const variante = new Map(odoo.varianten.map((v) => [v.id, v]))
  const ptavAttribut = new Map(odoo.ptavs.map((p) => [p.id, p.attributId]))
  const nachSku = new Map<string, KrnlVariante>()
  const nachBarcode = new Map<string, KrnlVariante>()
  for (const k of krnl.varianten) {
    const s = normCode(k.sku)
    if (s) nachSku.set(s, k)
    const b = normCode(k.barcode)
    if (b) nachBarcode.set(b, k)
  }
  const nachId = new Map(krnl.varianten.map((k) => [k.id, k]))
  const krnlZu = (v: { id: number; code: string | null; barcode: string | null }): KrnlVariante | null => {
    const verwiesen = krnl.verweise?.[v.id]
    if (verwiesen && nachId.has(verwiesen)) return nachId.get(verwiesen)!
    const code = normCode(v.code)
    if (code && nachSku.has(code)) return nachSku.get(code)!
    const barcode = normCode(v.barcode)
    if (barcode && nachBarcode.has(barcode)) return nachBarcode.get(barcode)!
    return null
  }
  const manuellVorlage = new Set(
    krnl.manuelleStuecklisten.filter((m) => m.variantId === null).map((m) => m.templateId),
  )
  const manuellVariante = new Set(
    krnl.manuelleStuecklisten.filter((m) => m.variantId !== null).map((m) => m.variantId),
  )

  // Komponenten sammeln (einmal je Odoo-Variante).
  const komponenten = new Map<number, PlanKomponente>()
  const komponente = (id: number): PlanKomponente | { fehler: string } => {
    const bekannt = komponenten.get(id)
    if (bekannt) return bekannt
    const v = variante.get(id)
    if (!v) return { fehler: `Komponente ${id} fehlt in den Odoo-Daten` }
    const k = krnlZu(v)
    const uomName = k ? k.uomName : krnlUomName(uomOdoo.get(v.uomId)?.name ?? '', krnl.uoms)
    if (!uomName) {
      return { fehler: `Einheit „${uomOdoo.get(v.uomId)?.name ?? v.uomId}" von ${v.code ?? v.name} kennt KRNL nicht` }
    }
    const lieferanten = odoo.lieferanten.filter(
      (l) => (l.variantId === null && l.tmplId === v.tmplId) || l.variantId === v.id,
    )
    const juengsterLieferant = lieferanten.find((l) => l.preis > 0)?.preis ?? null
    const odooPreis = v.standardPreis > 0 ? v.standardPreis : juengsterLieferant
    const odooBestand = odoo.bestand[v.id] ?? 0
    const eintrag: PlanKomponente = {
      odooId: v.id,
      code: v.code,
      name: v.name,
      krnlId: k?.id ?? null,
      uomName,
      gewichtG: v.gewichtKg ? Math.round(v.gewichtKg * 1000) : null,
      preis: (!k || k.standardCost <= 0) && odooPreis && odooPreis > 0 ? Math.round(odooPreis * 100) / 100 : null,
      bestand: (!k || k.bestand <= 0) && odooBestand > 0 ? odooBestand : null,
      lieferanten,
    }
    komponenten.set(id, eintrag)
    return eintrag
  }

  // Je Odoo-Variante mit Stückliste die Zeilen auflösen.
  type Aufgeloest = { krnl: KrnlVariante; bom: OdooBom; zeilen: PlanZeile[] }
  const jeKrnlVorlage = new Map<string, Aufgeloest[]>()
  const vorlagenMitBom = new Set(odoo.boms.map((b) => b.tmplId))

  for (const v of odoo.varianten) {
    if (!v.aktiv || !vorlagenMitBom.has(v.tmplId)) continue
    const bom = bomFuer(v, odoo.boms)
    if (!bom) continue
    const k = krnlZu(v)
    const basis = { odooId: v.id, code: v.code, name: v.name, krnlId: k?.id ?? null }
    if (!k) {
      plan.fertigprodukte.push({ ...basis, status: 'fehlt', grund: 'keine KRNL-Variante mit dieser SKU/diesem Barcode' })
      continue
    }
    const sperre = (grund: string) => {
      plan.fertigprodukte.push({ ...basis, status: 'blockiert', grund })
      plan.blockiert.push({ was: v.code ?? v.name, grund })
    }
    if (!TYP[bom.typ]) {
      sperre(`Stücklistenart „${bom.typ}" übernimmt KRNL nicht`)
      continue
    }
    if (manuellVorlage.has(k.templateId) || manuellVariante.has(k.id)) {
      sperre('hat in KRNL schon eine von Hand angelegte Stückliste — bleibt unverändert')
      continue
    }
    const prodUom = uomOdoo.get(vorlage.get(v.tmplId)?.uomId ?? v.uomId)
    const bomUom = uomOdoo.get(bom.uomId)
    try {
      if (!prodUom || !bomUom) throw new Error('Einheit der Stückliste fehlt')
      const stueckMenge = odooUmrechnen(bom.menge, bomUom, prodUom)
      const summe = new Map<number, PlanZeile>()
      const bomZeilen = odoo.bomZeilen
        .filter((z) => z.bomId === bom.id)
        .sort((a, b) => a.sequenz - b.sequenz || a.id - b.id)
      for (const [folge, z] of bomZeilen.entries()) {
        if (!zeileGilt(z.filterPtavIds, v.ptavIds, ptavAttribut)) continue
        const komp = komponente(z.variantId)
        if ('fehler' in komp) throw new Error(komp.fehler)
        const kompOdoo = variante.get(z.variantId)!
        const zeileUom = uomOdoo.get(z.uomId)
        const kompUom = uomOdoo.get(kompOdoo.uomId)
        if (!zeileUom || !kompUom) throw new Error(`Einheit der Zeile ${kompOdoo.code ?? kompOdoo.name} fehlt`)
        let menge = odooUmrechnen(z.menge, zeileUom, kompUom) / stueckMenge
        // Odoo-Einheit der Komponente → KRNL-Einheit der Komponente.
        const kompKrnlUom = uomKrnl.get(komp.uomName!)
        const kompOdooAlsKrnl = uomKrnl.get(krnlUomName(kompUom.name, krnl.uoms) ?? '')
        if (!kompKrnlUom) throw new Error(`KRNL-Einheit „${komp.uomName}" fehlt`)
        if (kompOdooAlsKrnl && kompOdooAlsKrnl.name !== kompKrnlUom.name) {
          menge = krnlUmrechnen(menge, kompOdooAlsKrnl, kompKrnlUom)
        }
        const bisher = summe.get(z.variantId)
        summe.set(z.variantId, {
          komponente: z.variantId,
          menge: Math.round(((bisher?.menge ?? 0) + menge) * 1e6) / 1e6,
          uomName: kompKrnlUom.name,
          folge: bisher?.folge ?? folge,
        })
      }
      if (summe.size === 0) throw new Error('keine Zeile gilt für diese Variante')
      plan.fertigprodukte.push({ ...basis, status: 'zugeordnet' })
      jeKrnlVorlage.set(k.templateId, [
        ...(jeKrnlVorlage.get(k.templateId) ?? []),
        { krnl: k, bom, zeilen: [...summe.values()] },
      ])
    } catch (err) {
      sperre(err instanceof Error ? err.message : String(err))
    }
  }

  // Je KRNL-Vorlage: eine Vorlagen-Stückliste, wenn alle aktiven Varianten
  // dieselbe Liste brauchen — sonst je Variante eine.
  const signatur = (zeilen: PlanZeile[]) =>
    zeilen.map((z) => `${z.komponente}:${z.menge}:${z.uomName}`).sort().join('|')
  for (const [templateId, eintraege] of jeKrnlVorlage) {
    const aktive = krnl.varianten.filter((k) => k.templateId === templateId && k.aktiv)
    const abgedeckt = new Set(eintraege.map((e) => e.krnl.id))
    const alleAbgedeckt = aktive.every((a) => abgedeckt.has(a.id))
    const gleich = new Set(eintraege.map((e) => signatur(e.zeilen))).size === 1
    const gemeinsam = (e: Aufgeloest) => ({
      typ: TYP[e.bom.typ],
      verbrauch: VERBRAUCH[e.bom.verbrauch] ?? 'warning',
    })
    // Wie in Odoo: eine Stückliste je Artikel, Zeilen mit Variantenfilter —
    // nur, wenn jede aktive Variante eine Odoo-Liste hat (sonst bekäme eine
    // unbekannte Variante ungeprüft Zeilen) und Art/Verbrauch gleich sind.
    const einheitlich = new Set(eintraege.map((e) => `${gemeinsam(e).typ}:${gemeinsam(e).verbrauch}`)).size === 1
    const mitFiltern =
      alleAbgedeckt && einheitlich && !gleich
        ? vorlagenZeilen(eintraege.map((e) => ({ variantId: e.krnl.id, zeilen: e.zeilen })), krnl.werte ?? [])
        : null
    if (alleAbgedeckt && (gleich || mitFiltern)) {
      plan.stuecklisten.push({
        templateId,
        variantId: null,
        odooBomIds: [...new Set(eintraege.map((e) => e.bom.id))],
        ...gemeinsam(eintraege[0]),
        zeilen: mitFiltern ?? eintraege[0].zeilen,
        skus: eintraege.map((e) => e.krnl.sku ?? e.krnl.id),
      })
    } else {
      for (const e of eintraege) {
        plan.stuecklisten.push({
          templateId,
          variantId: e.krnl.id,
          odooBomIds: [e.bom.id],
          ...gemeinsam(e),
          zeilen: e.zeilen,
          skus: [e.krnl.sku ?? e.krnl.id],
        })
      }
    }
    // Routen wie in Odoo — nur, wenn jede aktive Variante eine Stückliste
    // bekommt; sonst liefe eine Shopify-Bestellung ins Leere.
    const odooVorlagen = [...new Set(eintraege.map((e) => e.bom.tmplId))]
      .map((id) => vorlage.get(id))
      .filter(Boolean) as OdooVorlage[]
    const fertigen = odooVorlagen.some((t) => t.fertigen)
    const aufAuftrag = odooVorlagen.some((t) => t.aufAuftrag)
    if (alleAbgedeckt && (fertigen || aufAuftrag)) {
      plan.routen.push({ templateId, fertigen, aufAuftrag, skus: eintraege.map((e) => e.krnl.sku ?? '') })
    }
  }

  // Nur Komponenten, die in mindestens einer schreibbaren Stückliste stehen.
  const benutzt = new Set(plan.stuecklisten.flatMap((s) => s.zeilen.map((z) => z.komponente)))
  plan.komponenten = [...komponenten.values()].filter((k) => benutzt.has(k.odooId))

  // Bestände aller übrigen Artikel mit Odoo-Lagerbestand — Komponenten haben
  // ihren eigenen Weg oben; eine KRNL-Variante wird nur einmal gebucht.
  const komponentenIds = new Set(plan.komponenten.map((k) => k.odooId))
  const gebucht = new Set(plan.komponenten.filter((k) => k.bestand !== null && k.krnlId).map((k) => k.krnlId!))
  for (const a of [...(odoo.lagerArtikel ?? [])].sort((x, y) => (x.code ?? x.name).localeCompare(y.code ?? y.name))) {
    if (a.menge <= 0 || komponentenIds.has(a.id)) continue
    const k = krnlZu(a)
    const basis = { odooId: a.id, code: a.code, name: a.name, menge: a.menge, krnlId: k?.id ?? null, krnlSku: k?.sku ?? null }
    if (!k) {
      plan.lagerbestaende.push({ ...basis, preis: null, status: 'fehlt' })
      continue
    }
    const buchen = k.bestand <= 0 && !gebucht.has(k.id)
    gebucht.add(k.id)
    plan.lagerbestaende.push({
      ...basis,
      preis: buchen && k.standardCost <= 0 && a.standardPreis > 0 ? Math.round(a.standardPreis * 100) / 100 : null,
      status: buchen ? 'buchen' : 'vorhanden',
    })
  }
  return plan
}

/** Kennzahlen für die Vorschau. */
export function planUebersicht(plan: Plan) {
  return {
    fertigZugeordnet: plan.fertigprodukte.filter((f) => f.status === 'zugeordnet').length,
    fertigFehlt: plan.fertigprodukte.filter((f) => f.status === 'fehlt').length,
    blockiert: plan.blockiert.length,
    stuecklisten: plan.stuecklisten.length,
    vorlagenStuecklisten: plan.stuecklisten.filter((s) => s.variantId === null).length,
    komponentenVorhanden: plan.komponenten.filter((k) => k.krnlId).length,
    komponentenNeu: plan.komponenten.filter((k) => !k.krnlId).length,
    komponentenOhneSku: plan.komponenten.filter((k) => !k.krnlId && !k.code).length,
    preise: plan.komponenten.filter((k) => k.preis !== null).length,
    bestand: plan.komponenten.filter((k) => k.bestand !== null).length,
    lieferantenpreise: plan.komponenten.reduce((s, k) => s + k.lieferanten.length, 0),
    routen: plan.routen.length,
    lagerBuchen: plan.lagerbestaende.filter((l) => l.status === 'buchen').length,
    lagerVorhanden: plan.lagerbestaende.filter((l) => l.status === 'vorhanden').length,
    lagerFehlt: plan.lagerbestaende.filter((l) => l.status === 'fehlt').length,
  }
}
