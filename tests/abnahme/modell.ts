/**
 * Abnahmetest — das Rechenmodell (Entscheidungslog 2026-10-15).
 *
 * Rechnet das Szenario VORHER durch, ohne Datenbank: Bestand und
 * Reservierung je Artikel, gleitender Durchschnittspreis (AVCO) mit den
 * Rundungen der SQL-Funktionen (valuation_apply, confirm_purchase_order,
 * mo_produce, landed_cost_post), Belegstände, Umsätze je Auftragsmonat,
 * Zahlungen und Kontosaldo, offene Verbindlichkeiten, Fälligkeiten der
 * Verträge, Darlehen und Steuern — und die Mengen, die Shopify gemeldet
 * bekommt (shopify_soll_menge: baubar − Puffer bzw. freier Bestand).
 *
 * Der Live-Lauf liest dieselben Kennzahlen aus der Datenbank (ist.ts) und
 * vergleicht Feld für Feld. Rechenregeln sind hier bewusst Zeile für Zeile
 * nachgebaut statt importiert — das Modell ist die zweite, unabhängige
 * Rechnung, nicht eine Kopie der ersten.
 */
import {
  ARBEITSGANG,
  BANKKONTO,
  ERSTER_KONTOSTAND,
  type Datum,
  PRODUKTE,
  SHOP_VERSAND_BRUTTO,
  SHOPIFY_MTO,
  STEUERSATZ,
  STUECKLISTE,
  type Schritt,
  type Sku,
  type Szenario,
  monat,
  monatsanfang,
  monateAddieren,
  tageAddieren,
} from './szenario.ts'

// --- Vergleichbarer Stand -------------------------------------------------------

export interface BestandZeile {
  on_hand: number
  reserviert: number
  frei: number
  bewertet: number
  wert: number
  mac: number
}

export interface Stand {
  bestand: Record<Sku, BestandZeile>
  lagerwert: number
  baubar: number
  shopify: {
    soll: Record<string, number>
    gemeldet: Record<string, number | null>
    mto_eingerichtet: boolean
    fulfillments: number
  }
  belege: {
    auftraege: Record<string, number>
    bestellungen: Record<string, number>
    fertigungsauftraege: Record<string, number>
    lieferungen: Record<string, number>
    wareneingaenge: Record<string, number>
    rechnungen: Record<string, number>
    /** Kundenbelege (0115) je „art:status" — rechnung:bezahlt, rechnung:offen, gutschrift:bezahlt … */
    kundenrechnungen: Record<string, number>
    demontagen: number
  }
  umsatz: {
    je_monat: Record<string, { netto: number; steuer: number; brutto: number; auftraege: number }>
    shop_brutto: number
    b2b_netto: number
    /** Summe der gültigen Kundenrechnungen brutto abzüglich Gutschriften. */
    rechnungen_brutto: number
  }
  fertigung: { material: number; lohn: number; stueck: number }
  zahlungen: {
    je_monat: Record<string, { ein: number; aus: number; anzahl: number }>
    saldo: Record<string, number>
  }
  verbindlichkeiten: { offen: number; rechnungen: number }
  faellig: Record<string, { anzahl: number; summe: number }>
  vertraege: Record<string, { status: string; ende: string | null; gezahlt: number }>
  darlehen: Record<
    string,
    { status: string; restschuld: number; bezahlte_raten: number; naechste: string | null; rate: number }
  >
  steuern: { offen: number; bezahlt: number }
  deckungsbeitrag: { umsatz: number; einsatz: number }
}

export interface Erwartung {
  monate: Record<number, Stand>
}

// --- Rundung wie Postgres (kaufmännisch, halb weg von null) ----------------------

export function runden(x: number, stellen: number): number {
  const f = 10 ** stellen
  const vorzeichen = x < 0 ? -1 : 1
  // Epsilon gegen Gleitkomma-Rauschen (2.675 × 100 = 267.49999…).
  return (vorzeichen * Math.round(Math.abs(x) * f + 1e-7)) / f
}
const r2 = (x: number) => runden(x, 2)
const r4 = (x: number) => runden(x, 4)
const r6 = (x: number) => runden(x, 6)

// --- Innere Zustände -------------------------------------------------------------

interface Artikel {
  onHand: number
  reserviert: number
  bewertet: number
  wert: number
  mac: number
  kosten: number
  gewicht: number
}

interface Lieferzeile {
  sku: Sku
  menge: number
  reserviert: number
  erledigt: boolean
}

interface Lieferung {
  zeilen: Lieferzeile[]
  status: 'confirmed' | 'assigned' | 'done' | 'cancel'
  /** Reihenfolge der Entstehung — die Warteschlange der Live-Reservierung (0086) bedient den ältesten Termin zuerst. */
  reihe: number
}

interface Fertigungsauftrag {
  produkt: Sku
  menge: number
  komponenten: { sku: Sku; menge: number; reserviert: number }[]
  status: 'confirmed' | 'done' | 'cancel'
  material: number
  lohn: number
  auftrag?: string
  reihe: number
}

interface Auftrag {
  id: string
  quelle: 'shop' | 'b2b'
  monat: string
  zeilen: { sku: Sku; menge: number; preis: number }[]
  status: 'sale' | 'cancel'
  lieferung: Lieferung
  fertigung: Fertigungsauftrag[]
}

interface Bestellzeile {
  sku: Sku | 'FRACHT'
  menge: number
  preis: number
  service: boolean
  erhalten: number
  berechnet: number
  /** Einstand je Lagereinheit in Hauswährung (confirm_purchase_order). */
  einstand: number
}

