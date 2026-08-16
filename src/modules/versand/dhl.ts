import 'server-only'
import { productForCountry, toAlpha3, trackingUrl } from './dhl-codes'

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
  return fetch(`${c.base}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      'dhl-api-key': c.apiKey,
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

export async function createShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
  if (process.env.DHL_FAKE === '1') {
    return (await import('./dhl-fake')).fakeCreateShipment(input)
  }
  const c = dhlConfig()
  const printFormat = input.printFormat ?? '910-300-700'

  const body = {
    profile: 'STANDARD_GRUPPENPROFIL',
    shipments: [
      {
        product: input.product,
        billingNumber: input.billingNumber ?? c.billingNumber,
        refNo: input.reference,
        shipper: {
          name1: input.shipper.name,
          addressStreet: input.shipper.street,
          addressHouse: input.shipper.houseNumber,
          postalCode: input.shipper.zip,
          city: input.shipper.city,
          country: input.shipper.country,
          email: input.shipper.email,
          phone: input.shipper.phone,
        },
        consignee: {
          name1: input.consignee.name,
          addressStreet: input.consignee.street,
          addressHouse: input.consignee.houseNumber,
          additionalAddressInformation1: input.consignee.addition,
          postalCode: input.consignee.zip,
          city: input.consignee.city,
          country: input.consignee.country,
          email: input.consignee.email,
          phone: input.consignee.phone,
        },
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
    status?: { title?: string; detail?: string }
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
    const message = `DHL lehnte die Sendung ab (${res.status}): ${json?.status?.detail ?? json?.status?.title ?? 'unbekannter Fehler'}`
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
 * Shipment Tracking - Unified API. Achtung Rate Limit: initial 250 Abfragen
 * pro Tag und max. 1 Abfrage alle 5 Sekunden.
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
    throw new DhlError('DHL-Tracking-Limit erreicht (250 Abfragen/Tag, 1 alle 5 s)', 429)
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
      shipper: {
        name1: customer.name,
        addressStreet: customer.street,
        addressHouse: customer.houseNumber,
        postalCode: customer.zip,
        city: customer.city,
        country: customer.country,
        email: customer.email,
      },
    }),
  })

  const json = (await res.json().catch(() => null)) as {
    shipmentNo?: string
    label?: { b64?: string }
    qrLabel?: { b64?: string }
    qrLink?: string
    status?: { detail?: string; title?: string }
  } | null

  if (!res.ok || !json?.shipmentNo) {
    const message =
      `Retourenlabel abgelehnt (${res.status}): ${json?.status?.detail ?? json?.status?.title ?? 'unbekannter Fehler'}. ` +
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
