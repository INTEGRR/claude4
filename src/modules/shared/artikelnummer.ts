/**
 * Artikelnummer-Vorschlag (Entscheidungslog 2026-11-28) — reine Logik.
 *
 * Das Muster ist aus den vorhandenen Nummern abgelesen (CS-1800-BLK-001,
 * MP-F-1800-001, PCB-HE-1800-001, SW-GT-JMX-001, FM-B-N75-001, …):
 *
 *     ART – MERKMAL(E) – MODELL – FARBE – LAUFNUMMER
 *
 * ART       Kürzel der Teileart (CS Gehäuse, MP Mounting Plate, SW Switch …)
 * MERKMAL   was das Teil innerhalb der Art unterscheidet (F/P bei Plates,
 *           HE/MX/ISO bei PCBs, Hersteller + Typ bei Switches: GT-JMX)
 * MODELL    N75 oder 1800 — entfällt bei Teilen für alle Modelle
 * FARBE     dreistellig (BLK, BLU, GRE, WHT, YEL, VLT)
 * LAUFNR    dreistellig ab 001 (Tastaturen vierstellig), zählt hoch, wenn
 *           die Nummer schon vergeben ist
 *
 * Der Vorschlag ist ein Vorschlag: er steht im Feld, vergeben wird, was der
 * Mensch speichert.
 */

export interface ArtikelnummerEingabe {
  /** Produktname. */
  produkt: string
  /** Attributwerte der Variante („FR4", „Gateron - Jade Max", „Plague Black"). */
  werte?: readonly string[]
}

/** Dieselbe Erklärung für die KI — sie soll beim Anlegen nach dem Muster vorschlagen. */
export const ARTIKELNUMMER_MUSTER =
  'Artikelnummern (SKU) folgen dem Muster ART-MERKMAL-MODELL-FARBE-LAUFNUMMER, Großbuchstaben, mit Bindestrich: ' +
  'ART = Teileart (CS Gehäuse/Case, MP Mounting Plate, PCB, SW Switch, KC Keycaps, FM Foam, STB Stabilizer, SCR Schraube, ' +
  'CBL Kabel, CC Coiled Cable, CLIP, QS Quickstart Guide, ST Switch Tester, KCP Keycap Puller, AS Accent Kit, BAG Tüte, ' +
  'DM Deskmat, GR Grommets, TL Werkzeug, KB Tastatur); MERKMAL = was innerhalb der Art unterscheidet (Plate: F = FR4, ' +
  'P = Polycarbonat; PCB: HE, MX, ISO, ANSI, DB = Daughter Board; Foam: B = Bottom, M = Middle; Stabilizer: L = groß, ' +
  'S = klein; Switch: Hersteller + Typ, z. B. GT-JMX = Gateron Jade Max, GT-LY = Linear Yellow, CH-LSR = Cherry Silent Red); ' +
  'MODELL = N75 oder 1800 (entfällt bei Teilen für alle Modelle); FARBE dreistellig (BLK, BLU, GRE, WHT, YEL, VLT); ' +
  'LAUFNUMMER dreistellig ab 001. Beispiele: CS-1800-BLK-001, MP-F-1800-001, PCB-HE-1800-001, SW-GT-JMX-001, ' +
  'FM-B-N75-001, STB-L-1800-001, KC-STD-1800-001. Nummern der Form SH00000123 sind Shop-Zählnummern und keine Artikelnummern.'

type Regel = readonly [RegExp, string]

/** Teileart — Reihenfolge zählt: das Speziellere zuerst. */
const ARTEN: readonly Regel[] = [
  [/keycap puller/, 'KCP'],
  [/switch tester/, 'ST'],
  [/coiled cable|spiralkabel/, 'CC'],
  [/kabel|cable/, 'CBL'],
  [/keycap/, 'KC'],
  [/accent/, 'AS'],
  [/tastatur|keyboard|barebone|qwertz|qwerty/, 'KB'],
  [/switch/, 'SW'],
  [/mounting plate|\bplate\b/, 'MP'],
  [/foam|schaum/, 'FM'],
  [/pcb|platine|daughter ?board/, 'PCB'],
  [/stabili[sz]er|\bstabs?\b/, 'STB'],
  [/\bcase\b|geh(ä|ae)use/, 'CS'],
  [/screw|schraube/, 'SCR'],
  [/\bclip\b/, 'CLIP'],
  [/quickstart/, 'QS'],
  [/t(ü|ue)te|\bbag\b/, 'BAG'],
  [/deskmat/, 'DM'],
  [/grommet/, 'GR'],
  [/esd/, 'ESD'],
  [/rubber fe/, 'RF'],
  [/werkzeug|\btool\b|hammer/, 'TL'],
]

