/**
 * Shopify-Probelauf (0102): macht aus einem Protokolleintrag „würde senden"
 * (api_transactions, kind 'probe:<operation>') eine lesbare Zeile für die
 * Debug-Box. Rein rechnend, ohne Datenbank.
 */

export interface ProbeZeile {
  titel: string
  details: string[]
}

const TITEL: Record<string, string> = {
  fulfillmentCreate: 'Bestellung als versendet melden',
  fulfillmentTrackingInfoUpdate: 'Sendungsnummer nachreichen',
  tagsAdd: 'Tags an der Bestellung setzen',
  orderCancel: 'Bestellung stornieren',
  productCreate: 'Produkt anlegen',
  productUpdate: 'Produkt ändern',
  productSet: 'Produkt anlegen/ändern',
  productVariantsBulkCreate: 'Varianten anlegen',
  productVariantsBulkUpdate: 'Varianten ändern',
  webhookSubscriptionCreate: 'Webhook registrieren',
  webhookSubscriptionDelete: 'Webhook entfernen',
  inventorySetQuantities: 'Bestand an Shopify melden',
}

/** Alle Strings aus einem Objekt, die nach Sendungsnummer/Name aussehen — für knappe Details. */
function werte(objekt: unknown, schluessel: string[], tiefe = 0): string[] {
  if (tiefe > 5 || objekt === null || typeof objekt !== 'object') return []
  const treffer: string[] = []
  for (const [k, v] of Object.entries(objekt as Record<string, unknown>)) {
    if (schluessel.includes(k) && (typeof v === 'string' || typeof v === 'number')) treffer.push(`${k}: ${v}`)
    else if (typeof v === 'object') treffer.push(...werte(v, schluessel, tiefe + 1))
  }
  return treffer
}

export function probeZeile(kind: string, request: unknown): ProbeZeile {
  const operation = kind.replace(/^probe:/, '')
  const r = (request ?? {}) as Record<string, unknown>

  if (operation === 'inventorySetQuantities' && Array.isArray(r.aenderungen)) {
    const liste = r.aenderungen as { sku: string | null; name: string; vorher: number | null; neu: number }[]
    return {
      titel: `Bestand an Shopify: ${liste.length} Änderung(en)${liste.every((a) => a.vorher === null) ? ' (erste vollständige Meldung)' : ''}`,
      details: liste.map(
        (a) =>
          `${a.name}${a.sku ? ` (${a.sku})` : ''}: ${a.vorher === null ? '' : `${a.vorher} → `}${a.neu}${a.neu <= 0 ? ' · ausverkauft' : ''}`,
      ),
    }
  }

  if (operation === 'productVariantsBulkUpdate' && Array.isArray(r.varianten)) {
    const liste = r.varianten as string[]
    return {
      titel: `Made-to-Order einrichten: ${liste.length} Variante(n) — Menge verfolgen, nicht ohne Bestand verkaufen`,
      details: liste,
    }
  }

  const titel = TITEL[operation] ?? operation
  const details = werte(r.variables, ['number', 'trackingNumber', 'company', 'id', 'orderId', 'title', 'topic', 'callbackUrl'])
  return { titel, details: [...new Set(details)].slice(0, 8) }
}
