/** Deutsche Formatierung für Zahlen, Mengen, Preise und Daten. */
import { VERFOLGUNG_LABELS } from '../versand/track17-logik.ts'

const numberFormat = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const moneyFormat = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
})

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function qty(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return numberFormat.format(Number(value))
}

export function money(value: number | string | null | undefined, currency = 'EUR'): string {
  if (value === null || value === undefined) return '—'
  if (currency !== 'EUR') {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(Number(value))
  }
  return moneyFormat.format(Number(value))
}

/**
 * Stückpreis im Einkauf (0092): bis 6 Nachkommastellen, mindestens 2 —
 * Kleinteile kosten 0,0034 USD, ein Gehäuse 20,00 €.
 */
export function stueckpreis(value: number | string | null | undefined, currency = 'EUR'): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(value))
}

/**
 * Prozent mit deutschem Komma. Fehlte bisher — deshalb stand `12.3 %` (aus
 * toFixed(), englischer Punkt) neben `12,5 %` (aus qty()) im selben System.
 * Erwartet den ANTEIL (0.123), nicht den Prozentwert.
 */
export function pct(anteil: number | string | null | undefined, stellen = 1): string {
  if (anteil === null || anteil === undefined) return '—'
  const wert = Number(anteil)
  if (!Number.isFinite(wert)) return '—'
  return `${new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  }).format(wert * 100)} %`
}

/**
 * Datum für <input type="date"> (YYYY-MM-DD). Klingt trivial, ist es nicht:
 * timestamptz kommt als Date-Objekt aus dem Treiber, `date` je nach Spaltentyp
 * schon als String — beides muss hier durch. Vorher stand
 * `new Date(x).toISOString().slice(0, 10)` 17× im Repo verteilt, zweimal sogar
 * als privater lokaler Helfer.
 *
 * Bewusst OHNE Zeitzonen-Verschiebung: toISOString() rechnet nach UTC, was
 * bei einem reinen Datum in Mitteleuropa den Vortag liefern kann. Deshalb
 * werden die lokalen Feldwerte genommen.
 */
export function isoDatum(wert: string | Date | null | undefined): string {
  if (wert === null || wert === undefined) return ''
  if (typeof wert === 'string') return wert.slice(0, 10)
  const jahr = wert.getFullYear()
  const monat = String(wert.getMonth() + 1).padStart(2, '0')
  const tag = String(wert.getDate()).padStart(2, '0')
  return `${jahr}-${monat}-${tag}`
}

/** Minuten als Stundenangabe, wie sie auf einem Stundenzettel steht: "7:45 h". */
export function hours(minutes: number | string | null | undefined): string {
  const total = Math.round(Number(minutes ?? 0))
  const sign = total < 0 ? '-' : ''
  const abs = Math.abs(total)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')} h`
}

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateFormat.format(new Date(value))
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateTimeFormat.format(new Date(value))
}

/**
 * Die Zustandstabelle (F1, Entscheidungslog 2026-10-17): Beschriftung jedes
 * Statuswerts je Belegart — die einzige Quelle. Lokale Status-Maps in Seiten
 * sind verboten (Wächter tests/zustandstabelle.test.ts); jeder Wert der
 * Status-Enums der Datenbank hat hier ein Label. Die technischen Werte
 * folgen Odoo. `cancel` heißt bei Belegen einheitlich „Storniert".
 */
