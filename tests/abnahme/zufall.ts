/**
 * Abnahmetest — Zufallsszenario in beliebigem Umfang (Entscheidungslog
 * 2026-10-15, „Abnahmetest ×10: zufällig, seedbar").
 *
 * Erzeugt denselben Schritt-Typ wie das feste Szenario, nur zufällig und
 * vielfach: `faktor` 10 heißt rund zehnmal so viele Bestellungen, Shop-
 * Aufträge, Fertigungen, Zahlungen, Verträge wie im festen Plan. Der
 * Zufall ist seedbar (mulberry32) — derselbe Seed ergibt denselben Plan,
 * ein roter Lauf nennt ihn zum Nachstellen.
 *
 * Machbarkeit: der Generator führt jeden erzeugten Schritt sofort im
 * Rechenmodell aus und fragt es vor dem nächsten („ist der Fertigungs-
 * auftrag voll reserviert?", „ist die Lieferung versandbereit?", „was ist
 * frei?"). So entsteht nur, was das System auch annimmt — das Modell ist
 * das Orakel, der Live-Lauf prüft das Orakel.
 */
import { Modell, runden } from './modell.ts'
import {
  type Datum,
  PARTNER,
  PRODUKTE,
  SHOP_BRUTTO,
  STUECKLISTE,
  type Schritt,
  type Sku,
  type Szenario,
  monatsanfang,
  monatsende,
  tageAddieren,
} from './szenario.ts'

export interface ZufallOptionen {
  heute: Datum
  seed: number
  /** 1 ≈ Umfang des festen Szenarios; 10 = zehnfach. */
  faktor: number
}

