import 'server-only'
import { productForCountry, toAlpha3, trackingUrl } from './dhl-codes'
import {
  MAX_SENDUNGEN_JE_AUFRUF,
  parseZtAntwort,
  trackingStatusAus,
  ztAnfrageXml,
} from './dhl-tracking-xml'

export { productForCountry, toAlpha3, trackingUrl }

/**
 * DHL Parcel DE Shipping API v2 (Post & Parcel Germany).
 *
 * Auth über OAuth2 ROPC: GKP-Systembenutzer + API-Key/Secret der App aus dem
 * DHL Developer Portal. Basic Auth ist bei DHL deprecated und wird hier nicht
 * mehr unterstützt.
 */

export interface DhlConfig {
  base: string
  apiKey: string
  apiSecret: string
  user: string
  password: string
  billingNumber: string
  returnReceiverId: string
}

export function dhlConfig(): DhlConfig {
  return {
    base: process.env.DHL_API_BASE ?? 'https://api-sandbox.dhl.com',
    apiKey: process.env.DHL_API_KEY ?? '',
    apiSecret: process.env.DHL_API_SECRET ?? '',
    user: process.env.DHL_GKP_USER ?? '',
    password: process.env.DHL_GKP_PASSWORD ?? '',
    billingNumber: process.env.DHL_BILLING_NUMBER ?? '',
    returnReceiverId: process.env.DHL_RETURN_RECEIVER_ID ?? 'deu',
  }
}

export function dhlConfigured(): boolean {
  // Im Fake-Betrieb (Prozesstests, Staging) gilt DHL als konfiguriert —
  // Labelerstellung und Tracking laufen dann deterministisch (dhl-fake.ts).
  if (process.env.DHL_FAKE === '1') return true
  const c = dhlConfig()
  return Boolean(c.apiKey && c.user && c.password && c.billingNumber)
}

/**
 * Welche Pflicht-Variablen fehlen — nur die NAMEN, nie Werte. „Nicht
 * konfiguriert" ohne Grund kostet den Betreiber sonst eine Rätselrunde
 * je Tippfehler im Variablennamen.
 */
export function dhlFehlendeVariablen(): string[] {
  if (process.env.DHL_FAKE === '1') return []
  return (['DHL_API_KEY', 'DHL_GKP_USER', 'DHL_GKP_PASSWORD', 'DHL_BILLING_NUMBER'] as const)
    .filter((name) => !process.env[name])
}

export class DhlError extends Error {
  // Keine Parameter-Properties: die Prozesstests laden dieses Modul unter
  // node --experimental-strip-types, und der kann nur löschbare Syntax.
  readonly status?: number
  readonly detail?: unknown

  constructor(message: string, status?: number, detail?: unknown) {
    super(message)
    this.name = 'DhlError'
    this.status = status
    this.detail = detail
  }
}

/** Transaktionslog-Anbindung (fire-and-forget, nie mit Zugangsdaten). */
async function protokoll(t: {
  kind: string
  reference?: string | null
  request?: unknown
  response?: unknown
  ok: boolean
  statusCode?: number | null
  error?: string | null
  durationMs?: number
}) {
  const { logTransaction } = await import('../integrationen/transaktionen')
  await logTransaction({ system: 'dhl', ...t })
}

/**
 * Sonde des Dienste-Wächters: Anmeldung am Token-Endpunkt — scheitert ohne
 * Zugangsdaten, mit abgelaufenem GKP-Passwort oder wenn DHL nicht antwortet.
 * Im Fake-Betrieb erreichbar.
 */
export async function dhlErreichbar(): Promise<void> {
  if (process.env.DHL_FAKE === '1') return
  await accessToken()
}