export const LABELS = {
  sale: {
    draft: 'Angebot',
    sent: 'Angebot gesendet',
    sale: 'Verkaufsauftrag',
    cancel: 'Storniert',
  },
  delivery: {
    pending: 'Nicht geliefert',
    started: 'Lieferung begonnen',
    partial: 'Teilweise geliefert',
    full: 'Vollständig geliefert',
  },
  invoice: {
    no: 'Nichts abzurechnen',
    to_invoice: 'Abzurechnen',
    invoiced: 'Vollständig abgerechnet',
    upselling: 'Mehr geliefert als bestellt',
  },
  purchase: {
    draft: 'Angebotsanfrage',
    sent: 'Anfrage gesendet',
    purchase: 'Bestellung',
    done: 'Gesperrt',
    cancel: 'Storniert',
  },
  billing: {
    nothing: 'Nichts abzurechnen',
    waiting: 'Rechnung erwartet',
    fully_billed: 'Vollständig abgerechnet',
  },
  bill: {
    draft: 'Entwurf',
    posted: 'Gebucht',
    paid: 'Bezahlt',
    cancel: 'Storniert',
  },
  kundenrechnung: {
    offen: 'Offen',
    bezahlt: 'Bezahlt',
    storniert: 'Storniert',
  },
  retoure: {
    angefragt: 'Angefragt',
    genehmigt: 'Genehmigt',
    abgelehnt: 'Abgelehnt',
    eingegangen: 'Eingegangen',
    geprueft: 'Geprüft — wartet auf Erstattung',
    abgeschlossen: 'Abgeschlossen',
    storniert: 'Storniert',
  },
  picking: {
    draft: 'Entwurf',
    waiting: 'Wartend',
    confirmed: 'Wartend auf Verfügbarkeit',
    assigned: 'Bereit',
    done: 'Erledigt',
    cancel: 'Storniert',
  },
  mo: {
    draft: 'Entwurf',
    confirmed: 'Bestätigt',
    progress: 'In Bearbeitung',
    to_close: 'Abzuschließen',
    done: 'Erledigt',
    cancel: 'Storniert',
  },
  repair: {
    new: 'Neu',
    awaiting_device: 'Wartet auf Gerät',
    received: 'Gerät eingegangen',
    confirmed: 'Bestätigt',
    under_repair: 'In Reparatur',
    repaired: 'Repariert',
    shipped: 'Versendet',
    cancel: 'Storniert',
  },
  absence: {
    requested: 'Beantragt',
    approved: 'Genehmigt',
    rejected: 'Abgelehnt',
    cancel: 'Zurückgezogen',
  },
  shipment: {
    created: 'Label erstellt',
    manifested: 'Übergeben',
    transit: 'Unterwegs',
    delivered: 'Zugestellt',
    failure: 'Problem',
    cancelled: 'Storniert',
  },
  // Zulauf-Sendungsverfolgung über 17TRACK (0112).
  sendungsverfolgung: VERFOLGUNG_LABELS,
  mail_thread: {
    offen: 'Offen',
    erledigt: 'Erledigt',
    ignoriert: 'Ignoriert',
  },
  ki_vorschlag: {
    offen: 'Offen',
    angenommen: 'Angenommen',
    verworfen: 'Verworfen',
    fehler: 'Fehler',
  },
  mail_entwurf: {
    entwurf: 'Entwurf',
    freigegeben: 'Wird gesendet',
    gesendet: 'Gesendet',
    verworfen: 'Verworfen',
  },
  einkaufsprojekt: {
    bedarf: 'Bedarf',
    angefragt: 'Angefragt',
    entschieden: 'Entschieden',
    bestellt: 'Bestellt',
    abgeschlossen: 'Abgeschlossen',
    abgebrochen: 'Abgebrochen',
  },
  lieferantenanfrage: {
    entwurf: 'Entwurf',
    angefragt: 'Angefragt',
    angebot: 'Angebot da',
    abgesagt: 'Abgesagt',
  },
  bemusterung: {
    offen: 'Offen',
    freigegeben: 'Freigegeben',
    abgelehnt: 'Abgelehnt',
    nachbessern: 'Nachbessern',
  },
  werkzeug: {
    in_auftrag: 'In Auftrag',
    aktiv: 'Aktiv',
    gesperrt: 'Gesperrt',
    ausgemustert: 'Ausgemustert',
  },
  eingangs_sendung: {
    geplant: 'Geplant',
    verschifft: 'Verschifft',
    verzollt: 'Verzollt',
    angekommen: 'Angekommen',
    abgerechnet: 'Abgerechnet',
    storniert: 'Storniert',
  },
  // DATEV-Vorbereitung (0108): was an DATEV ginge — nur Übersicht.
  datev: {
    bereit: 'Bereit',
    fehlt_beleg: 'Beleg fehlt',
    uebergeben: 'Übergeben',
  },
  // Lage aus Status und Laufzeit (einkauf/lieferantenvertraege.ts vertragsLage).
  lieferantenvertrag: {
    aktiv: 'Aktiv',
    faellig: 'Frist läuft',
    abgelaufen: 'Abgelaufen',
    gekuendigt: 'Gekündigt',
    beendet: 'Beendet',
  },
  move: {
    draft: 'Entwurf',
    waiting: 'Wartend',
    confirmed: 'Wartend auf Verfügbarkeit',
    assigned: 'Reserviert',
    done: 'Erledigt',
    cancel: 'Storniert',
  },
  mo_operation: {
    pending: 'Offen',
    progress: 'Läuft',
    done: 'Erledigt',
    cancel: 'Storniert',
  },
  shift: {
    draft: 'Entwurf',
    published: 'Veröffentlicht',
    cancel: 'Storniert',
  },
  aufgabe: {
    offen: 'Offen',
    erledigt: 'Erledigt',
    verworfen: 'Verworfen',
  },
  ticket: {
    offen: 'Offen',
    in_arbeit: 'In Arbeit',
    behoben: 'Behoben',
    verworfen: 'Verworfen',
  },
  ticket_schwere: {
    kritisch: 'Kritisch',
    stoerend: 'Störend',
    kosmetisch: 'Kosmetisch',
  },
  // Outbox (integration_jobs). „skipped" gibt es nur in der Anzeige: ein Job,
  // der mit „Übersprungen…" als done endete (Schreibschutz, fehlende Konfiguration).
  job: {
    pending: 'Wartet',
    running: 'Läuft',
    done: 'Erledigt',
    failed: 'Fehlgeschlagen',
    skipped: 'Übersprungen',
  },
  webhook: {
    pending: 'Wartet',
    running: 'Läuft',
    done: 'Erledigt',
    failed: 'Fehlgeschlagen',
    skipped: 'Übersprungen',
  },
  // Assistenten-Läufe (prozess_instanzen.status, text).
  prozess_instanz: {
    laufend: 'Läuft',
    fertig: 'Fertig',
    abgebrochen: 'Abgebrochen',
  },
  // Benachrichtigungen (Telegram-Outbox, benachrichtigungen.status, text).
  benachrichtigung: {
    offen: 'Offen',
    gesendet: 'Gesendet',
    fehlgeschlagen: 'Fehlgeschlagen',
    uebersprungen: 'Übersprungen',
  },
  // Prüfung einer Retourenposition (retoure_positionen.pruefung, text).
  retoure_pruefung: {
    verkaufsfaehig: 'Verkaufsfähig → Lager',
    bware: 'B-Ware',
    defekt: 'Defekt → B-Ware',
  },
  // KI-Lesbarkeit eines Dokuments (dokumente.text_status, text).
  dokument_text: {
    gelesen: 'von der KI gelesen',
    nicht_lesbar: 'für die KI nicht lesbar',
    fehler: 'KI-Lesen gescheitert',
  },
  // Abwesenheitsart (absence_kind) und Beschäftigungsart (employment_type).
  absence_art: {
    vacation: 'Urlaub',
    sick: 'Krank',
    training: 'Schulung',
    unpaid: 'Unbezahlt',
    other: 'Sonstiges',
  },
  beschaeftigung: {
    full_time: 'Vollzeit',
    part_time: 'Teilzeit',
    mini_job: 'Minijob',
    temp: 'Aushilfe',
    apprentice: 'Auszubildende(r)',
  },
} as const

