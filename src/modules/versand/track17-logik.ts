/**
 * Zulauf-Sendungsverfolgung über 17TRACK (0112, Entscheidungslog 2026-10-15)
 * — der pure Teil: Carrier-Zuordnung, Statusabbildung, Lesen der
 * 17TRACK-Antwort, Webhook-Signatur, Abfragerhythmus. Ohne Datenbank,
 * testbar unter blankem Node (tests/track17.test.ts). Der HTTP-Client
 * steht in track17.ts, der Ablauf in zulauf-verfolgung.ts.
 */

/** Unser Status an der Sendung (sendungsverfolgung.status). */
export type VerfolgungStatus =
  | 'registriert'
  | 'nicht_verfolgbar'
  | 'nicht_gefunden'
  | 'angekuendigt'
  | 'unterwegs'
  | 'abholbereit'
  | 'in_zustellung'
  | 'zustellung_fehlgeschlagen'
  | 'zugestellt'
  | 'problem'
  | 'abgelaufen'

export const VERFOLGUNG_LABELS: Record<VerfolgungStatus, string> = {
  registriert: 'Angemeldet',
  nicht_verfolgbar: 'Nicht verfolgbar',
  nicht_gefunden: 'Noch nicht im Tracking',
  angekuendigt: 'Angekündigt',
  unterwegs: 'Unterwegs',
  abholbereit: 'Abholbereit',
  in_zustellung: 'In Zustellung',
  zustellung_fehlgeschlagen: 'Zustellung fehlgeschlagen',
  zugestellt: 'Zugestellt',
  problem: 'Problem',
  abgelaufen: 'Abgelaufen',
}

/** Die neun Hauptstatus von 17TRACK → unser Status. */
const STATUS_ABBILDUNG: Record<string, VerfolgungStatus> = {
  NotFound: 'nicht_gefunden',
  InfoReceived: 'angekuendigt',
  InTransit: 'unterwegs',
  Expired: 'abgelaufen',
  AvailableForPickup: 'abholbereit',
  OutForDelivery: 'in_zustellung',
  DeliveryFailure: 'zustellung_fehlgeschlagen',
  Delivered: 'zugestellt',
  Exception: 'problem',
}

export function statusAusTrack17(status: string | null | undefined): VerfolgungStatus {
  return (status && STATUS_ABBILDUNG[status]) || 'nicht_gefunden'
}

/** Endzustände: danach wird nicht mehr abgefragt. */
export function verfolgungAktiv(status: VerfolgungStatus): boolean {
  return status !== 'zugestellt' && status !== 'abgelaufen' && status !== 'nicht_verfolgbar'
}

/** Lesbare Unterstatus — nur die, die dem Lager etwas sagen. */
const SUB_STATUS_TEXTE: Record<string, string> = {
  InTransit_CustomsProcessing: 'in der Zollabfertigung',
  InTransit_CustomsReleased: 'vom Zoll freigegeben',
  InTransit_CustomsRequiringInformation: 'Zoll braucht Angaben',
  InTransit_PickedUp: 'abgeholt',
  InTransit_Departure: 'Abgang',
  InTransit_Arrival: 'Ankunft',
  DeliveryFailure_NoBody: 'niemand angetroffen',
  DeliveryFailure_InvalidAddress: 'Adresse ungültig',
  DeliveryFailure_Rejected: 'Annahme verweigert',
  Exception_Returning: 'auf dem Rückweg',
  Exception_Returned: 'zurückgeschickt',
  Exception_Damage: 'beschädigt',
  Exception_Lost: 'verloren',
  Exception_Delayed: 'verzögert',
  Exception_Destroyed: 'vernichtet',
  Exception_Cancel: 'storniert',
}

export function subStatusText(subStatus: string | null | undefined): string | null {
  return (subStatus && SUB_STATUS_TEXTE[subStatus]) || null
}

/**
 * 17TRACK-Carrier-Codes (apicarrier.all.json, Feld `key`) für die Namen,
 * die im Einkauf vorkommen. Trifft nichts, erkennt 17TRACK den Carrier
 * selbst (auto_detection) — das klappt bei Paketdiensten gut, bei
 * Spediteuren selten.
 */