interface Eingang {
  zeilen: { sku: Sku; menge: number; einstand: number; erledigt: number }[]
  status: 'assigned' | 'done'
}

interface Bestellung {
  id: string
  waehrung: 'EUR' | 'USD'
  kurs: number
  zeilen: Bestellzeile[]
  eingaenge: Eingang[]
  /** Vorkasse über den Zahlplan (bereits in Euro) — wird auf Rechnungen angerechnet. */
  vorkasseEur: number
}

interface Rechnung {
  id: string
  bestellung: string
  datum: Datum
  waehrung: 'EUR' | 'USD'
  zeilen: { menge: number; preis: number }[]
  status: 'posted' | 'paid'
  gezahltEur: number
}

/** Kundenbeleg (0115): entsteht mit der Lieferung — Shop bezahlt, B2B offen mit Zahlungsziel. */
interface Kundenrechnung {
  auftrag: string
  art: 'rechnung' | 'gutschrift'
  status: 'offen' | 'bezahlt' | 'storniert'
  brutto: number
  faellig: Datum
}

interface Zahlung {
  richtung: 'ein' | 'aus'
  betragEur: number
  am: Datum
  konto: boolean
}

interface Vertrag {
  id: string
  name: string
  betrag: number
  zahltag: number
  beginn: Datum
  status: 'aktiv' | 'gekuendigt'
  gekuendigtZum: Datum | null
  zahlungen: Datum[]
}

interface Rate {
  nr: number
  faellig: Datum
  zins: number
  tilgung: number
  restschuld: number
  bezahlt: Datum | null
}

interface Darlehen {
  id: string
  name: string
  betrag: number
  annuitaet: number
  raten: Rate[]
  status: 'geplant' | 'laufend'
}

interface Steuer {
  id: string
  betrag: number
  faellig: Datum
  bezahlt: Datum | null
}

const JE: Record<Sku, number> = { 'ALU-CASE': 0, 'PCB-65': 0, 'SW-LIN': 0, DESKMAT: 0, 'KB-65': 0 }
for (const k of STUECKLISTE.komponenten) JE[k.sku] = k.menge

export class Modell {
  heute: Datum
  artikel = {} as Record<Sku, Artikel>
  kurse: { waehrung: string; kurs: number; ab: Datum }[] = []
  anker: { stichtag: Datum; saldo: number } | null = null
  auftraege = new Map<string, Auftrag>()
  bestellungen = new Map<string, Bestellung>()
  rechnungen = new Map<string, Rechnung>()
  fertigungsauftraege: Fertigungsauftrag[] = []
  zahlungen: Zahlung[] = []
  vertraege = new Map<string, Vertrag>()
  darlehen = new Map<string, Darlehen>()
  steuern = new Map<string, Steuer>()
  demontagen = 0
  fulfillments = 0
  /** Zuletzt an Shopify gemeldete Menge je verknüpftem Artikel (null = nie). */
  gemeldet: Record<string, number | null> = {}
  mtoEingerichtet = false
  /** Gelieferte Mengen je Artikel samt Erlös — Basis des Deckungsbeitrags. */
  geliefert: { sku: Sku; menge: number; preis: number }[] = []
  faelligBis: Datum
  kundenrechnungen: Kundenrechnung[] = []
  /** Laufende Nummer für Lieferungen und Fertigungsaufträge (Reihenfolge der Warteschlange). */
  reihe = 0

  constructor(szenario: Szenario) {
    this.heute = szenario.heute
    this.faelligBis = szenario.faelligBis
    for (const p of PRODUKTE) {
      this.artikel[p.sku] = { onHand: 0, reserviert: 0, bewertet: 0, wert: 0, mac: 0, kosten: p.kosten, gewicht: p.gewicht_g }
      if (p.shopify) this.gemeldet[p.sku] = null
    }
  }

  // --- Kurse ---------------------------------------------------------------

  kursAm(waehrung: string, datum: Datum): number {
    if (waehrung === 'EUR') return 1
    const passend = this.kurse
      .filter((k) => k.waehrung === waehrung && k.ab <= datum)
      .sort((a, b) => (a.ab < b.ab ? 1 : -1))
    return passend[0]?.kurs ?? 1
  }

  // --- Bewertung (valuation_apply) ----------------------------------------

  /** Zugang: Preis aus Parameter, sonst Durchschnitt, sonst Plankosten. */
  zugang(sku: Sku, menge: number, einstand: number | null): void {
    const a = this.artikel[sku]
    const unit = einstand ?? (a.mac !== 0 ? a.mac : a.kosten)
    this.schicht(a, menge, r4(menge * unit))
    a.onHand += menge
  }

  /** Abgang: immer zum aktuellen Durchschnitt. */
  abgang(sku: Sku, menge: number): number {
    const a = this.artikel[sku]
    const wert = r4(-menge * a.mac)
    this.schicht(a, -menge, wert)
    a.onHand -= menge
    return wert
  }

  wertbuchung(sku: Sku, wert: number): void {
    this.schicht(this.artikel[sku], 0, wert)
  }

  private schicht(a: Artikel, menge: number, wert: number): void {
    let qty = a.bewertet + menge
    let value = a.wert + wert
    if (Math.abs(qty) < 0.0001) {
      qty = 0
      value = 0
    }
    a.bewertet = qty
    a.wert = value
    if (qty > 0) a.mac = r6(value / qty)
  }