const FARBEN: readonly Regel[] = [
  [/plague black|\bblack\b|schwarz/, 'BLK'],
  [/glacial blue|\bblue\b|blau/, 'BLU'],
  [/emerald|\bgreen\b|gr(ü|ue)n/, 'GRE'],
  [/nexus white|\bwhite\b|wei(ß|ss)/, 'WHT'],
  [/phoenix gold|\bgold\b|\byellow\b|gelb/, 'YEL'],
  [/cosmic purple|\bpurple\b|violet|lila/, 'VLT'],
  [/founders/, 'FE'],
  [/\bred\b|\brot\b/, 'RED'],
  [/orange/, 'ORG'],
  [/\bsilver\b|silber/, 'SLV'],
  [/\bgr[ae]y\b|grau/, 'GRY'],
  [/\bpink\b|rosa/, 'PNK'],
]

/** Switch-Typen: Jade-Reihe J.., sonst Gefühl + Farbe (LY = Linear Yellow) wie im Bestand. */
const SWITCH_TYPEN: readonly Regel[] = [
  [/jade max/, 'JMX'],
  [/jade gaming/, 'JGA'],
  [/jade ultra/, 'JUL'],
  [/jade silent/, 'JSI'],
  [/silent red/, 'LSR'],
  [/yellow/, 'LY'],
  [/silver/, 'LS'],
  [/\bblue\b/, 'CB'],
  [/brown/, 'TB'],
  [/\bred\b/, 'LR'],
  [/\bblack\b/, 'LB'],
]

const HERSTELLER: readonly Regel[] = [
  [/gateron/, 'GT'],
  [/cherry/, 'CH'],
  [/kailh/, 'KL'],
  [/durock/, 'DR'],
  [/ttc/, 'TTC'],
]

const erster = (text: string, regeln: readonly Regel[]): string | null =>
  regeln.find(([muster]) => muster.test(text))?.[1] ?? null

const alle = (text: string, regeln: readonly Regel[]): string[] =>
  regeln.filter(([muster]) => muster.test(text)).map(([, code]) => code)

/** Merkmale je Teileart, in der Reihenfolge, in der sie in der Nummer stehen. */
function merkmale(art: string, t: string): string[] {
  switch (art) {
    case 'SW': {
      const typ = erster(t, SWITCH_TYPEN)
      return [erster(t, HERSTELLER), typ].filter((x): x is string => Boolean(x))
    }
    case 'MP':
      return alle(t, [[/fr-?4/, 'F'], [/\bpc\b|polycarbonat/, 'P'], [/alu/, 'A'], [/messing|brass/, 'B'], [/\biso\b/, 'ISO'], [/\bansi\b/, 'ANSI']])
    case 'PCB':
      return alle(t, [[/daughter/, 'DB'], [/\bhe\b|hall/, 'HE'], [/\bmx\b/, 'MX'], [/\biso\b/, 'ISO'], [/\bansi\b/, 'ANSI']])
    case 'FM':
      return alle(t, [[/bottom/, 'B'], [/middle/, 'M'], [/\btop\b/, 'T'], [/pcb/, 'P'], [/silikon|silicone/, 'SIL'], [/\biso\b/, 'ISO'], [/\bansi\b/, 'ANSI']])
    case 'STB':
      return alle(t, [[/gro(ß|ss)|large|spacebar|pre lubed/, 'L'], [/klein|small/, 'S']])
    case 'KC':
      return alle(t, [[/founders/, 'FND'], [/standard/, 'STD'], [/black on black|blackout/, 'BOB'], [/throwback/, 'MR'], [/obsidian/, 'RGB'], [/split space/, 'SP']])
    case 'CBL':
      return alle(t, [[/daughter/, 'DB'], [/usb-?c/, 'USBC'], [/adapter/, 'ADP']])
    case 'CLIP':
      return alle(t, [[/alu/, 'ALU']])
    case 'SCR': {
      const mass = t.match(/\bm(\d+(?:[.,]\d+)?)\s*x\s*(?:\d+(?:[.,]\d+)?\s*x\s*)?(\d+)/)
      return [mass ? `M${mass[1]}X${mass[2]}` : null, erster(t, [[/messing|brass/, 'BRS']])].filter((x): x is string => Boolean(x))
    }
    case 'KB':
      return [
        erster(t, [[/\bhe\b/, 'HE'], [/\bmx\b/, 'MX']]),
      ].filter((x): x is string => Boolean(x))
    default:
      return []
  }
}