/** mulberry32 — klein, deterministisch, für Testdaten völlig ausreichend. */
export function zufallsquelle(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KOMPONENTEN: Sku[] = STUECKLISTE.komponenten.map((k) => k.sku)
const JE: Record<Sku, number> = { 'ALU-CASE': 0, 'PCB-65': 0, 'SW-LIN': 0, DESKMAT: 0, 'KB-65': 0 }
for (const k of STUECKLISTE.komponenten) JE[k.sku] = k.menge

/** Preisrahmen je Kaufteil (netto je Stück, Belegwährung). */
const EINKAUFSPREIS: Record<Sku, [number, number]> = {
  'ALU-CASE': [34, 40],
  'PCB-65': [19, 24],
  'SW-LIN': [0.24, 0.32],
  DESKMAT: [7.5, 10],
  'KB-65': [0, 0],
}

export function szenarioZufaellig(o: ZufallOptionen): Szenario {
  const zufall = zufallsquelle(o.seed)
  const ganz = (von: number, bis: number) => von + Math.floor(zufall() * (bis - von + 1))
  const geld = (von: number, bis: number, stellen = 2) => runden(von + zufall() * (bis - von), stellen)
  const wuerfel = (p: number) => zufall() < p
  const wahl = <T>(liste: T[]): T => liste[Math.floor(zufall() * liste.length)]
  /** Erwartete Anzahl je Tag → ganze Zahl mit passendem Rest (keine Poisson-Spitzen nötig). */
  const anzahl = (jeMonat: number) => {
    const jeTag = jeMonat / 28
    return Math.floor(jeTag) + (wuerfel(jeTag - Math.floor(jeTag)) ? 1 : 0)
  }

  const monate: Datum[] = ['']
  for (let m = 1; m <= 6; m++) monate.push(monatsanfang(o.heute, m - 3))
  const faelligBis = monatsende(monate[5])
  const tag = (m: number, t: number): Datum => tageAddieren(monate[m], t - 1)

  const szenario: Szenario = { heute: o.heute, monate, faelligBis, schritte: [] }
  const modell = new Modell(szenario)
  const f = o.faktor

  const zaehler: Record<string, number> = {}
  const nr = (praefix: string) => `${praefix}${(zaehler[praefix] = (zaehler[praefix] ?? 0) + 1)}`
  const schritt = (s: Schritt) => {
    modell.schritt(s)
    szenario.schritte.push(s)
  }

  // --- Orakel-Abfragen am Modell -------------------------------------------
  const frei = (sku: Sku) => modell.frei(sku)
  const offeneAuftraege = () =>
    [...modell.auftraege.values()].filter((a) => a.status === 'sale' && a.lieferung.status !== 'done')
  const fertigbar = () =>
    offeneAuftraege().filter((a) =>
      a.fertigung.some((mo) => mo.status === 'confirmed' && mo.komponenten.every((k) => k.reserviert >= k.menge)),
    )
  const versandbereit = () => offeneAuftraege().filter((a) => a.lieferung.status === 'assigned')
  const stornierbar = () => offeneAuftraege().filter((a) => a.lieferung.status !== 'done')
  const eingangOffen = () => [...modell.bestellungen.values()].filter((po) => po.eingaenge.some((e) => e.status === 'assigned'))
  const abrechenbar = () =>
    [...modell.bestellungen.values()].filter((po) =>
      po.zeilen.some((z) => (z.service ? z.menge : z.erhalten) - z.berechnet > 0) && po.eingaenge.some((e) => e.status === 'done'),
    )
  const offeneRechnungen = () => [...modell.rechnungen.values()].filter((r) => r.status === 'posted' && modell.rechnungOffen(r) > 0)
  const setsBaubar = () => Math.min(...KOMPONENTEN.map((k) => Math.floor(Math.max(frei(k), 0) / JE[k])))

  // --- Einrichtung --------------------------------------------------------------
  schritt({ art: 'kontostand', stichtag: tageAddieren(monate[1], -1), saldo: geld(60_000, 160_000, 0) })
  schritt({ art: 'kurs', waehrung: 'USD', kurs: geld(0.86, 0.96, 4), ab: tag(1, 1) })

  const KATEGORIEN = ['Miete', 'Lizenz', 'Versicherung', 'Leasing', 'Wartung', 'Telefon', 'Steuerberater', 'Cloud']
  const vertraege: { id: string; zahltag: number; frist: number }[] = []
  for (let i = 0; i < Math.max(2, Math.round(2 * f)); i++) {
    const id = nr('V')
    const zahltag = ganz(1, 28)
    const frist = ganz(0, 2)
    schritt({ art: 'vertrag', id, name: `${wahl(KATEGORIEN)} ${id}`, betrag: geld(19, 900), zahltag, beginn: tag(1, 1), frist })
    vertraege.push({ id, zahltag, frist })
  }
  const darlehen: { id: string; zahltag: number }[] = []
  for (let i = 0; i < Math.max(1, Math.round(f / 4)); i++) {
    const id = nr('D')
    const zahltag = ganz(1, 28)
    schritt({
      art: 'darlehen', id, name: `Darlehen ${id}`, betrag: geld(2_000, 60_000, 0), zins_pct: geld(0, 9, 2),
      laufzeit: ganz(6, 60), zahltag, auszahlung_am: tag(1, ganz(1, 10)), darlehensart: wahl(['annuitaet', 'annuitaet', 'rate', 'endfaellig'] as const),
    })
    darlehen.push({ id, zahltag })
  }
  // Auszahlung in Tagesreihenfolge innerhalb von Monat 1 (unten).

  // Anfangsbestände per Inventur — Kaufteile zu Plankosten, keine Tastatur.
  for (const p of PRODUKTE) {
    if (p.sku === STUECKLISTE.produkt) continue
    const menge = p.sku === 'SW-LIN' ? ganz(0, 300 * f) : ganz(0, 4 * f)
    if (menge > 0) schritt({ art: 'inventur', produkt: p.sku, gezaehlt: menge })
  }

  // --- Bedarfsplanung: der Einkauf soll die Nachfrage etwa decken ------------------
  const shopJeMonat = 6 * f
  const b2bJeMonat = 0.7 * f
  const tastaturBedarf = shopJeMonat * 0.65 * 1.4 + b2bJeMonat * 2.5 + 0.3 * f * 2
  const deskmatBedarf = shopJeMonat * 0.5 * 1.8 + b2bJeMonat * 3

  const steuern: { id: string; faellig: Datum; monat: number }[] = []

  for (let monat = 1; monat <= 3; monat++) {
    // Kurswechsel ab Monat 2 (gilt ab Monatsanfang, Bestätigungen danach frieren ihn ein).
    if (monat > 1 && wuerfel(0.7)) schritt({ art: 'kurs', waehrung: 'USD', kurs: geld(0.84, 0.98, 4), ab: tag(monat, 1) })

    // Einkauf des Monats: ein bis mehrere Bestellungen je Lieferant, Mengen am Bedarf.
    const deckung = 1.1 + zufall() * 0.5
    let caseBedarf = Math.ceil(tastaturBedarf * deckung)
    let pcbBedarf = Math.ceil(tastaturBedarf * deckung)
    let switchBedarf = Math.ceil(tastaturBedarf * deckung * JE['SW-LIN'])
    let deskmatRest = Math.ceil(deskmatBedarf * deckung)
    const eurBestellungen = Math.max(1, Math.round(f * 0.7 * (0.6 + zufall())))
    const usdBestellungen = Math.max(1, Math.round(f * 0.5 * (0.6 + zufall())))
    const bestellTage: { tag: number; s: Schritt }[] = []
    for (let i = 0; i < eurBestellungen; i++) {
      const letzte = i === eurBestellungen - 1
      const positionen: { produkt: Sku; menge: number; preis: number }[] = []
      const cases = letzte ? caseBedarf : Math.min(caseBedarf, ganz(0, Math.ceil(caseBedarf / 2)))
      const pcbs = letzte ? pcbBedarf : Math.min(pcbBedarf, ganz(0, Math.ceil(pcbBedarf / 2)))
      const mats = letzte ? deskmatRest : Math.min(deskmatRest, ganz(0, Math.ceil(deskmatRest / 2)))
      if (cases > 0) positionen.push({ produkt: 'ALU-CASE', menge: cases, preis: geld(...EINKAUFSPREIS['ALU-CASE']) })
      if (pcbs > 0) positionen.push({ produkt: 'PCB-65', menge: pcbs, preis: geld(...EINKAUFSPREIS['PCB-65']) })
      if (mats > 0) positionen.push({ produkt: 'DESKMAT', menge: mats, preis: geld(...EINKAUFSPREIS.DESKMAT) })
      caseBedarf -= cases
      pcbBedarf -= pcbs
      deskmatRest -= mats
      if (positionen.length === 0) continue
      bestellTage.push({ tag: ganz(1, 12), s: { art: 'bestellung', id: nr('PO'), lieferant: PARTNER.lieferantEur, waehrung: 'EUR', positionen } })
    }
    for (let i = 0; i < usdBestellungen; i++) {
      const letzte = i === usdBestellungen - 1
      const menge = letzte ? switchBedarf : Math.min(switchBedarf, ganz(0, Math.ceil(switchBedarf / 2)))
      switchBedarf -= menge
      if (menge <= 0) continue
      const t = ganz(1, 12)
      const vorkasse = wuerfel(0.5)
      bestellTage.push({
        tag: t,
        s: {
          art: 'bestellung', id: nr('PO'), lieferant: PARTNER.lieferantUsd, waehrung: 'USD', referenz: `PI-${ganz(10_000, 99_999)}`,
          positionen: [{ produkt: 'SW-LIN', menge, preis: geld(...EINKAUFSPREIS['SW-LIN'], 3) }],
          fracht: wuerfel(0.7) ? geld(20, 180) : undefined,
          vorkasse_am: vorkasse ? tag(monat, t) : undefined,
        },
      })
    }

    const shopHeute = () => anzahl(shopJeMonat)
    for (let t = 1; t <= 28; t++) {
      const datum = tag(monat, t)

      // Fixkosten und Finanzen am Stichtag.
      for (const v of vertraege) if (v.zahltag === t && modell.vertraege.get(v.id)!.status !== 'gekuendigt') schritt({ art: 'vertrag_zahlen', vertrag: v.id, am: datum })
      for (const d of darlehen) {
        const dm = modell.darlehen.get(d.id)!
        if (monat === 1 && dm.status === 'geplant' && szenario.schritte.find((s) => s.art === 'darlehen' && s.id === d.id && s.auszahlung_am === datum)) {
          schritt({ art: 'darlehen_auszahlen', darlehen: d.id, am: datum })
        }
        const rate = dm.raten.find((r) => !r.bezahlt && r.faellig === datum)
        if (rate && dm.status === 'laufend' && wuerfel(0.9)) schritt({ art: 'darlehen_rate', darlehen: d.id, nr: rate.nr, am: datum })
      }
      for (const st of steuern) if (st.faellig === datum && wuerfel(0.85)) schritt({ art: 'steuer_zahlen', steuer: st.id, am: datum })
      if (t === 8 && monat > 1) {
        const id = nr('S')
        const faellig = tag(monat, 10)
        schritt({ art: 'steuer', id, bezeichnung: `USt-Voranmeldung Monat ${monat - 1}`, betrag: geld(400, 6000), von: tag(monat - 1, 1), bis: monatsende(monate[monat - 1]), faellig })
        steuern.push({ id, faellig, monat })
      }
      if (t === 20 && wuerfel(0.3)) {
        const id = nr('S')
        const faellig = tag(monat + 1, ganz(5, 25))
        schritt({ art: 'steuer', id, bezeichnung: `Gewerbesteuer-Vorauszahlung ${id}`, betrag: geld(200, 3000), von: tag(monat, 1), bis: monatsende(monate[monat]), faellig, steuerart: 'gewst' })
        steuern.push({ id, faellig, monat: monat + 1 })
      }

      // Bestellungen des Tages.
      for (const b of bestellTage) if (b.tag === t) schritt(b.s)

      // Wareneingänge: offene Eingänge kommen mit einiger Verzögerung, manchmal teilweise.
      for (const po of eingangOffen()) {
        if (!wuerfel(0.35)) continue
        const eingang = po.eingaenge.find((e) => e.status === 'assigned')!
        const teil = wuerfel(0.3) && eingang.zeilen.some((z) => z.menge >= 2)
        const mengen: Partial<Record<Sku, number>> = {}
        if (teil) for (const z of eingang.zeilen) mengen[z.sku] = z.menge >= 2 ? ganz(1, z.menge - 1) : z.menge
        schritt({ art: 'wareneingang', bestellung: po.id, mengen: teil ? mengen : undefined })
        if (wuerfel(0.5)) {
          const nummer = po.eingaenge.filter((e) => e.status === 'done').length
          schritt({ art: 'nebenkosten', bestellung: po.id, eingang: nummer, betrag: geld(15, 250), basis: wahl(['weight', 'value', 'quantity'] as const), typ: wahl(['freight', 'customs_duty', 'handling'] as const) })
        }
      }

      // Rechnungen: abrechenbare Bestellungen, Zahlung sofort, später oder (Vorkasse) gedeckt.
      for (const po of abrechenbar()) {
        if (!wuerfel(0.4)) continue
        const id = nr('R')
        const gedeckt = po.vorkasseEur > 0
        const sofort = !gedeckt && wuerfel(0.4)
        schritt({ art: 'rechnung', id, bestellung: po.id, datum, zahlen_am: sofort ? tag(monat, Math.min(28, t + ganz(0, 8))) : undefined, gedeckt })
      }
      for (const r of offeneRechnungen()) if (wuerfel(0.08) && r.datum < datum) schritt({ art: 'rechnung_zahlen', rechnung: r.id, am: datum })

      // Shop-Bestellungen des Tages: ein bis drei verschiedene Artikel.
      for (let i = 0; i < shopHeute(); i++) {
        const id = nr('SH')
        const positionen: { produkt: Sku; menge: number; preis: number }[] = []
        if (wuerfel(0.65)) positionen.push({ produkt: 'KB-65', menge: wuerfel(0.85) ? 1 : ganz(2, 3), preis: SHOP_BRUTTO['KB-65'] })
        if (positionen.length === 0 || wuerfel(0.45)) positionen.push({ produkt: 'DESKMAT', menge: ganz(1, 3), preis: SHOP_BRUTTO.DESKMAT })
        schritt({ art: 'shop_bestellung', id, nr: `#${1000 + Number(id.slice(2))}`, am: datum, positionen })
      }

      // B2B-Aufträge.
      if (wuerfel(b2bJeMonat / 28)) {
        const positionen: { produkt: Sku; menge: number; preis: number }[] = []
        if (wuerfel(0.8)) positionen.push({ produkt: 'KB-65', menge: ganz(1, 5), preis: geld(170, 195) })
        if (positionen.length === 0 || wuerfel(0.6)) positionen.push({ produkt: 'DESKMAT', menge: ganz(2, 8), preis: geld(22, 27) })
        schritt({ art: 'auftrag', id: nr('B'), kunde: PARTNER.kunde, positionen })
      }

      // Fertigung: reservierte Aufträge werden gebaut, Lieferungen versandbereit → raus.
      for (const a of fertigbar()) if (wuerfel(0.6)) schritt({ art: 'fertig', auftrag: a.id })
      for (const a of versandbereit()) if (wuerfel(0.7)) schritt({ art: 'versand', auftrag: a.id })

      // Fertigung auf Lager, Demontage, Ausschuss, Inventur — gelegentlich.
      if (wuerfel((0.3 * f) / 28) && setsBaubar() >= 3) {
        schritt({ art: 'fertigung', id: nr('MO'), produkt: 'KB-65', menge: ganz(1, Math.min(3, setsBaubar())) })
      }
      if (wuerfel((0.3 * f) / 28) && frei('KB-65') >= 1) schritt({ art: 'demontage', produkt: 'KB-65', menge: 1 })
      if (wuerfel((0.4 * f) / 28)) {
        const sku = wahl(KOMPONENTEN.concat('DESKMAT'))
        if (frei(sku) >= 5) schritt({ art: 'ausschuss', produkt: sku, menge: ganz(1, 3) })
      }
      if (wuerfel((0.7 * f) / 28)) {
        const sku = wahl(KOMPONENTEN.concat('DESKMAT'))
        const minus = Math.min(3, Math.max(frei(sku), 0))
        const differenz = ganz(-minus, 3)
        if (differenz !== 0) schritt({ art: 'inventur', produkt: sku, differenz })
      }

      // Stornos: Shop (per Webhook) oder B2B, offene Lieferung.
      if (wuerfel((0.6 * f) / 28)) {
        const kandidaten = stornierbar()
        if (kandidaten.length > 0) {
          const a = wahl(kandidaten)
          schritt(a.quelle === 'shop' ? { art: 'shop_storno', bestellung: a.id } : { art: 'auftrag_storno', auftrag: a.id })
        }
      }

      // Kündigungen in Monat 3 zum Ende von Monat 5 (fristgerecht bei Frist ≤ 2 Monaten).
      if (monat === 3 && t === 12) {
        for (const v of vertraege) if (v.frist <= 2 && wuerfel(0.25)) schritt({ art: 'vertrag_kuendigen', vertrag: v.id, zum: monatsende(monate[5]) })
      }
    }
    schritt({ art: 'monatsende', monat: monat as 1 | 2 | 3 })
  }

  return szenario
}

/** Kurze Statistik eines Szenarios — für Protokoll und Bericht. */
export function szenarioStatistik(s: Szenario): Record<string, number> {
  const z: Record<string, number> = {}
  for (const st of s.schritte) z[st.art] = (z[st.art] ?? 0) + 1
  return z
}