  // --- Reservierung (move_reserve / quant_apply) --------------------------

  frei(sku: Sku): number {
    const a = this.artikel[sku]
    return a.onHand - a.reserviert
  }

  reservieren(sku: Sku, bedarf: number): number {
    const a = this.artikel[sku]
    const verfuegbar = Math.max(a.onHand - a.reserviert, 0)
    const nehmen = Math.min(bedarf, verfuegbar)
    if (nehmen > 0) a.reserviert += nehmen
    return nehmen
  }

  freigeben(sku: Sku, menge: number): void {
    if (menge > 0) this.artikel[sku].reserviert -= menge
  }

  // --- Zahlungen ----------------------------------------------------------

  zahlen(richtung: 'ein' | 'aus', betragEur: number, am: Datum, konto: boolean): void {
    this.zahlungen.push({ richtung, betragEur, am, konto })
  }

  // --- Shopify-Mengen (shopify_soll_menge, baubar) ------------------------

  baubar(): number {
    let min: number | null = null
    for (const k of STUECKLISTE.komponenten) {
      const reicht = Math.floor(Math.max(this.frei(k.sku), 0) / k.menge)
      if (min === null || reicht < min) min = reicht
    }
    return min ?? 0
  }

  soll(sku: Sku): number {
    const p = PRODUKTE.find((x) => x.sku === sku)!
    if (!p.mto) return Math.floor(this.frei(sku))
    const menge = Math.floor(this.baubar() + Math.max(this.frei(sku), 0))
    return Math.min(Math.max(menge - SHOPIFY_MTO.puffer, 0), SHOPIFY_MTO.deckel)
  }

  // --- Belegwege ----------------------------------------------------------

  /** confirm_sales_order: Lieferung anlegen, je MTO-Zeile ein Fertigungsauftrag (reserviert zuerst), dann Lieferung reservieren. */
  auftragBestaetigen(a: Auftrag): void {
    for (const z of a.zeilen) {
      if (z.sku !== STUECKLISTE.produkt) continue
      const mo = this.fertigungsauftragAnlegen(z.sku, z.menge, a.id)
      a.fertigung.push(mo)
    }
    this.lieferungReservieren(a.lieferung)
  }

  fertigungsauftragAnlegen(produkt: Sku, menge: number, auftrag?: string): Fertigungsauftrag {
    const mo: Fertigungsauftrag = {
      produkt,
      menge,
      komponenten: STUECKLISTE.komponenten.map((k) => ({ sku: k.sku, menge: r6(k.menge * menge), reserviert: 0 })),
      status: 'confirmed',
      material: 0,
      lohn: 0,
      auftrag,
      reihe: ++this.reihe,
    }
    for (const k of mo.komponenten) k.reserviert = this.reservieren(k.sku, k.menge)
    this.fertigungsauftraege.push(mo)
    return mo
  }

  lieferungReservieren(l: Lieferung): void {
    if (l.status === 'done' || l.status === 'cancel') return
    for (const z of l.zeilen) {
      const bedarf = z.menge - z.reserviert
      if (bedarf > 0) z.reserviert += this.reservieren(z.sku, bedarf)
    }
    l.status = l.zeilen.every((z) => z.reserviert >= z.menge) ? 'assigned' : 'confirmed'
  }

  /** mo_produce: Komponenten zum Durchschnitt verbrauchen, Lohn aus dem Arbeitsgang, Erzeugnis zu Herstellkosten. */
  fertigMelden(mo: Fertigungsauftrag): void {
    if (mo.status !== 'confirmed') throw new Error('Fertigungsauftrag ist nicht offen')
    let material = 0
    for (const k of mo.komponenten) {
      this.freigeben(k.sku, k.reserviert)
      k.reserviert = 0
      material += -this.abgang(k.sku, k.menge)
    }
    // Arbeitsgang: duration_expected = round((setup + dauer × faktor) / effizienz, 2); real = expected × 1.
    const dauer = r2(r2((0 + ARBEITSGANG.minuten * mo.menge) / 1) * 1)
    const lohn = r4((dauer / 60) * ARBEITSGANG.satz)
    const einstand = material + lohn > 0 ? r6((material + lohn) / mo.menge) : null
    this.zugang(mo.produkt, mo.menge, einstand)
    mo.material = material
    mo.lohn = lohn
    mo.status = 'done'
    if (mo.auftrag) {
      const a = this.auftraege.get(mo.auftrag)!
      if (a.fertigung.every((m) => m.status !== 'confirmed')) this.lieferungReservieren(a.lieferung)
    }
  }