// --- Token-Verwaltung ------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | undefined

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value

  const c = dhlConfig()
  const start = Date.now()
  const res = await fetch(`${c.base}/parcel/de/account/auth/ropc/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: c.user,
      password: c.password,
      client_id: c.apiKey,
      client_secret: c.apiSecret,
    }),
  })

  if (!res.ok) {
    await protokoll({
      kind: 'oauth_token', ok: false, statusCode: res.status,
      error: `Anmeldung fehlgeschlagen (${res.status})`, durationMs: Date.now() - start,
    })
    throw new DhlError(
      `DHL-Anmeldung fehlgeschlagen (${res.status}). Bitte Zugangsdaten prüfen — ` +
        `das Passwort des GKP-Systembenutzers läuft nach 365 Tagen ab.`,
      res.status,
    )
  }
  await protokoll({ kind: 'oauth_token', ok: true, statusCode: res.status, durationMs: Date.now() - start })

  const body = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  }
  return cachedToken.value
}

async function dhlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const c = dhlConfig()
  const token = await accessToken()
  // NUR der Bearer-Token, ohne dhl-api-key-Header: DHL lehnt die
  // Kombination aus beidem ab („Use EITHER Bearer Token or (Apikey and
  // Basic Auth)", 401 im Sandbox-Test 2026-08-27).
  return fetch(`${c.base}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })
}

// --- Sendungen -------------------------------------------------------------

export interface DhlAddress {
  name: string
  street: string
  houseNumber: string
  addition?: string
  zip: string
  city: string
  /** ISO 3166-1 alpha-3, z. B. DEU - seit v2.1.13 Pflicht. */
  country: string
  email?: string
  phone?: string
}

export interface ZollPosition {
  itemDescription: string
  countryOfOrigin?: string
  hsCode?: string
  packagedQuantity: number
  itemValue: { currency: string; value: number }
  itemWeight: { uom: string; value: number }
}

export interface ZollDaten {
  invoiceNo?: string
  exportType: 'COMMERCIAL_GOODS' | 'COMMERCIAL_SAMPLE' | 'DOCUMENT' | 'RETURN_OF_GOODS' | 'PRESENT' | 'OTHER'
  postalCharges: { currency: string; value: number }
  items: ZollPosition[]
}

export interface CreateShipmentInput {
  product: string
  billingNumber?: string
  reference: string
  weightG: number
  shipper: DhlAddress
  consignee: DhlAddress
  printFormat?: string
  /** Transportversicherung (Warenwert in EUR). */
  insuredValue?: number | null
  /** Zolldaten (CN23) — Pflicht bei Drittland-Versand (V53WPAK/V66WPI). */
  customs?: ZollDaten | null
}

export interface CreatedShipment {
  shipmentNumber: string
  trackingUrl: string
  labelBase64?: string
  labelUrl?: string
  warnings: string[]
}

/**
 * Leere Felder WEGLASSEN statt mitschicken: DHL validiert vorhandene
 * Felder auch dann, wenn sie leer sind („email must be between 3 and 80
 * characters") — ein fehlendes optionales Feld ist dagegen erlaubt.
 */
function ohneLeere<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, wert]) => wert !== '' && wert !== null && wert !== undefined),
  ) as Partial<T>
}