const CARRIER_CODES: readonly [string, number][] = [
  ['dhl express', 100001],
  ['dhl freight', 100245],
  ['dhl global forwarding', 100766],
  ['dhl ecommerce', 100765],
  ['dhl parcel', 7041],
  ['dhl paket', 7041],
  ['dhl', 7041],
  ['deutsche post', 7044],
  ['dpd', 100007],
  ['gls', 100005],
  ['ups', 100002],
  ['fedex', 100003],
  ['tnt', 100004],
  ['hermes', 100031],
  ['china post', 3011],
  ['sf express', 100012],
  ['sf-express', 100012],
  ['usps', 21051],
  ['royal mail', 11031],
  ['postnl', 14041],
  ['ems', 100685],
  ['asendia', 100029],
  ['maersk', 100768],
  ['kuehne', 100164],
  ['kühne', 100164],
  ['k+n', 100164],
  ['db schenker', 100206],
  ['schenker', 100206],
  ['dachser', 100342],
]

/** Carrier-Text („DHL Express", „K+N", „dhl") → 17TRACK-Code, sonst null. */
export function carrierCode(text: string | null | undefined): number | null {
  const t = (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!t) return null
  for (const [name, code] of CARRIER_CODES) {
    if (t === name || t.startsWith(`${name} `) || t.startsWith(`${name}-`) || t.startsWith(`${name}(`)) return code
  }
  // Markenname irgendwo im Text (z. B. „Kurier: DHL Express").
  for (const [name, code] of CARRIER_CODES) {
    if (t.includes(name)) return code
  }
  return null
}

/** Ein Ereignis, wie es an der Sendung steht (letztes_ereignis, ereignisse[]). */
export interface Ereignis {
  zeit: string | null
  text: string
  ort: string | null
}

/** Was wir aus einer 17TRACK-Antwort (gettrackinfo/Webhook) behalten. */
export interface TrackStand {
  status: VerfolgungStatus
  statusQuelle: string | null
  subStatus: string | null
  carrierCode: number | null
  carrierName: string | null
  letztesEreignis: Ereignis | null
  ereignisse: Ereignis[]
}

/** Ausschnitt der 17TRACK-v2.2-Struktur, den wir lesen. */
export interface Track17Ereignis {
  time_iso?: string | null
  time_utc?: string | null
  time_raw?: { date?: string | null; time?: string | null; timezone?: string | null } | null
  description?: string | null
  description_translation?: { description?: string | null } | null
  location?: string | null
  sub_status?: string | null
}

export interface Track17Info {
  latest_status?: { status?: string | null; sub_status?: string | null } | null
  latest_event?: Track17Ereignis | null
  tracking?: {
    providers?: {
      provider?: { key?: number | null; name?: string | null } | null
      events?: Track17Ereignis[] | null
    }[] | null
  } | null
}

export interface Track17Eintrag {
  number: string
  carrier?: number | null
  track_info?: Track17Info | null
}

export const EREIGNISSE_MAX = 50

function ereignisLesen(e: Track17Ereignis): Ereignis {
  const roh = e.time_raw
  const zeit = e.time_iso || e.time_utc || (roh?.date ? `${roh.date}${roh.time ? `T${roh.time}` : ''}` : null)
  const text = (e.description_translation?.description || e.description || '').trim()
  return { zeit: zeit || null, text: text || '(ohne Text)', ort: e.location?.trim() || null }
}

/** Liest einen gettrackinfo-/Webhook-Eintrag in unseren Stand. */
export function trackStandLesen(eintrag: Track17Eintrag): TrackStand {
  const info = eintrag.track_info ?? {}
  const statusQuelle = info.latest_status?.status ?? null
  const provider = (info.tracking?.providers ?? []).find((p) => (p.events ?? []).length > 0) ?? info.tracking?.providers?.[0]
  const ereignisse = (provider?.events ?? []).map(ereignisLesen)
  // 17TRACK liefert Ereignisse jüngstes zuerst — so bleiben sie auch gespeichert.
  const letztes = info.latest_event ? ereignisLesen(info.latest_event) : (ereignisse[0] ?? null)
  return {
    status: statusAusTrack17(statusQuelle),
    statusQuelle,
    subStatus: info.latest_status?.sub_status ?? null,
    carrierCode: eintrag.carrier ?? provider?.provider?.key ?? null,
    carrierName: provider?.provider?.name?.trim() || null,
    letztesEreignis: letztes,
    ereignisse: ereignisse.slice(0, EREIGNISSE_MAX),
  }
}