  /** picking_validate: Reservierung lösen, Abgang zum Durchschnitt, Erlös merken — und die Rechnung (0115). */
  liefern(a: Auftrag): void {
    const l = a.lieferung
    if (l.status !== 'assigned') throw new Error(`${a.id}: Lieferung ist nicht versandbereit (${l.status})`)
    let netto = 0
    let steuer = 0
    for (const z of l.zeilen) {
      this.freigeben(z.sku, z.reserviert)
      z.reserviert = 0
      this.abgang(z.sku, z.menge)
      z.erledigt = true
      const preis = a.zeilen.find((x) => x.sku === z.sku)!.preis
      this.geliefert.push({ sku: z.sku, menge: z.menge, preis })
      // kundenrechnung_aus_lieferung: je Position netto = round2(Menge × Preis), Steuer je Position gerundet.
      const n = r2(z.menge * preis)
      netto = r2(netto + n)
      steuer = r2(steuer + r2((n * STEUERSATZ) / 100))
    }
    l.status = 'done'
    if (a.quelle === 'shop') {
      this.fulfillments++
      // Versand einmal je Auftrag (netto aus dem Shop-Brutto), Steuer zum Satz der Positionen.
      netto = r2(netto + SHOP_VERSAND_NETTO)
      steuer = r2(steuer + r2((SHOP_VERSAND_NETTO * STEUERSATZ) / 100))
    }
    this.kundenrechnungen.push({
      auftrag: a.id,
      art: 'rechnung',
      // Shop-Aufträge sind bezahlt (Zahlung lief im Shop), B2B offen mit Zahlungsziel 14 Tage.
      status: a.quelle === 'shop' ? 'bezahlt' : 'offen',
      brutto: r2(netto + steuer),
      faellig: tageAddieren(this.heute, 14),
    })
  }

  /** cancel_sales_order: offene Lieferung und nicht begonnene Fertigung stornieren, Reservierungen lösen. */
  stornieren(a: Auftrag): void {
    const l = a.lieferung
    // Shop-Storno/Erstattung nach der Rechnung: der Import storniert jede
    // gültige Rechnung mit Gutschrift — im Shop erstattet, also bezahlt.
    if (a.quelle === 'shop') {
      for (const k of this.kundenrechnungen.filter((k) => k.auftrag === a.id && k.art === 'rechnung' && k.status !== 'storniert')) {
        k.status = 'storniert'
        this.kundenrechnungen.push({ auftrag: a.id, art: 'gutschrift', status: 'bezahlt', brutto: k.brutto, faellig: this.heute })
      }
    }
    if (l.status !== 'done' && l.status !== 'cancel') {
      for (const z of l.zeilen) {
        this.freigeben(z.sku, z.reserviert)
        z.reserviert = 0
      }
      l.status = 'cancel'
    }
    for (const mo of a.fertigung) {
      if (mo.status !== 'confirmed') continue
      for (const k of mo.komponenten) {
        this.freigeben(k.sku, k.reserviert)
        k.reserviert = 0
      }
      mo.status = 'cancel'
    }
    a.status = 'cancel'
  }

  rechnungOffen(r: Rechnung): number {
    const po = this.bestellungen.get(r.bestellung)!
    const brutto = r.zeilen.reduce((s, z) => s + r2(z.menge * z.preis) + r2((z.menge * z.preis * STEUERSATZ) / 100), 0)
    return Math.max(0, r2(brutto * this.kursAm(r.waehrung, r.datum) - r.gezahltEur - po.vorkasseEur))
  }

  /**
   * Live-Reservierung (0086): am Ende jeder Buchung bekommen wartende
   * Bewegungen frei gewordene Ware — Lieferzeilen und Fertigungskomponenten
   * desselben Artikels, ältester Termin zuerst, Teilreservierung erlaubt.
   */
  nachreservieren(): void {
    for (const p of PRODUKTE) {
      const sku = p.sku
      if (this.frei(sku) <= 0) continue
      const wartend: { reihe: number; zeile: { menge: number; reserviert: number }; lieferung?: Lieferung }[] = []
      for (const a of this.auftraege.values()) {
        const l = a.lieferung
        if (l.status === 'done' || l.status === 'cancel') continue
        for (const z of l.zeilen) if (z.sku === sku && z.reserviert < z.menge) wartend.push({ reihe: l.reihe, zeile: z, lieferung: l })
      }
      for (const mo of this.fertigungsauftraege) {
        if (mo.status !== 'confirmed') continue
        for (const k of mo.komponenten) if (k.sku === sku && k.reserviert < k.menge) wartend.push({ reihe: mo.reihe, zeile: k })
      }
      wartend.sort((a, b) => a.reihe - b.reihe)
      const lieferungen = new Set<Lieferung>()
      for (const w of wartend) {
        if (this.frei(sku) <= 0) break
        w.zeile.reserviert += this.reservieren(sku, w.zeile.menge - w.zeile.reserviert)
        if (w.lieferung) lieferungen.add(w.lieferung)
      }
      for (const l of lieferungen) l.status = l.zeilen.every((z) => z.reserviert >= z.menge) ? 'assigned' : 'confirmed'
    }
  }

  // --- Schritte -------------------------------------------------------------

  /** Ein Schritt = eine (oder wenige) Buchungen; danach läuft die Live-Reservierung wie der Constraint-Trigger. */
  schritt(s: Schritt): void {
    this.buchen(s)
    this.nachreservieren()
  }

