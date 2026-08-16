import 'server-only'
import { trackingUrl } from './dhl-codes'
import type {
  CreateShipmentInput,
  CreatedShipment,
  DhlAddress,
  ReturnLabelResult,
  TrackingResult,
} from './dhl'

/**
 * Deterministischer DHL-Ersatz für Prozesstests und Staging (DHL_FAKE=1).
 * Getypt gegen die ECHTEN Client-Schnittstellen aus dhl.ts — ändert sich dort
 * eine Signatur, bricht der Fake zur Compile-Zeit statt zur Laufzeit.
 */

// Ein minimales, echtes PDF (ein leeres A6-Blatt) — damit Download-Knöpfe
// und Druckwege auch im Fake-Betrieb etwas Anzeigbares bekommen.
const LEERES_PDF_BASE64 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 298 420]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF',
).toString('base64')

/** Stabile Pseudo-Sendungsnummer aus der Referenz (20-stellig, Ziffern). */
function nummerAus(reference: string): string {
  let h = 7
  for (const zeichen of reference) h = (h * 31 + zeichen.charCodeAt(0)) % 1_000_000_007
  return `99${String(h).padStart(10, '0')}00000000`.slice(0, 20)
}

async function protokoll(kind: string, reference: string, response: unknown): Promise<void> {
  const { logTransaction } = await import('../integrationen/transaktionen')
  await logTransaction({ system: 'dhl', kind: `fake:${kind}`, reference, ok: true, response })
}

export async function fakeCreateShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
  const shipmentNumber = nummerAus(input.reference)
  await protokoll('label_create', input.reference, { shipmentNumber, product: input.product })
  return {
    shipmentNumber,
    trackingUrl: trackingUrl(shipmentNumber),
    labelBase64: LEERES_PDF_BASE64,
    warnings: [],
  }
}

export async function fakeCancelShipment(shipmentNumber: string): Promise<void> {
  await protokoll('label_cancel', shipmentNumber, { storniert: true })
}

export async function fakeTrackShipment(shipmentNumber: string): Promise<TrackingResult | null> {
  await protokoll('tracking', shipmentNumber, { status: 'transit' })
  return {
    status: 'transit',
    description: 'Fake: Sendung im Zustellfahrzeug',
    timestamp: null,
  }
}

export async function fakeCreateReturnLabel(
  customer: DhlAddress,
  reference: string,
): Promise<ReturnLabelResult> {
  const shipmentNumber = nummerAus(`retoure:${reference}`)
  await protokoll('return_label', reference, { shipmentNumber, kunde: customer.name })
  return {
    shipmentNumber,
    labelBase64: LEERES_PDF_BASE64,
    qrLabelBase64: undefined,
    qrLink: `https://example.invalid/qr/${shipmentNumber}`,
  }
}