export type LabelArt = keyof typeof LABELS

/** Beschriftung eines Statuswerts; unbekannte Werte erscheinen roh (der Wächter verhindert das bei Enums). */
export function label(art: LabelArt, wert: string): string {
  return (LABELS[art] as Record<string, string>)[wert] ?? wert
}

type Ton = 'neutral' | 'info' | 'success' | 'warn' | 'danger'

/**
 * Farbton je Belegart, wo der Code allein nicht reicht: „genehmigt" ist bei
 * einer Retoure ein Zwischenschritt (info), bei einer Abwesenheit das Ziel.
 */
const TON_JE_ART: Partial<Record<LabelArt, Record<string, Ton>>> = {
  retoure: { genehmigt: 'info', eingegangen: 'info', geprueft: 'warn' },
  absence: { cancel: 'neutral' },
  aufgabe: { offen: 'warn', verworfen: 'neutral' },
  ticket: { offen: 'warn', in_arbeit: 'info', behoben: 'success', verworfen: 'neutral' },
  ticket_schwere: { kritisch: 'danger', stoerend: 'warn', kosmetisch: 'neutral' },
  job: { pending: 'warn', running: 'info', failed: 'danger', skipped: 'neutral' },
  webhook: { pending: 'warn', running: 'info', failed: 'danger', skipped: 'neutral' },
  prozess_instanz: { laufend: 'info', fertig: 'success' },
  benachrichtigung: { offen: 'warn', fehlgeschlagen: 'danger', uebersprungen: 'neutral' },
  retoure_pruefung: { verkaufsfaehig: 'success', bware: 'warn', defekt: 'warn' },
  move: { assigned: 'info' },
  mo_operation: { pending: 'neutral' },
  shift: { published: 'success' },
}