  private buchen(s: Schritt): void {
    switch (s.art) {
      case 'kurs':
        this.kurse.push({ waehrung: s.waehrung, kurs: s.kurs, ab: s.ab })
        return
      case 'kontostand':
        this.anker = { stichtag: s.stichtag, saldo: s.saldo }
        return
      case 'vertrag':
        this.vertraege.set(s.id, { id: s.id, name: s.name, betrag: s.betrag, zahltag: s.zahltag, beginn: s.beginn, status: 'aktiv', gekuendigtZum: null, zahlungen: [] })
        return
      case 'vertrag_zahlen': {
        const v = this.vertraege.get(s.vertrag)!
        v.zahlungen.push(s.am)
        this.zahlen('aus', r2(v.betrag), s.am, true)
        return
      }
      case 'vertrag_kuendigen': {
        const v = this.vertraege.get(s.vertrag)!
        v.status = 'gekuendigt'
        v.gekuendigtZum = s.zum
        return
      }
      case 'darlehen':
        this.darlehen.set(s.id, this.tilgungsplan(s))
        return
      case 'darlehen_auszahlen': {
        const d = this.darlehen.get(s.darlehen)!
        d.status = 'laufend'
        this.zahlen('ein', r2(d.betrag), s.am, true)
        return
      }
      case 'darlehen_rate': {
        const d = this.darlehen.get(s.darlehen)!
        const rate = d.raten.find((x) => x.nr === s.nr)!
        this.zahlen('aus', r2(rate.zins + rate.tilgung), s.am, true)
        rate.bezahlt = s.am
        return
      }
      case 'steuer':
        this.steuern.set(s.id, { id: s.id, betrag: s.betrag, faellig: s.faellig, bezahlt: null })
        return
      case 'steuer_zahlen': {
        const st = this.steuern.get(s.steuer)!
        this.zahlen('aus', r2(st.betrag), s.am, true)
        st.bezahlt = s.am
        return
      }
      case 'inventur': {
        const buch = this.artikel[s.produkt].onHand
        const gezaehlt = s.gezaehlt ?? buch + (s.differenz ?? 0)
        const diff = gezaehlt - buch
        if (diff > 0) this.zugang(s.produkt, diff, null)
        else if (diff < 0) this.abgang(s.produkt, -diff)
        return
      }
      case 'bestellung':
        this.bestellen(s)
        return
      case 'wareneingang':
        this.wareneingang(s.bestellung, s.mengen)
        return
      case 'nebenkosten':
        this.nebenkosten(s)
        return
      case 'rechnung':
        this.rechnung(s)
        return
      case 'rechnung_zahlen': {
        const r = this.rechnungen.get(s.rechnung)!
        const offen = this.rechnungOffen(r)
        this.zahlen('aus', offen, s.am, true)
        r.gezahltEur = r2(r.gezahltEur + offen)
        if (this.rechnungOffen(r) <= 0) r.status = 'paid'
        return
      }
      case 'shop_bestellung': {
        const a: Auftrag = {
          id: s.id,
          quelle: 'shop',
          monat: monat(s.am),
          // Steuer im Preis: netto = round(brutto / 1,19, 2) (positionNetto).
          zeilen: s.positionen.map((p) => ({ sku: p.produkt, menge: p.menge, preis: r2(p.preis / (1 + STEUERSATZ / 100)) })),
          status: 'sale',
          lieferung: { zeilen: s.positionen.map((p) => ({ sku: p.produkt, menge: p.menge, reserviert: 0, erledigt: false })), status: 'confirmed', reihe: ++this.reihe },
          fertigung: [],
        }
        this.auftraege.set(s.id, a)
        this.auftragBestaetigen(a)
        return
      }
      case 'auftrag': {
        const a: Auftrag = {
          id: s.id,
          quelle: 'b2b',
          monat: monat(this.heute),
          zeilen: s.positionen.map((p) => ({ sku: p.produkt, menge: p.menge, preis: p.preis })),
          status: 'sale',
          lieferung: { zeilen: s.positionen.map((p) => ({ sku: p.produkt, menge: p.menge, reserviert: 0, erledigt: false })), status: 'confirmed', reihe: ++this.reihe },
          fertigung: [],
        }
        this.auftraege.set(s.id, a)
        this.auftragBestaetigen(a)
        return
      }
      case 'shop_storno':
        this.stornieren(this.auftraege.get(s.bestellung)!)
        return
      case 'auftrag_storno':
        this.stornieren(this.auftraege.get(s.auftrag)!)
        return
      case 'fertig': {
        const a = this.auftraege.get(s.auftrag)!
        for (const mo of a.fertigung) if (mo.status === 'confirmed') this.fertigMelden(mo)
        return
      }
      case 'fertigung':
        this.fertigMelden(this.fertigungsauftragAnlegen(s.produkt, s.menge))
        return
      case 'versand':
        this.liefern(this.auftraege.get(s.auftrag)!)
        return
      case 'demontage': {
        // unbuild_apply: Erzeugnis zum Durchschnitt hinaus, Komponenten zu ihrem Durchschnitt (sonst Plankosten) zurück.
        this.abgang(s.produkt, s.menge)
        for (const k of STUECKLISTE.komponenten) this.zugang(k.sku, r6(k.menge * s.menge), null)
        this.demontagen++
        return
      }
      case 'ausschuss':
        this.abgang(s.produkt, s.menge)
        return
      case 'monatsende':
        // Shopify-Abgleich: gemeldet wird, was shopify_soll_menge sagt; die
        // Tastatur (MTO) wird beim ersten Abgleich im Shop eingerichtet.
        for (const p of PRODUKTE) if (p.shopify) this.gemeldet[p.sku] = this.soll(p.sku)
        this.mtoEingerichtet = true
        return
    }
  }

