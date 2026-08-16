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
  'shop:bestellung_storniert': {
    label: 'Bestellung storniert/erstattet',
    beschreibung: 'Storno oder Erstattung im Shop; der Auftrag wird nach den Storno-Regeln behandelt.',
    quelle: 'shopify webhook orders/cancelled + orders/updated (REFUNDED)',
  },
  'shop:produkt_geaendert': {
    label: 'Produkt im Shop geändert',
    beschreibung: 'Produktanlage/-änderung im Shop-Admin; verknüpfte Produkte folgen dem Shop.',
    quelle: 'shopify webhook products/create + products/update',
  },
  'shop:bestand_geaendert': {
    label: 'Bestand im Shop geändert',
    beschreibung: 'Handkorrektur im Shop-Admin; Abweichungen werden erkannt und überschrieben.',
    quelle: 'shopify webhook inventory_levels/update',
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
