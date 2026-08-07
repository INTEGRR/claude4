/** Deutsche Formatierung für Zahlen, Mengen, Preise und Daten. */

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

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateFormat.format(new Date(value))
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return dateTimeFormat.format(new Date(value))
}

/** Beschriftungen der Statuswerte (die technischen Werte folgen Odoo). */
export const LABELS = {
  sale: {
    draft: 'Angebot',
    sent: 'Angebot gesendet',
    sale: 'Verkaufsauftrag',
    cancel: 'Abgebrochen',
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
    cancel: 'Abgebrochen',
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
  picking: {
    draft: 'Entwurf',
    waiting: 'Wartend',
    confirmed: 'Wartend auf Verfügbarkeit',
    assigned: 'Bereit',
    done: 'Erledigt',
    cancel: 'Abgebrochen',
  },
  mo: {
    draft: 'Entwurf',
    confirmed: 'Bestätigt',
    progress: 'In Bearbeitung',
    to_close: 'Abzuschließen',
    done: 'Erledigt',
    cancel: 'Abgebrochen',
  },
  repair: {
    new: 'Neu',
    confirmed: 'Bestätigt',
    under_repair: 'In Reparatur',
    repaired: 'Repariert',
    cancel: 'Abgebrochen',
  },
  shipment: {
    created: 'Label erstellt',
    manifested: 'Übergeben',
    transit: 'Unterwegs',
    delivered: 'Zugestellt',
    failure: 'Problem',
    cancelled: 'Storniert',
  },
} as const

/** Farbton für Status-Badges. */
export function tone(state: string): 'neutral' | 'info' | 'success' | 'warn' | 'danger' {
  switch (state) {
    case 'done':
    case 'sale':
    case 'delivered':
    case 'full':
    case 'invoiced':
    case 'repaired':
    case 'fully_billed':
    case 'paid':
      return 'success'
    case 'assigned':
    case 'confirmed':
    case 'progress':
    case 'transit':
    case 'purchase':
    case 'under_repair':
    case 'posted':
      return 'info'
    case 'cancel':
    case 'cancelled':
    case 'failure':
      return 'danger'
    case 'waiting':
    case 'started':
    case 'upselling':
    case 'to_invoice':
    case 'partial':
    case 'to_close':
    case 'created':
      return 'warn'
    default:
      return 'neutral'
  }
}