  /** darlehen_raten_generieren: Annuität, lineare Rate oder endfällig; Monatszins, Rundung je Rate. */
  private tilgungsplan(s: Extract<Schritt, { art: 'darlehen' }>): Darlehen {
    const art = s.darlehensart ?? 'annuitaet'
    const i = s.zins_pct / 100 / 12
    const n = s.laufzeit
    const annuitaet = art !== 'annuitaet' ? 0 : i > 0 ? r2((s.betrag * i) / (1 - (1 + i) ** -n)) : r2(s.betrag / n)
    let rest = s.betrag
    const raten: Rate[] = []
    for (let m = 1; m <= s.laufzeit; m++) {
      const faellig = tageAddieren(monatsanfang(monateAddieren(s.auszahlung_am, m)), s.zahltag - 1)
      const zins = r2(rest * i)
      let tilgung: number
      if (m === s.laufzeit) tilgung = rest
      else if (art === 'endfaellig') tilgung = 0
      else if (art === 'rate') tilgung = r2(s.betrag / n)
      else tilgung = Math.min(rest, r2(annuitaet - zins))
      rest = r2(rest - tilgung)
      raten.push({ nr: m, faellig, zins, tilgung, restschuld: rest, bezahlt: null })
    }
    return { id: s.id, name: s.name, betrag: s.betrag, annuitaet, raten, status: 'geplant' }
  }

  private bestellen(s: Extract<Schritt, { art: 'bestellung' }>): void {
    // Kurs wird bei der Bestätigung eingefroren — zum Tageskurs.
    const kurs = this.kursAm(s.waehrung, this.heute)
    const zeilen: Bestellzeile[] = s.positionen.map((p) => ({
      sku: p.produkt,
      menge: p.menge,
      preis: p.preis,
      service: false,
      erhalten: 0,
      berechnet: 0,
      einstand: r6((p.menge * p.preis * kurs) / p.menge),
    }))
    if (s.fracht) zeilen.push({ sku: 'FRACHT', menge: 1, preis: s.fracht, service: true, erhalten: 0, berechnet: 0, einstand: 0 })
    const po: Bestellung = {
      id: s.id,
      waehrung: s.waehrung,
      kurs,
      zeilen,
      eingaenge: [
        {
          zeilen: zeilen.filter((z) => !z.service).map((z) => ({ sku: z.sku as Sku, menge: z.menge, einstand: z.einstand, erledigt: 0 })),
          status: 'assigned',
        },
      ],
      vorkasseEur: 0,
    }
    if (s.vorkasse_am) {
      const brutto = zeilen.reduce((sum, z) => sum + r2(z.menge * z.preis) + r2((r2(z.menge * z.preis) * STEUERSATZ) / 100), 0)
      const eur = r2(r2(brutto) * this.kursAm(s.waehrung, s.vorkasse_am))
      po.vorkasseEur = eur
      this.zahlen('aus', eur, s.vorkasse_am, false)
    }
    this.bestellungen.set(s.id, po)
  }

  private wareneingang(bestellung: string, mengen?: Partial<Record<Sku, number>>): void {
    const po = this.bestellungen.get(bestellung)!
    const eingang = po.eingaenge.find((e) => e.status === 'assigned')
    if (!eingang) throw new Error(`${bestellung}: kein offener Wareneingang`)
    const rest: Eingang['zeilen'] = []
    for (const z of eingang.zeilen) {
      const erledigt = mengen?.[z.sku] ?? z.menge
      if (erledigt > 0) this.zugang(z.sku, erledigt, z.einstand)
      z.erledigt = erledigt
      po.zeilen.find((p) => p.sku === z.sku)!.erhalten += erledigt
      if (z.menge - erledigt > 0) rest.push({ sku: z.sku, menge: z.menge - erledigt, einstand: z.einstand, erledigt: 0 })
    }
    eingang.status = 'done'
    if (rest.length > 0) po.eingaenge.push({ zeilen: rest, status: 'assigned' })
  }

  private nebenkosten(s: Extract<Schritt, { art: 'nebenkosten' }>): void {
    const po = this.bestellungen.get(s.bestellung)!
    const eingang = po.eingaenge[s.eingang - 1]
    const betragEur = r4(s.betrag * 1)
    const basis = (z: Eingang['zeilen'][number]) =>
      s.basis === 'weight' ? z.erledigt * this.artikel[z.sku].gewicht : s.basis === 'value' ? z.erledigt * z.einstand : z.erledigt
    const gesamt = eingang.zeilen.reduce((sum, z) => sum + Math.max(basis(z), 0), 0)
    for (const z of eingang.zeilen) {
      const anteil = r4((betragEur * Math.max(basis(z), 0)) / gesamt)
      if (anteil === 0) continue
      this.wertbuchung(z.sku, anteil)
    }
  }

  private rechnung(s: Extract<Schritt, { art: 'rechnung' }>): void {
    const po = this.bestellungen.get(s.bestellung)!
    const zeilen: Rechnung['zeilen'] = []
    for (const z of po.zeilen) {
      // bill_policy: Waren „nach erhaltener Menge", Dienstleistungen (Fracht) „nach Bestellmenge" (0092).
      const abrechenbar = (z.service ? z.menge : z.erhalten) - z.berechnet
      if (abrechenbar <= 0) continue
      zeilen.push({ menge: abrechenbar, preis: r2(z.preis) })
      z.berechnet += abrechenbar
    }
    if (zeilen.length === 0) throw new Error(`${s.id}: nichts abzurechnen`)
    const r: Rechnung = { id: s.id, bestellung: s.bestellung, datum: s.datum, waehrung: po.waehrung, zeilen, status: 'posted', gezahltEur: 0 }
    this.rechnungen.set(s.id, r)
    if (s.zahlen_am) {
      const offen = this.rechnungOffen(r)
      this.zahlen('aus', offen, s.zahlen_am, true)
      r.gezahltEur = r2(r.gezahltEur + offen)
    }
    if (s.gedeckt && this.rechnungOffen(r) > 0) {
      // pay_vendor_bill: was die Vorkasse nicht deckt (Kurs gestiegen), zahlt
      // „Als bezahlt markieren" heute ohne Konto nach.
      const rest = this.rechnungOffen(r)
      this.zahlen('aus', rest, this.heute, false)
      r.gezahltEur = r2(r.gezahltEur + rest)
    }
    if ((s.zahlen_am || s.gedeckt) && this.rechnungOffen(r) <= 0) r.status = 'paid'
  }

