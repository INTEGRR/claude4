/**
 * Felder einer Shop-Bestellung für Auftrag und Kundenrechnung (0115) — rein,
 * ohne Datenbank: Belegzeilenname mit Variante, Listenpreis vor Rabatt,
 * lesbare Zahlungsart, Rechnungsanschrift. Der Import (import.ts) und die
 * Tests rechnen mit denselben Funktionen.
 */
import { splitStreet } from '../shared/address.ts'
import type { ShopifyOrder } from './shopify.ts'
import { netto, runden, satzAusSteuerzeilen } from './shopify-preise.ts'

type Position = ShopifyOrder['lineItems']['nodes'][number]

/** Belegzeile: Produkttitel plus Variantenname (0115) — so steht es auch auf der Rechnung. */
export function positionsName(item: Pick<Position, 'title' | 'variantTitle'>): string {
  const variante = item.variantTitle?.trim()
  return variante && variante !== 'Default Title' ? `${item.title} - ${variante}` : item.title
}

/** Netto-Listenpreis vor Rabatt (0115) — null, wenn es keinen Rabatt gab. */
export function listenpreisNetto(
  item: Pick<Position, 'originalUnitPriceSet' | 'discountedUnitPriceAfterAllDiscountsSet' | 'taxLines'>,
  taxesIncluded: boolean | null | undefined): number | null {
  const original = Number(item.originalUnitPriceSet.shopMoney.amount)
  const nachRabatt = item.discountedUnitPriceAfterAllDiscountsSet
    ? Number(item.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount)
    : null
  if (nachRabatt == null || !(nachRabatt < original - 0.004)) return null
  const satz = item.taxLines ? satzAusSteuerzeilen(item.taxLines) : 0
  return runden(netto(original, satz, Boolean(taxesIncluded)), 2)
}

const ZAHLUNGSARTEN: Record<string, string> = {
  shopify_payments: 'Shopify Payments',
  paypal: 'PayPal',
  klarna: 'Klarna',
  manual: 'Überweisung',
  bank_deposit: 'Überweisung',
  gift_card: 'Geschenkgutschein',
}

/** Lesbare Zahlungsart aus den Gateways der Bestellung (0115). */
export function zahlungsartText(order: Pick<ShopifyOrder, 'paymentGatewayNames'>): string | null {
  const namen = (order.paymentGatewayNames ?? []).filter(Boolean)
  if (namen.length === 0) return null
  return namen
    .map((n) => ZAHLUNGSARTEN[n] ?? n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(', ')
}

/** Rechnungsanschrift aus dem Shop (0115) — null, wenn Shopify keine liefert. */
export function rechnungsanschrift(order: Pick<ShopifyOrder, 'billingAddress'>): Record<string, string | null> | null {
  const b = order.billingAddress
  if (!b || (!b.name && !b.address1)) return null
  const { street, houseNumber } = splitStreet(b.address1)
  return {
    name: b.name, company: b.company ?? null, street, house: houseNumber, street2: b.address2 ?? null,
    zip: b.zip, city: b.city, country: b.countryCodeV2,
  }
}
