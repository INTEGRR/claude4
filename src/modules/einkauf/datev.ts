/**
 * DATEV-Übergabe (0108) — NUR VORBEREITET (Betreiber 2026-10-01: „DATEV
 * erstmal nur vorbereiten"; der Versand folgt nach Klärung mit dem
 * Steuerberater: Upload-Adresse, Absender-Freigabe, ein Beleg je Mail,
 * Größengrenze).
 *
 * Hier stehen die reinen Bausteine: der Status einer gebuchten Rechnung für
 * die Übersicht (Sicht einkauf_datev_vorbereitung) und der Aufbau der
 * Beleg-Mail (ein Beleg je Mail, die Rechnungsdatei als Anhang) im Format,
 * das die Resend-Anbindung (integrationen/mail.ts) annimmt. Nichts davon ist
 * verdrahtet: es gibt keinen Job, keine Registry-Aktion und keinen Cron, der
 * sendet.
 */

export const DATEV_STATUS = {
  bereit: 'bereit',
  fehlt_beleg: 'fehlt Beleg',
  uebergeben: 'übergeben',
} as const
export type DatevStatus = keyof typeof DATEV_STATUS

/** Größte Datei je Beleg-Mail — Annahme bis zur Klärung mit dem Steuerberater. */
export const DATEV_MAX_BYTES = 20 * 1024 * 1024

export interface DatevBeleg {
  rechnungsnummer: string
  lieferant: string
  /** Rechnungsnummer des Lieferanten (vendor_bill_reference). */
  referenz?: string | null
  /** JJJJ-MM-TT */
  rechnungsdatum?: string | null
  dateiname: string
  /** Base64-kodierter Dateiinhalt (aus Drive). */
  inhaltBase64: string
  groesse?: number | null
}

/** Strukturgleich mit MailInput aus integrationen/mail.ts (dort 'server-only'). */
export interface DatevMail {
  to: string
  subject: string
  html: string
  attachments: { filename: string; content: string }[]
}

const html = (wert: unknown) =>
  String(wert ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const datumDe = (iso?: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split('-').reverse().join('.') : '')

/** Dateiname ohne Pfad- und Steuerzeichen, mit Endung. */
export function datevDateiname(name: string): string {
  const ohneSteuerzeichen = [...name].filter((c) => c.charCodeAt(0) >= 32).join('')
  const s = ohneSteuerzeichen.replace(/[\\/:*?"<>|]+/g, '-').trim()
  return s || 'Beleg.pdf'
}

/**
 * Baut die Beleg-Mail an die DATEV-Upload-Adresse: genau EIN Beleg je Mail
 * (DATEV Unternehmen online ordnet je Mail einen Beleg zu), Betreff mit
 * Lieferant und Rechnungsnummer, die Datei als Anhang. Wirft bei fehlender
 * Adresse, leerem Inhalt oder zu großer Datei — die Prüfung gehört vor den
 * (späteren) Versand, nicht in ihn.
 */
export function datevBelegMail(an: string, beleg: DatevBeleg): DatevMail {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(an.trim())) throw new Error('DATEV-Beleg-Adresse fehlt oder ist ungültig.')
  if (!beleg.inhaltBase64) throw new Error(`Rechnung ${beleg.rechnungsnummer}: Datei ist leer.`)
  const bytes = beleg.groesse ?? Math.floor((beleg.inhaltBase64.length * 3) / 4)
  if (bytes > DATEV_MAX_BYTES) {
    throw new Error(`Rechnung ${beleg.rechnungsnummer}: Datei ist größer als ${DATEV_MAX_BYTES / 1024 / 1024} MB.`)
  }
  const ref = beleg.referenz ? ` (${beleg.referenz})` : ''
  const datum = datumDe(beleg.rechnungsdatum)
  return {
    to: an.trim(),
    subject: `Eingangsrechnung ${beleg.lieferant} ${beleg.rechnungsnummer}${ref}`.slice(0, 200),
    html:
      `<p>Eingangsrechnung von <strong>${html(beleg.lieferant)}</strong>` +
      `${datum ? ` vom ${html(datum)}` : ''}, KRNL ${html(beleg.rechnungsnummer)}${html(ref)}.</p>` +
      '<p>Ein Beleg je Mail — automatisch aus KRNL.</p>',
    attachments: [{ filename: datevDateiname(beleg.dateiname), content: beleg.inhaltBase64 }],
  }
}
