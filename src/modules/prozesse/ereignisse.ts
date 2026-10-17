/**
 * Katalog der eingehenden Ereignisse — die „ereignis"-Prozessschritte:
 * Punkte, an denen ein Prozess auf die Außenwelt wartet, statt selbst zu
 * handeln. Quelle sind heute die Shopify-Webhooks und der Tracking-Sync;
 * die Topics sind anbieterneutral einsortiert (`shop:` / `sendung:`),
 * die Zuordnung zur konkreten Quelle steht in der Beschreibung.
 */

export interface EreignisEintrag {
  label: string
  beschreibung: string
  /** Technische Quelle, z. B. der Shopify-Webhook-Topic. */
  quelle: string
}

export const EREIGNISSE = {
  'shop:bestellung_eingegangen': {
    label: 'Bestellung eingegangen',
    beschreibung: 'Neue oder geänderte Shop-Bestellung; bezahlte werden sofort bestätigt.',
    quelle: 'shopify webhook orders/create + orders/updated',
  },
  'shop:bestellung_geaendert': {
    label: 'Bestellung im Shop geändert',
    beschreibung:
      'Der Kunde oder der Shop hat eine bestätigte Bestellung geändert (andere Variante, Menge, Zusatzartikel, ' +
      'Teilerstattung): vor dem Versand folgen Auftrag, Lieferung und Fertigung; nach der Rechnung entstehen ' +
      'Gutschrift (zurückgenommene Menge) bzw. eine neue Rechnung mit der Nachlieferung.',
    quelle: 'shopify webhook orders/updated (lineItems.currentQuantity) + Abgleich',
  },
  'shop:bestellung_storniert': {
    label: 'Bestellung storniert/erstattet',
    beschreibung: 'Storno oder Erstattung im Shop; der Auftrag wird nach den Storno-Regeln behandelt.',
    quelle: 'shopify webhook orders/cancelled + orders/updated (REFUNDED)',
  },
  'shop:bestellung_erstattet': {
    label: 'Im Shop erstattet',
    beschreibung:
      'Der Shop hat zu einer Bestellung mit offener Retoure erstattet (Gesamtbetrag gesunken oder ganz ' +
      'erstattet): die Retoure gilt als erstattet und schließt — ist sie geprüft — sofort ab; nicht begonnene ' +
      'Fertigung, die der Rückläufer deckt, entfällt.',
    quelle: 'shopify webhook orders/updated (currentTotalPriceSet, displayFinancialStatus) + Abgleich',
  },
  'shop:produkt_geaendert': {
    label: 'Produkt im Shop geändert',
    beschreibung: 'Produkt im Shop-Admin angelegt oder geändert; verknüpfte Produkte folgen dem Shop.',
    quelle: 'shopify webhook products/create + products/update',
  },
  'shop:bestand_geaendert': {
    label: 'Bestand im Shop geändert',
    beschreibung: 'Handkorrektur im Shop-Admin; Abweichungen werden erkannt und überschrieben.',
    quelle: 'shopify webhook inventory_levels/update',
  },
  'shop:bestellung_versendet': {
    label: 'Bestellung im Shop versendet',
    beschreibung:
      'Der Shop meldet die Bestellung als erfüllt, ohne dass KRNL eine Sendung dazu hat (Versand ' +
      'außerhalb, z. B. Sendcloud): der Warenausgang wird gebucht, die Trackingdaten stehen an der ' +
      'Lieferung, eine noch offene Fertigung wird zur Nachfrage ans Team Fertigung.',
    quelle: 'shopify webhook orders/updated (displayFulfillmentStatus FULFILLED) + Abgleich',
  },
  'sendung:zugestellt': {
    label: 'Sendung zugestellt',
    beschreibung: 'Der Paketdienst meldet die Zustellung; die Sendung ist damit abgeschlossen.',
    quelle: 'dhl tracking-sync (statusCode delivered)',
  },
  'fertigung:bereitgestellt': {
    label: 'Erzeugnis bereitgestellt',
    beschreibung:
      'Der Fertigungsauftrag zur Bestellung (fertigen auf Bestellung) ist fertig gemeldet — ' +
      'das Erzeugnis liegt im Lager, die Lieferung kann reservieren.',
    quelle: 'intern: fertigung.fertig_melden (MTO-Auftrag aus der Bestätigung)',
  },
} satisfies Record<string, EreignisEintrag>

export type EreignisTopic = keyof typeof EREIGNISSE
