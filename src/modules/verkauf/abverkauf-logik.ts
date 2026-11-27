/**
 * Abverkauf (Command Center für den Release-Tag, 0144) — reine Rechenlogik.
 *
 * Gerechnet wird in Tastaturen, nicht in Stück: ein Teil, von dem 99 je
 * Tastatur gebraucht werden (Switches), ist sonst mit keinem Gehäuse
 * vergleichbar. „Reicht für" = nutzbarer Bestand ÷ Stück je Tastatur.
 */

export type Fenster = '15' | '60' | '180' | 'heute'

export const FENSTER: { wert: Fenster; label: string }[] = [
  { wert: '15', label: '15 Min' },
  { wert: '60', label: '1 Std' },
  { wert: '180', label: '3 Std' },
  { wert: 'heute', label: 'heute' },
]

export function fensterAus(v: string | null | undefined): Fenster {
  return v === '15' || v === '60' || v === '180' ? v : 'heute'
}

/** Ein Teil, wie die Datenbank es liefert — Mengen in Stück. */
export interface TeilRoh {
  id: string
  name: string
  sku: string | null
  /** Stück je Tastatur (größter Wert über die Stücklisten). */
  je: number
  /** In so vielen verkaufbaren Produkten steckt das Teil. */
  artikel: number
  /** Frei im Lager (nicht reserviert). */
  frei: number
  /** Für den Shop nutzbar — nach Schwelle und Sperre. */
  nutzbar: number
  /** Von Hand „für den Shop gesperrt". */
  gesperrt: boolean
  /** Bestellt, aber nicht gedeckt (Stück). */
  fehlt: number
  /** Bestellt im gewählten Zeitfenster (Stück). */
  fenster: number
  /** Bestellt in den letzten 15 bzw. 60 Minuten (Stück). */
  m15: number
  m60: number
}

export type TeilZustand = 'ueberverkauft' | 'kritisch' | 'knapp' | 'ok' | 'leer' | 'gesperrt'

export interface TeilZeile {
  id: string
  name: string
  sku: string | null
  je: number
  artikel: number
  /** Reicht noch für so viele Tastaturen. */
  reicht: number
  /** Im Zeitfenster verkauft, in Tastaturen. */
  verkauft: number
  /** Tastaturen je Stunde — das Tempo der letzten 15 Minuten, sonst der letzten Stunde. */
  tempo: number
  /** Bei diesem Tempo leer in so vielen Minuten; null = kein Abverkauf oder schon leer. */
  minuten: number | null
  /** Rest-Anteil 0..1: reicht ÷ (reicht + verkauft) — der Balken, der schrumpft. */
  anteil: number
  /** Nicht gedeckt, in Tastaturen. */
  fehlt: number
  zustand: TeilZustand
  /** Platz im Ranking (1 = geht als Nächstes aus); null für leer/gesperrt. */
  rang: number | null
}

/** Unter so vielen Minuten gilt ein Teil als kritisch bzw. knapp. */
export const KRITISCH_MIN = 15
export const KNAPP_MIN = 60

const ORDNUNG: Record<TeilZustand, number> = { ueberverkauft: 0, kritisch: 1, knapp: 1, ok: 1, leer: 2, gesperrt: 3 }

export function teilZeile(t: TeilRoh): TeilZeile {
  const je = t.je > 0 ? t.je : 1
  const reicht = Math.max(0, Math.floor(t.nutzbar / je))
  const verkauft = Math.round(t.fenster / je)
  const tempo = t.m15 > 0 ? (t.m15 * 4) / je : t.m60 / je
  const fehlt = Math.ceil(Math.max(0, t.fehlt) / je)
  const minuten = tempo > 0 && reicht > 0 ? (reicht / tempo) * 60 : null
  const zustand: TeilZustand = t.gesperrt
    ? 'gesperrt'
    : fehlt > 0
      ? 'ueberverkauft'
      : reicht <= 0
        ? 'leer'
        : minuten !== null && minuten <= KRITISCH_MIN
          ? 'kritisch'
          : minuten !== null && minuten <= KNAPP_MIN
            ? 'knapp'
            : 'ok'
  return {
    id: t.id,
    name: t.name,
    sku: t.sku,
    je,
    artikel: t.artikel,
    reicht,
    verkauft,
    tempo: Math.round(tempo * 10) / 10,
    minuten: minuten === null ? null : Math.round(minuten),
    anteil: reicht + verkauft > 0 ? reicht / (reicht + verkauft) : 0,
    fehlt,
    zustand,
    rang: null,
  }
}

/**
 * Ranking: zuerst, was überverkauft ist (größte Lücke oben), dann was bei
 * laufendem Tempo am schnellsten leer ist, dann der Rest nach Reichweite.
 * Schon Leeres und von Hand Gesperrtes steht dahinter — ohne Platz.
 */
export function abverkaufRang(teile: TeilRoh[]): TeilZeile[] {
  const zeilen = teile.map(teilZeile)
  zeilen.sort((a, b) => {
    const o = ORDNUNG[a.zustand] - ORDNUNG[b.zustand]
    if (o !== 0) return o
    if (a.zustand === 'ueberverkauft') return b.fehlt - a.fehlt || a.name.localeCompare(b.name, 'de')
    if (ORDNUNG[a.zustand] === 1) {
      if (a.minuten !== null && b.minuten !== null) return a.minuten - b.minuten || a.reicht - b.reicht
      if (a.minuten !== null) return -1
      if (b.minuten !== null) return 1
      return a.reicht - b.reicht || b.verkauft - a.verkauft || a.name.localeCompare(b.name, 'de')
    }
    return b.verkauft - a.verkauft || a.name.localeCompare(b.name, 'de')
  })
  let rang = 0
  for (const z of zeilen) {
    if (z.zustand === 'leer' || z.zustand === 'gesperrt') continue
    rang += 1
    z.rang = rang
  }
  return zeilen
}

/** „12 Min", „2 Std 10 Min", „über 1 Tag". */
export function dauerText(minuten: number): string {
  if (minuten < 1) return 'unter 1 Min'
  if (minuten < 60) return `${Math.round(minuten)} Min`
  if (minuten >= 24 * 60) return 'über 1 Tag'
  const h = Math.floor(minuten / 60)
  const m = Math.round(minuten - h * 60)
  return m === 0 ? `${h} Std` : `${h} Std ${m} Min`
}

/** Anteile einer Liste für Balken: größter Wert = 1. */
export function anteile<T extends { menge: number }>(liste: T[]): (T & { anteil: number })[] {
  const max = Math.max(0, ...liste.map((x) => x.menge))
  return liste.map((x) => ({ ...x, anteil: max > 0 ? x.menge / max : 0 }))
}