export async function createShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeCreateShipment(input)
  }
  const c = dhlConfig()
  const printFormat = input.printFormat ?? '910-300-700'

  // Pflichtfelder des Absenders VOR dem Aufruf prüfen — die kommen aus den
  // Firmendaten, und ein klarer Hinweis erspart die DHL-Fehlerrunde.
  const fehltBeimAbsender = (
    [
      ['Name', input.shipper.name],
      ['Straße', input.shipper.street],
      ['PLZ', input.shipper.zip],
      ['Ort', input.shipper.city],
    ] as const
  )
    .filter(([, wert]) => !wert)
    .map(([feld]) => feld)
  if (fehltBeimAbsender.length > 0) {
    throw new DhlError(
      `Absenderdaten unvollständig (${fehltBeimAbsender.join(', ')}) — bitte unter ` +
        'Einstellungen → Firma pflegen.',
    )
  }

  const body = {
    profile: 'STANDARD_GRUPPENPROFIL',
    shipments: [
      {
        product: input.product,
        billingNumber: input.billingNumber ?? c.billingNumber,
        // DHL verlangt 8–35 Zeichen — kurze Belegnummern (S01873) auffüllen.
        refNo: input.reference.padEnd(8, '-'),
        shipper: ohneLeere({
          name1: input.shipper.name,
          addressStreet: input.shipper.street,
          addressHouse: input.shipper.houseNumber,
          postalCode: input.shipper.zip,
          city: input.shipper.city,
          country: input.shipper.country,
          email: input.shipper.email,
          phone: input.shipper.phone,
        }),
        consignee: ohneLeere({
          name1: input.consignee.name,
          addressStreet: input.consignee.street,
          addressHouse: input.consignee.houseNumber,
          additionalAddressInformation1: input.consignee.addition,
          postalCode: input.consignee.zip,
          city: input.consignee.city,
          country: input.consignee.country,
          email: input.consignee.email,
          phone: input.consignee.phone,
        }),
        details: { weight: { uom: 'g', value: input.weightG } },
        ...(input.insuredValue
          ? { services: { additionalInsurance: { currency: 'EUR', value: input.insuredValue } } }
          : {}),
        ...(input.customs ? { customs: input.customs } : {}),
      },
    ],
  }

  const start = Date.now()
  const res = await dhlFetch(
    `/parcel/de/shipping/v2/orders?includeDocs=include&printFormat=${encodeURIComponent(printFormat)}&docFormat=PDF`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

  const json = (await res.json().catch(() => null)) as {
    // Fehler kommen je nach Schicht verschachtelt (status.detail) ODER
    // flach (title/detail direkt am Wurzelobjekt, z. B. Gateway-401er).
    status?: { title?: string; detail?: string }
    title?: string
    detail?: string
    items?: {
      shipmentNo?: string
      sstatus?: { title?: string; detail?: string }
      validationMessages?: { validationMessage?: string; property?: string }[]
      label?: { b64?: string; url?: string }
    }[]
  } | null

  // Fürs Protokoll ohne das Label-PDF (Base64 wäre nur Ballast).
  const responseOhneLabel = json
    ? { ...json, items: json.items?.map((i) => ({ ...i, label: i.label?.url ? { url: i.label.url } : undefined })) }
    : null
  const logCreate = (ok: boolean, error?: string) =>
    protokoll({
      kind: 'label_create', reference: input.reference, request: body,
      response: responseOhneLabel, ok, statusCode: res.status, error, durationMs: Date.now() - start,
    })

  if (!res.ok || !json) {
    // Die brauchbaren Gründe stehen in den validationMessages der einzelnen
    // Sendung — die Kopfzeile („0 of 1 shipment successfully printed") sagt
    // nichts. Alles einsammeln, Feldname voran, sonst auf die Kopfzeile
    // zurückfallen.
    const gruende = (json?.items ?? [])
      .flatMap((i) => [
        ...(i.validationMessages?.map((m) =>
          m.property ? `${m.property}: ${m.validationMessage ?? ''}` : (m.validationMessage ?? ''),
        ) ?? []),
        i.sstatus?.detail ?? '',
      ])
      .filter(Boolean)
    const kopf =
      json?.status?.detail ?? json?.status?.title ?? json?.detail ?? json?.title ?? 'unbekannter Fehler'
    const message = `DHL lehnte die Sendung ab (${res.status}): ${gruende.join(' · ') || kopf}`
    await logCreate(false, message)
    throw new DhlError(message, res.status, json)
  }

  const item = json.items?.[0]
  if (!item?.shipmentNo) {
    const messages = item?.validationMessages?.map((m) => m.validationMessage ?? '').filter(Boolean)
    const message = `DHL hat keine Sendungsnummer geliefert: ${messages?.join('; ') || item?.sstatus?.detail || 'unbekannter Fehler'}`
    await logCreate(false, message)
    throw new DhlError(message, res.status, json)
  }
  await logCreate(true)

  return {
    shipmentNumber: item.shipmentNo,
    trackingUrl: trackingUrl(item.shipmentNo),
    labelBase64: item.label?.b64,
    labelUrl: item.label?.url,
    // Weiche Adressvalidierung: DHL warnt, bucht aber trotzdem. Nicht
    // leitcodierbare Adressen kosten Nachcodierungs-Entgelt.
    warnings: (item.validationMessages ?? [])
      .map((m) => [m.property, m.validationMessage].filter(Boolean).join(': '))
      .filter(Boolean),
  }
}