/** Farbton für Status-Badges — mit Belegart, wo derselbe Code je Art anders wiegt. */
export function tone(state: string, art?: LabelArt): Ton {
  const jeArt = art ? TON_JE_ART[art]?.[state] : undefined
  if (jeArt) return jeArt
  switch (state) {
    case 'done':
    case 'sale':
    case 'delivered':
    case 'full':
    case 'invoiced':
    case 'repaired':
    case 'shipped':
    case 'fully_billed':
    case 'paid':
    case 'approved':
    case 'erledigt':
    case 'gesendet':
    case 'abgeschlossen':
    case 'angebot':
    case 'aktiv':
    case 'abgerechnet':
    case 'bezahlt':
    case 'uebergeben':
    case 'angenommen':
    case 'zugestellt':
      return 'success'
    case 'assigned':
    case 'confirmed':
    case 'progress':
    case 'transit':
    case 'purchase':
    case 'under_repair':
    case 'received':
    case 'posted':
    case 'offen':
    case 'freigegeben':
    case 'angefragt':
    case 'entschieden':
    case 'bestellt':
    case 'verschifft':
    case 'verzollt':
    case 'angekommen':
    case 'bereit':
    case 'unterwegs':
    case 'in_zustellung':
    case 'angekuendigt':
    case 'abholbereit':
      return 'info'
    case 'cancel':
    case 'cancelled':
    case 'failure':
    case 'rejected':
    case 'abgebrochen':
    case 'abgelehnt':
    case 'gesperrt':
    case 'abgelaufen':
    case 'storniert':
    case 'fehler':
    case 'problem':
    case 'zustellung_fehlgeschlagen':
    case 'nicht_verfolgbar':
      return 'danger'
    case 'waiting':
    case 'started':
    case 'upselling':
    case 'to_invoice':
    case 'partial':
    case 'to_close':
    case 'created':
    case 'requested':
    case 'awaiting_device':
    case 'bedarf':
    case 'nachbessern':
    case 'in_auftrag':
    case 'faellig':
    case 'gekuendigt':
    case 'geplant':
    case 'fehlt_beleg':
    case 'registriert':
    case 'nicht_gefunden':
      return 'warn'
    default:
      return 'neutral'
  }
}