/** Tastaturen tragen ihre Konfiguration hinten: Plate, Switch, Keycaps. */
function tastaturKonfiguration(t: string): string[] {
  return [
    erster(t, [[/fr-?4/, 'FR'], [/\bpc\b|polycarbonat/, 'PC']]),
    erster(t, [[/jade max/, 'JMX'], [/jade gaming/, 'JGA'], [/jade ultra/, 'JUL'], [/jade silent/, 'JSI'], [/silent red/, 'SR'],
      [/yellow/, 'LY'], [/silver/, 'LS'], [/clicky blue/, 'CB'], [/brown/, 'TB']]),
    erster(t, [[/founders split/, 'FSP'], [/founders/, 'FND'], [/split space/, 'SSP'], [/obsidian/, 'FO'], [/blackout|black on black/, 'BoB'],
      [/throwback/, 'R'], [/keycap[^,)]*white|: white/, 'W'], [/standard/, 'S']]),
  ].filter((x): x is string => Boolean(x))
}

function modell(t: string): string | null {
  if (/\bn75\b|native ?75|\b75 ?%/.test(t)) return 'N75'
  const m = t.match(/native ?(\d{2,4})/) ?? t.match(/\b(1800)\b/)
  return m ? m[1] : null
}

/** Ohne bekannte Art: Anfangsbuchstaben der ersten Wörter („Poliertuch Mikrofaser" → PM). */
function initialen(t: string): string {
  const woerter = t.replace(/[^a-z0-9äöüß ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(anvil|native|für|fuer|mit|und|the|for)$/.test(w))
  const kurz = woerter.slice(0, 3).map((w) => w[0]).join('').toUpperCase()
  return kurz.length >= 2 ? kurz : (woerter[0] ?? 'ART').slice(0, 3).toUpperCase()
}

/** Der Rumpf der Nummer ohne Laufnummer — „CS-1800-BLK". */
export function artikelnummerRumpf(e: ArtikelnummerEingabe): string {
  const t = `${e.produkt} ${(e.werte ?? []).join(' ')}`
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ') // „[KC-BOB-N75-001] …": die alte Nummer im Namen zählt nicht mit
    .replace(/\(\+[^)]*\)/g, ' ') // Aufpreise „(+20€)"
    .replace(/\s+/g, ' ')
    .trim()
  const art = erster(t, ARTEN) ?? initialen(t)
  const teile = [art, ...merkmale(art, t)]
  const m = modell(t)
  if (m) teile.push(m)
  // Farbe: nicht bei Switches (steckt im Typ).
  // Keycaps: das Set-Kürzel (STD, FND, BOB) ersetzt die Farbe.
  const farbe = art === 'SW' || (art === 'KC' && teile.length > 1) ? null : erster(t, FARBEN)
  if (farbe) teile.push(farbe)
  if (art === 'KB') teile.push(...tastaturKonfiguration(t))
  return teile.join('-')
}

/**
 * Vollständiger Vorschlag: Rumpf + die kleinste freie Laufnummer.
 * `vergeben` sind alle Nummern, die es schon gibt (Vergleich ohne Groß-/Kleinschreibung).
 */
export function artikelnummerVorschlag(e: ArtikelnummerEingabe, vergeben: Iterable<string> = []): string {
  const belegt = new Set([...vergeben].map((s) => s.toUpperCase()))
  const rumpf = artikelnummerRumpf(e)
  const stellen = rumpf.startsWith('KB-') ? 4 : 3
  for (let n = 1; n < 10000; n++) {
    const nummer = `${rumpf}-${String(n).padStart(stellen, '0')}`
    if (!belegt.has(nummer.toUpperCase())) return nummer
  }
  return `${rumpf}-${Date.now()}`
}

/** Vorschläge für mehrere Varianten auf einmal — untereinander eindeutig. */
export function artikelnummerVorschlaege<T extends ArtikelnummerEingabe & { id: string }>(
  varianten: readonly T[],
  vergeben: Iterable<string>,
): Map<string, string> {
  const belegt = new Set(vergeben)
  const ergebnis = new Map<string, string>()
  for (const v of varianten) {
    const nummer = artikelnummerVorschlag(v, belegt)
    belegt.add(nummer)
    ergebnis.set(v.id, nummer)
  }
  return ergebnis
}
