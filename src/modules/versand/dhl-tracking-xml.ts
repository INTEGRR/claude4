import type { TrackingResult, TrackingStatus } from './dhl'

/**
 * Parcel DE Tracking (Post & Paket Deutschland) — die Geschäftskunden-
 * Sendungsverfolgung. Sie spricht kein JSON: die Anfrage ist ein
 * XML-Dokument im Query-Parameter `xml`, die Antwort ein XML-Baum aus
 * `<data>`-Elementen mit Attributen. Bis zu 20 Sendungsnummern je Aufruf
 * (Semikolon-Liste), 1.000 Aufrufe und 10.000 Sendungen je Tag, 3 je Sekunde.
 *
 * Dieses Modul ist bewusst rein (kein Netz, keine Datenbank, keine
 * Abhängigkeit): Anfrage bauen, Antwort lesen, Status ableiten — alles
 * unter Test. Den HTTP-Aufruf macht dhl.ts. Entscheidungslog 2026-09-18.
 */

export const MAX_SENDUNGEN_JE_AUFRUF = 20

export interface ZtEreignis {
  timestamp: string | null
  status: string
  ort: string
  ice: string
  ric: string
  standardEventCode: string
}

export interface ZtSendung {
  pieceCode: string
  /** "0" = Daten vorhanden; alles andere = (noch) keine Sendungsdaten. */
  errorStatus: string
  status: string
  statusTimestamp: string | null
  deliveryEventFlag: boolean
  ice: string
  ric: string
  standardEventCode: string
  ereignisse: ZtEreignis[]
}

export interface ZtAntwort {
  /** Rückgabecode der Anfrage: 0 ok, 5 Anmeldung fehlgeschlagen, 100/200 keine Daten. */
  code: number
  sendungen: ZtSendung[]
}

function xmlAttribut(wert: string): string {
  return wert
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlEntitaeten(wert: string): string {
  return wert
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

/** Die Anfrage: Anmeldung (GKP-Benutzer) und Sendungsnummern stecken IM XML. */
export function ztAnfrageXml(p: {
  benutzer: string
  passwort: string
  sendungsnummern: string[]
  sprache?: 'de' | 'en'
}): string {
  if (p.sendungsnummern.length === 0 || p.sendungsnummern.length > MAX_SENDUNGEN_JE_AUFRUF) {
    throw new Error(`1 bis ${MAX_SENDUNGEN_JE_AUFRUF} Sendungsnummern je Aufruf`)
  }
  const codes = p.sendungsnummern.map((n) => n.trim()).join(';')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
    `<data appname="${xmlAttribut(p.benutzer)}" password="${xmlAttribut(p.passwort)}"` +
    ` request="d-get-piece-detail" language-code="${p.sprache ?? 'de'}"` +
    ` piece-code="${xmlAttribut(codes)}"/>`
  )
}

/** Attribute eines `<data …>`-Start-Tags als Objekt. */
function attribute(tag: string): Record<string, string> {
  const werte: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) werte[m[1]] = xmlEntitaeten(m[2])
  return werte
}

/** DHL schreibt "16.03.2012 15:29" (Ortszeit) — als ISO-artiger Text ohne Zone. */
export function ztZeitstempel(wert: string | undefined): string | null {
  const m = wert?.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`
}

/**
 * Antwort lesen. Die Struktur ist flach und bekannt — ein voller XML-Parser
 * wäre eine Abhängigkeit für drei Elementarten. Unbekannte Elemente werden
 * ignoriert, fehlende Attribute sind leere Zeichenketten.
 */
export function parseZtAntwort(xml: string): ZtAntwort {
  const wurzel = xml.match(/<data\b[^>]*\bname="piece-shipment-list"[^>]*>/)
  const code = Number(wurzel ? (attribute(wurzel[0]).code ?? '0') : '0')

  const sendungen: ZtSendung[] = []
  // Jede Sendung: <data name="pieceshipment" …>(Ereignisse)</data> oder selbstschließend.
  const sendungMuster =
    /<data\b[^>]*\bname="pieceshipment"[^>]*?(?:\/>|>([\s\S]*?)<\/data>)/g
  for (const m of xml.matchAll(sendungMuster)) {
    const kopf = attribute(m[0].slice(0, m[0].indexOf('>') + 1))
    const ereignisse: ZtEreignis[] = []
    for (const e of (m[1] ?? '').matchAll(/<data\b[^>]*\bname="pieceevent"[^>]*\/?>/g)) {
      const a = attribute(e[0])
      ereignisse.push({
        timestamp: ztZeitstempel(a['event-timestamp']),
        status: a['event-status'] ?? '',
        ort: a['event-location'] ?? '',
        ice: a.ice ?? '',
        ric: a.ric ?? '',
        standardEventCode: a['standard-event-code'] ?? '',
      })
    }
    sendungen.push({
      pieceCode: kopf['piece-code'] ?? '',
      errorStatus: kopf['error-status'] ?? '0',
      status: kopf.status ?? '',
      statusTimestamp: ztZeitstempel(kopf['status-timestamp']),
      deliveryEventFlag: kopf['delivery-event-flag'] === '1',
      ice: kopf.ice ?? '',
      ric: kopf.ric ?? '',
      standardEventCode: kopf['standard-event-code'] ?? '',
      ereignisse,
    })
  }
  return { code, sendungen }
}

/**
 * Ereigniscodes (ice), die „nicht zugestellt / geht zurück" bedeuten. Alles
 * Unbekannte gilt als unterwegs — lieber einmal zu lange „transit" als ein
 * fälschliches „failure", das die Rückmeldung an den Shop stoppt.
 */
const FEHLSCHLAG_CODES = new Set(['NTDLV', 'RTNSH', 'RTNDL', 'DLNTF', 'NTDLB'])

/** Status der Sendung in unsere vier Zustände übersetzen. */
export function trackingStatusAus(s: ZtSendung): TrackingResult | null {
  if (s.errorStatus !== '0') return null

  const letztes = s.ereignisse.at(-1)
  const codes = [s.ice, s.standardEventCode, letztes?.ice ?? '']
  let status: TrackingStatus
  if (s.deliveryEventFlag || codes.includes('DLVRD') || codes.includes('ZU')) {
    status = 'delivered'
  } else if (codes.some((c) => FEHLSCHLAG_CODES.has(c))) {
    status = 'failure'
  } else if (s.ereignisse.length === 0 || s.ice === 'ULFMV') {
    // ULFMV = Auftragsdaten elektronisch übermittelt, Paket noch nicht bei DHL.
    status = 'pre-transit'
  } else {
    status = 'transit'
  }

  return {
    status,
    description: letztes?.status || s.status,
    timestamp: letztes?.timestamp ?? s.statusTimestamp,
  }
}