  // --- Der vergleichbare Stand ----------------------------------------------

  stand(): Stand {
    const bestand = {} as Record<Sku, BestandZeile>
    let lagerwert = 0
    for (const p of PRODUKTE) {
      const a = this.artikel[p.sku]
      bestand[p.sku] = { on_hand: a.onHand, reserviert: a.reserviert, frei: a.onHand - a.reserviert, bewertet: a.bewertet, wert: r4(a.wert), mac: a.mac }
      lagerwert += a.wert
    }

    const zaehlen = <T>(liste: Iterable<T>, schluessel: (x: T) => string): Record<string, number> => {
      const r: Record<string, number> = {}
      for (const x of liste) r[schluessel(x)] = (r[schluessel(x)] ?? 0) + 1
      return r
    }
    const auftraege = [...this.auftraege.values()]
    const soll: Record<string, number> = {}
    for (const p of PRODUKTE) if (p.shopify) soll[p.sku] = this.soll(p.sku)

    const jeMonat: Stand['umsatz']['je_monat'] = {}
    let shopBrutto = 0
    let b2bNetto = 0
    for (const a of auftraege) {
      if (a.status !== 'sale') continue
      const netto = a.zeilen.reduce((s, z) => s + r2(z.menge * z.preis), 0)
      const steuer = a.zeilen.reduce((s, z) => s + r2((r2(z.menge * z.preis) * STEUERSATZ) / 100), 0)
      const m = (jeMonat[a.monat] ??= { netto: 0, steuer: 0, brutto: 0, auftraege: 0 })
      m.netto = r2(m.netto + netto)
      m.steuer = r2(m.steuer + steuer)
      m.brutto = r2(m.brutto + netto + steuer)
      m.auftraege++
      if (a.quelle === 'shop') shopBrutto = r2(shopBrutto + netto + steuer)
      else b2bNetto = r2(b2bNetto + netto)
    }

    const fertigung = { material: 0, lohn: 0, stueck: 0 }
    for (const mo of this.fertigungsauftraege) {
      if (mo.status !== 'done') continue
      fertigung.material = r4(fertigung.material + mo.material)
      fertigung.lohn = r4(fertigung.lohn + mo.lohn)
      fertigung.stueck += mo.menge
    }

    const zahlungenJeMonat: Stand['zahlungen']['je_monat'] = {}
    const saldo: Record<string, number> = { [BANKKONTO]: this.anker?.saldo ?? ERSTER_KONTOSTAND }
    let ohneKonto = 0
    let ohneKontoAnzahl = 0
    for (const z of this.zahlungen) {
      const m = (zahlungenJeMonat[monat(z.am)] ??= { ein: 0, aus: 0, anzahl: 0 })
      m[z.richtung] = r2(m[z.richtung] + z.betragEur)
      m.anzahl++
      const vorzeichen = z.richtung === 'ein' ? 1 : -1
      if (z.konto) {
        if (!this.anker || z.am > this.anker.stichtag) saldo[BANKKONTO] = r2(saldo[BANKKONTO] + vorzeichen * z.betragEur)
      } else {
        ohneKonto = r2(ohneKonto + vorzeichen * z.betragEur)
        ohneKontoAnzahl++
      }
    }
    if (ohneKontoAnzahl > 0) saldo['Ohne Konto'] = ohneKonto

    let offen = 0
    let offeneRechnungen = 0
    for (const r of this.rechnungen.values()) {
      if (r.status !== 'posted') continue
      const o = this.rechnungOffen(r)
      offen = r2(offen + o)
      if (o > 0) offeneRechnungen++
    }

    const vertraege: Stand['vertraege'] = {}
    for (const v of this.vertraege.values()) {
      vertraege[v.name] = { status: v.status, ende: v.gekuendigtZum, gezahlt: r2(v.zahlungen.length * v.betrag) }
    }

    const darlehen: Stand['darlehen'] = {}
    for (const d of this.darlehen.values()) {
      const bezahlte = d.raten.filter((x) => x.bezahlt)
      const naechste = d.raten.find((x) => !x.bezahlt)
      darlehen[d.name] = {
        status: d.status,
        restschuld: bezahlte.length ? bezahlte[bezahlte.length - 1].restschuld : d.betrag,
        bezahlte_raten: bezahlte.length,
        naechste: naechste?.faellig ?? null,
        // Rate 1 (Zins + Tilgung) — bei der Annuität die Annuität selbst.
        rate: r2(d.raten[0].zins + d.raten[0].tilgung),
      }
    }

    const steuern = { offen: 0, bezahlt: 0 }
    for (const st of this.steuern.values()) {
      if (st.bezahlt) steuern.bezahlt = r2(steuern.bezahlt + st.betrag)
      else steuern.offen = r2(steuern.offen + st.betrag)
    }

    // Deckungsbeitrag (mv_contribution_margin): Erlös je gelieferter Bewegung,
    // Wareneinsatz zu HEUTIGEM Einstandspreis je Artikel.
    const deckungsbeitrag = { umsatz: 0, einsatz: 0 }
    const mengen: Partial<Record<Sku, number>> = {}
    for (const g of this.geliefert) {
      deckungsbeitrag.umsatz = r4(deckungsbeitrag.umsatz + r4(g.menge * g.preis))
      mengen[g.sku] = (mengen[g.sku] ?? 0) + g.menge
    }
    for (const [sku, menge] of Object.entries(mengen) as [Sku, number][]) {
      deckungsbeitrag.einsatz = r4(deckungsbeitrag.einsatz + r4(menge * this.einstandspreisAktuell(sku)))
    }

    return {
      bestand,
      lagerwert: r4(lagerwert),
      baubar: this.baubar(),
      shopify: { soll, gemeldet: { ...this.gemeldet }, mto_eingerichtet: this.mtoEingerichtet, fulfillments: this.fulfillments },
      belege: {
        auftraege: zaehlen(auftraege, (a) => a.status),
        bestellungen: zaehlen(this.bestellungen.values(), () => 'purchase'),
        fertigungsauftraege: zaehlen(this.fertigungsauftraege, (m) => m.status),
        lieferungen: zaehlen(auftraege, (a) => a.lieferung.status),
        wareneingaenge: zaehlen([...this.bestellungen.values()].flatMap((po) => po.eingaenge), (e) => e.status),
        rechnungen: zaehlen(this.rechnungen.values(), (r) => r.status),
        kundenrechnungen: zaehlen(this.kundenrechnungen, (k) => `${k.art}:${k.status}`),
        demontagen: this.demontagen,
      },
      umsatz: {
        je_monat: jeMonat,
        shop_brutto: shopBrutto,
        b2b_netto: b2bNetto,
        rechnungen_brutto: r2(this.kundenrechnungen.reduce((sum, k) => (k.status === 'storniert' ? sum : sum + (k.art === 'rechnung' ? k.brutto : -k.brutto)), 0)),
      },
      fertigung,
      zahlungen: { je_monat: zahlungenJeMonat, saldo },
      verbindlichkeiten: { offen, rechnungen: offeneRechnungen },
      faellig: this.faellig(),
      vertraege,
      darlehen,
      steuern,
      deckungsbeitrag,
    }
  }