/** „Unterwegs — Leipzig, 14.10. 22:10: Sendung im Paketzentrum" für Protokoll und Chat. */
export function standText(stand: Pick<TrackStand, 'status' | 'subStatus' | 'letztesEreignis'>): string {
  const zusatz = subStatusText(stand.subStatus)
  let s = VERFOLGUNG_LABELS[stand.status] + (zusatz ? ` (${zusatz})` : '')
  const e = stand.letztesEreignis
  if (e) {
    const wo = [e.ort, e.zeit ? zeitKurz(e.zeit) : null].filter(Boolean).join(', ')
    s += ` — ${wo ? `${wo}: ` : ''}${e.text}`
  }
  return s
}

/** 2026-10-14T22:10:00+02:00 → „14.10. 22:10"; ohne Uhrzeit nur das Datum. */
export function zeitKurz(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso)
  if (!m) return iso
  return `${m[3]}.${m[2]}.${m[4] ? ` ${m[4]}:${m[5]}` : ''}`
}

/**
 * Webhook-Signatur: 17TRACK hängt an den Rohtext „/" und den Security Key
 * (= API-Key) und bildet SHA-256 (hex) — Header `sign`.
 */
export function webhookSignatur(roh: string, schluessel: string, sha256Hex: (s: string) => string): string {
  return sha256Hex(`${roh}/${schluessel}`)
}

/** Lesbare Fehlermeldungen der Anmeldung (17TRACK-Fehlercodes). */
export function registrierungsFehlerText(code: number | null | undefined, message?: string | null): string {
  switch (code) {
    case -18010012:
      return 'Sendungsnummer hat kein gültiges Format'
    case -18019903:
      return 'Carrier nicht erkennbar — Carrier an der Bestellung angeben'
    case -18019907:
      return 'Tageslimit bei 17TRACK erreicht — Anmeldung wird wiederholt'
    case -18019908:
      return '17TRACK-Kontingent erschöpft — Kontingent aufstocken'
    default:
      return message?.trim() || `17TRACK lehnt die Anmeldung ab (${code ?? 'ohne Code'})`
  }
}

/** Bereits angemeldet zählt als Erfolg — die Nummer läuft dann längst. */
export const BEREITS_ANGEMELDET = -18019901

/** Fehler, bei denen eine Wiederholung sinnvoll ist (Limit, Kontingent). */
export function registrierungWiederholen(code: number | null | undefined): boolean {
  return code === -18019907 || code === -18019908
}

/** Abfragerhythmus des Cron: aktive Sendungen, je höchstens alle sechs Stunden (Webhook liefert dazwischen). */
export const ABRUF_ABSTAND_STUNDEN = 6
/** Frische Sendungen (noch ohne Stand) fragt der stündliche Cron jedes Mal — nicht erst nach sechs Stunden. */
export const ABRUF_ABSTAND_FRISCH_MINUTEN = 50
/**
 * Nachfassen nach der Anmeldung: 17TRACK liefert direkt nach `register`
 * meist „No tracking information at this time" (-18019909) und sammelt
 * erst — KRNL fragt deshalb nach 5, 15 und 45 Minuten nach, danach trägt
 * der stündliche Abruf.
 */
export const NACHFASSEN_MINUTEN = [5, 15, 45] as const
/** 17TRACK: „noch keine Daten" — kein Fehler, nur zu früh. */
export const NOCH_KEINE_DATEN = -18019909
/** 17TRACK nimmt je Aufruf bis zu 40 Nummern. */
export const STAPEL_MAX = 40
