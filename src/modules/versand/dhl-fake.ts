import 'server-only'
import { trackingUrl } from './dhl-codes'
import {
  type CreateShipmentInput,
  type CreatedShipment,
  type DhlAddress,
  DhlError,
  type ReturnLabelResult,
  type TrackingResult,
} from './dhl'
import {
  type AdressPruefung,
  ablehnungsText,
  fakeAntwort,
  fakePruefMeldungen,
  pruefAntwortAuswerten,
  warnungenLesbar,
} from './dhl-validierung'

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

async function protokoll(kind: string, reference: string, response: unknown, request?: unknown): Promise<void> {
  const { logTransaction } = await import('../integrationen/transaktionen')
  await logTransaction({ system: 'dhl', kind: `fake:${kind}`, reference, ok: true, request, response })
}

/**
 * Adressprüfung (validate=true) im Fake: dieselben Regeln wie der Fake-
 * Labeldruck (dhl-validierung.ts, fakePruefMeldungen) — PLZ in Deutschland
 * fünf Ziffern, Hausnummer vorhanden —, ausgewertet vom ECHTEN Parser. Die
 * Eingabe steht im Protokoll wie beim Label: so ist nachprüfbar, dass beide
 * denselben Request bekommen.
 */
export async function fakeValidateShipment(input: CreateShipmentInput): Promise<AdressPruefung> {
  const { status, json } = fakeAntwort(fakePruefMeldungen(input.consignee))
  await protokoll('address_validate', input.reference, json, input)
  return pruefAntwortAuswerten(status, json)!
}

export async function fakeCreateShipment(input: CreateShipmentInput): Promise<CreatedShipment> {
  // Was DHL hart ablehnt (ungültige PLZ), lehnt auch der Fake ab — mit
  // derselben Klartext-Meldung wie der echte Client; Hinweise (keine
  // Hausnummer) gehen als warnings mit, das Label entsteht trotzdem.
  const antwort = fakeAntwort(fakePruefMeldungen(input.consignee))
  if (antwort.status >= 400) {
    const message = ablehnungsText(antwort.status, antwort.json)
    const { logTransaction } = await import('../integrationen/transaktionen')
    await logTransaction({
      system: 'dhl', kind: 'fake:label_reject', reference: input.reference, ok: false,
      statusCode: antwort.status, request: input, response: antwort.json, error: message,
    })
    throw new DhlError(message, antwort.status, antwort.json)
  }
  // Jedes Label bekommt eine neue Nummer wie bei DHL — ein Ersatz-Label nach
  // Storno (gleiche Referenz) darf nicht mit dem stornierten kollidieren.
  // Ohne Datenbank (reine Fake-Tests) bleibt es bei der stabilen Nummer.
  let n = 0
  try {
    const { sql } = await import('@/db/client')
    const [zeile] = await sql<{ n: number }[]>`
      select count(*)::int as n from api_transactions
      where system = 'dhl' and kind = 'fake:label_create' and reference = ${input.reference}`
    n = zeile.n
  } catch {
    n = 0
  }
  const shipmentNumber = nummerAus(n > 0 ? `${input.reference}#${n}` : input.reference)
  await protokoll('label_create', input.reference, { shipmentNumber, product: input.product }, input)
  return {
    shipmentNumber,
    trackingUrl: trackingUrl(shipmentNumber),
    labelBase64: LEERES_PDF_BASE64,
    warnings: warnungenLesbar(antwort.json.items?.[0]),
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

/** Sammelabfrage: jede Nummer gilt als unterwegs — ein Protokolleintrag je Aufruf. */
export async function fakeTrackShipments(
  shipmentNumbers: string[],
): Promise<Map<string, TrackingResult | null>> {
  await protokoll('tracking', `${shipmentNumbers.length} Sendungen`, { status: 'transit' })
  return new Map(
    shipmentNumbers.map((nummer) => [
      nummer,
      { status: 'transit' as const, description: 'Fake: Sendung im Zustellfahrzeug', timestamp: null },
    ]),
  )
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