/** Storniert eine Sendung. Möglich nur bis zum Tagesabschluss (Manifest). */
export async function cancelShipment(shipmentNumber: string): Promise<void> {
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeCancelShipment(shipmentNumber)
  }
  const start = Date.now()
  const res = await dhlFetch(
    `/parcel/de/shipping/v2/orders?shipment=${encodeURIComponent(shipmentNumber)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    const message = `Storno abgelehnt (${res.status}). Nach dem Tagesabschluss lässt sich ein Label nicht mehr stornieren.`
    await protokoll({
      kind: 'label_cancel', reference: shipmentNumber, ok: false,
      statusCode: res.status, error: message, durationMs: Date.now() - start,
    })
    throw new DhlError(message, res.status)
  }
  await protokoll({
    kind: 'label_cancel', reference: shipmentNumber, ok: true,
    statusCode: res.status, durationMs: Date.now() - start,
  })
}

// --- Tracking --------------------------------------------------------------

export type TrackingStatus = 'pre-transit' | 'transit' | 'delivered' | 'failure' | 'unknown'

export interface TrackingResult {
  status: TrackingStatus
  description: string
  timestamp: string | null
}

/**
 * Einzelabfrage über die konzernweite „Shipment Tracking – Unified API".
 * Nur noch der Umschalter `DHL_TRACKING_API=unified` (oder ein direkter
 * Aufruf) landet hier — der Sync nutzt trackShipments() und damit die
 * Geschäftskunden-API. Rate Limit der Unified API: initial 250 Abfragen pro
 * Tag und max. 1 Abfrage alle 5 Sekunden.
 */
export async function trackShipment(shipmentNumber: string): Promise<TrackingResult | null> {
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeTrackShipment(shipmentNumber)
  }
  const c = dhlConfig()
  const start = Date.now()
  const res = await fetch(
    `${c.base}/track/shipments?trackingNumber=${encodeURIComponent(shipmentNumber)}` +
      `&service=parcel-de&requesterCountryCode=DE&language=de`,
    { headers: { 'DHL-API-Key': c.apiKey, Accept: 'application/json' } },
  )
  const logTrack = (ok: boolean, error?: string) =>
    protokoll({
      kind: 'tracking', reference: shipmentNumber, ok,
      statusCode: res.status, error, durationMs: Date.now() - start,
    })

  if (res.status === 404) {
    await logTrack(true, 'Sendung (noch) nicht im Tracking')
    return null
  }
  if (res.status === 429) {
    await logTrack(false, 'Tracking-Limit erreicht')
    throw new DhlError('DHL-Tracking-Limit erreicht (Unified API: 250 Abfragen/Tag, 1 alle 5 s)', 429)
  }
  if (!res.ok) {
    await logTrack(false, `Tracking fehlgeschlagen (${res.status})`)
    throw new DhlError(`Tracking fehlgeschlagen (${res.status})`, res.status)
  }
  await logTrack(true)

  const json = (await res.json()) as {
    shipments?: {
      status?: { statusCode?: string; status?: string; description?: string; timestamp?: string }
    }[]
  }
  const status = json.shipments?.[0]?.status
  if (!status) return null

  const code = (status.statusCode ?? 'unknown') as TrackingStatus
  return {
    status: ['pre-transit', 'transit', 'delivered', 'failure'].includes(code) ? code : 'unknown',
    description: status.description ?? status.status ?? '',
    timestamp: status.timestamp ?? null,
  }
}

/** Unified statt Parcel DE Tracking — nur auf ausdrücklichen Wunsch. */
export function unifiedTracking(): boolean {
  return process.env.DHL_TRACKING_API === 'unified'
}

/**
 * Sammelabfrage — der Weg für den Tracking-Sync. Standard ist die
 * Geschäftskunden-API „Parcel DE Tracking" (bis 20 Sendungen je Aufruf,
 * 1.000 Aufrufe und 10.000 Sendungen je Tag, 3 Aufrufe je Sekunde); mit
 * DHL_TRACKING_API=unified läuft stattdessen die Einzelabfrage in Schleife
 * (5,5 s Pause), mit DHL_FAKE=1 der deterministische Fake.
 *
 * Ergebnis: je angefragter Nummer ein Eintrag — TrackingResult oder null
 * („noch keine Sendungsdaten"). Fehler, die die ganze Abfrage betreffen
 * (Limit, Anmeldung, HTTP-Fehler), werfen DhlError; was bis dahin
 * beantwortet war, verfällt — der Aufrufer fragt beim nächsten Lauf neu.
 */
export async function trackShipments(
  shipmentNumbers: string[],
): Promise<Map<string, TrackingResult | null>> {
  const ergebnis = new Map<string, TrackingResult | null>()
  if (shipmentNumbers.length === 0) return ergebnis
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeTrackShipments(shipmentNumbers)
  }
  if (unifiedTracking()) {
    for (const [index, nummer] of shipmentNumbers.entries()) {
      if (index > 0) await new Promise((r) => setTimeout(r, 5500))
      ergebnis.set(nummer, await trackShipment(nummer))
    }
    return ergebnis
  }

  const c = dhlConfig()
  // Die Sandbox der Tracking-API hat eigene Zugangsdaten (zt12345/geheim);
  // in Produktion ist es derselbe GKP-Systembenutzer wie beim Labeldruck.
  const benutzer = process.env.DHL_TRACKING_USER || c.user
  const passwort = process.env.DHL_TRACKING_PASSWORD || c.password
  for (let i = 0; i < shipmentNumbers.length; i += MAX_SENDUNGEN_JE_AUFRUF) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400)) // 3 Aufrufe/s
    const stapel = shipmentNumbers.slice(i, i + MAX_SENDUNGEN_JE_AUFRUF)
    for (const [nummer, lage] of await parcelDeTracking(c, benutzer, passwort, stapel)) {
      ergebnis.set(nummer, lage)
    }
  }
  return ergebnis
}

/** Ein Aufruf der Parcel DE Tracking API für höchstens 20 Sendungen. */
async function parcelDeTracking(
  c: DhlConfig,
  benutzer: string,
  passwort: string,
  stapel: string[],
): Promise<Map<string, TrackingResult | null>> {
  const start = Date.now()
  // Anmeldung UND Sendungsnummern stecken im XML im Query-Parameter — die
  // URL enthält also das GKP-Passwort und darf nie ins Protokoll.
  const xml = ztAnfrageXml({ benutzer, passwort, sendungsnummern: stapel })
  const res = await fetch(
    `${c.base}/parcel/de/tracking/v0/shipments?xml=${encodeURIComponent(xml)}`,
    { headers: { 'DHL-API-Key': c.apiKey } },
  )
  const text = await res.text()
  const log = (ok: boolean, error?: string) =>
    protokoll({
      kind: 'tracking',
      reference: stapel.length === 1 ? stapel[0] : `${stapel.length} Sendungen`,
      request: { sendungen: stapel },
      ok, statusCode: res.status, error, durationMs: Date.now() - start,
    })

  if (res.status === 429) {
    await log(false, 'Tracking-Limit erreicht')
    throw new DhlError('DHL-Tracking-Limit erreicht (1.000 Aufrufe/Tag, 3 je Sekunde)', 429)
  }
  if (!res.ok) {
    await log(false, `Tracking fehlgeschlagen (${res.status})`)
    throw new DhlError(`Tracking fehlgeschlagen (${res.status})`, res.status, text.slice(0, 500))
  }

  const antwort = parseZtAntwort(text)
  if (antwort.code === 5) {
    await log(false, 'Anmeldung abgelehnt (DHL-Code 5)')
    throw new DhlError(
      'Tracking-Anmeldung abgelehnt — GKP-Benutzer und Passwort prüfen (DHL_GKP_USER bzw. DHL_TRACKING_USER)',
      401,
    )
  }

  const ergebnis = new Map<string, TrackingResult | null>()
  for (const nummer of stapel) ergebnis.set(nummer, null)
  if (antwort.code === 100 || antwort.code === 200) {
    // Keine Daten zu keiner der Nummern — typisch direkt nach dem Labeldruck.
    await log(true, 'Noch keine Sendungsdaten')
    return ergebnis
  }
  if (antwort.code !== 0) {
    await log(false, `DHL-Rückgabecode ${antwort.code}`)
    throw new DhlError(`Tracking fehlgeschlagen (DHL-Code ${antwort.code})`, res.status, antwort.code)
  }
  for (const sendung of antwort.sendungen) {
    const nummer = stapel.find((n) => n.trim() === sendung.pieceCode) ?? sendung.pieceCode
    ergebnis.set(nummer, trackingStatusAus(sendung))
  }
  await log(true)
  return ergebnis
}

// --- Retouren --------------------------------------------------------------

export interface ReturnLabelResult {
  shipmentNumber: string
  labelBase64?: string
  qrLabelBase64?: string
  qrLink?: string
}

export async function createReturnLabel(
  customer: DhlAddress,
  reference: string,
): Promise<ReturnLabelResult> {
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeCreateReturnLabel(customer, reference)
  }
  const c = dhlConfig()
  const start = Date.now()
  const res = await dhlFetch(`/parcel/de/shipping/returns/v1/orders?labelType=BOTH`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receiverId: c.returnReceiverId,
      customerReference: reference,
      shipper: ohneLeere({
        name1: customer.name,
        addressStreet: customer.street,
        addressHouse: customer.houseNumber,
        postalCode: customer.zip,
        city: customer.city,
        country: customer.country,
        email: customer.email,
      }),
    }),
  })

  const json = (await res.json().catch(() => null)) as {
    shipmentNo?: string
    label?: { b64?: string }
    qrLabel?: { b64?: string }
    qrLink?: string
    status?: { detail?: string; title?: string }
    title?: string
    detail?: string
  } | null

  if (!res.ok || !json?.shipmentNo) {
    const message =
      `Retourenlabel abgelehnt (${res.status}): ${json?.status?.detail ?? json?.status?.title ?? json?.detail ?? json?.title ?? 'unbekannter Fehler'}. ` +
      `Voraussetzung ist ein Retouren-Vertrag mit im GKP angelegtem Retourenempfänger.`
    await protokoll({
      kind: 'return_label', reference, ok: false, statusCode: res.status,
      error: message, response: json?.status, durationMs: Date.now() - start,
    })
    throw new DhlError(message, res.status, json)
  }
  await protokoll({
    kind: 'return_label', reference, ok: true, statusCode: res.status,
    response: { shipmentNo: json.shipmentNo, qrLink: json.qrLink },
    durationMs: Date.now() - start,
  })

  return {
    shipmentNumber: json.shipmentNo,
    labelBase64: json.label?.b64,
    qrLabelBase64: json.qrLabel?.b64,
    qrLink: json.qrLink,
  }
}