  /** einstandspreis_aktuell: Durchschnitt, sonst Plankosten, sonst Stücklistensumme. */
  einstandspreisAktuell(sku: Sku): number {
    const a = this.artikel[sku]
    if (a.mac > 0) return a.mac
    if (a.kosten > 0) return a.kosten
    if (sku !== STUECKLISTE.produkt) return 0
    return r6(STUECKLISTE.komponenten.reduce((s, k) => s + k.menge * this.einstandspreisAktuell(k.sku), 0))
  }

  /** finanz_faellig(bis): offene Rechnungen, Vertragstermine ab heute, unbezahlte Darlehensraten, Steuertermine. */
  faellig(): Stand['faellig'] {
    const gruppen: Stand['faellig'] = {}
    const hinzu = (quelle: string, betrag: number) => {
      const g = (gruppen[quelle] ??= { anzahl: 0, summe: 0 })
      g.anzahl++
      g.summe = r2(g.summe + betrag)
    }
    for (const r of this.rechnungen.values()) {
      const o = this.rechnungOffen(r)
      if (r.status === 'posted' && o > 0 && r.datum <= this.faelligBis) hinzu('vendor_bill', o)
    }
    for (const v of this.vertraege.values()) {
      const ende = v.gekuendigtZum ?? this.faelligBis
      const ab = v.beginn > this.heute ? v.beginn : this.heute
      for (let m = monatsanfang(v.beginn); m <= this.faelligBis; m = monateAddieren(m, 1)) {
        const termin = tageAddieren(m, v.zahltag - 1)
        if (termin < ab || termin > ende || termin > this.faelligBis) continue
        if (v.zahlungen.some((z) => monat(z) === monat(termin))) continue
        hinzu('vertrag', r2(v.betrag))
      }
    }
    for (const d of this.darlehen.values()) {
      if (d.status !== 'laufend') continue
      for (const rate of d.raten) {
        if (rate.bezahlt || rate.zins + rate.tilgung <= 0 || rate.faellig > this.faelligBis) continue
        hinzu('darlehen_rate', r2(rate.zins + rate.tilgung))
      }
    }
    for (const st of this.steuern.values()) {
      if (!st.bezahlt && st.betrag !== 0 && st.faellig <= this.faelligBis) hinzu('steuer', Math.abs(st.betrag))
    }
    // Offene Kundenrechnungen (Forderung) und offene Gutschriften (Erstattung).
    for (const k of this.kundenrechnungen) {
      if (k.status === 'offen' && k.brutto > 0 && k.faellig <= this.faelligBis) hinzu('kundenrechnung', k.brutto)
    }
    return gruppen
  }
}

/** Rechnet das Szenario durch und liefert den erwarteten Stand je Monatsende. */
export function simulieren(szenario: Szenario): Erwartung {
  const modell = new Modell(szenario)
  const monate: Record<number, Stand> = {}
  for (const s of szenario.schritte) {
    modell.schritt(s)
    if (s.art === 'monatsende') monate[s.monat] = modell.stand()
  }
  return { monate }
}

/** Für den Bericht: Netto-Versandkosten einer Shop-Bestellung (versandNetto). */
export const SHOP_VERSAND_NETTO = r2(SHOP_VERSAND_BRUTTO / (1 + STEUERSATZ / 100))
