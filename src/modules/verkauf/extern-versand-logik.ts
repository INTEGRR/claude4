import type { ShopifyOrder } from '../integrationen/shopify.ts'

/**
 * Versand außerhalb von KRNL (2026-10-15): Sendcloud läuft parallel, die
 * Sendung entsteht dort und landet in Shopify als Fulfillment. Der pure
 * Teil des Nachziehens — was aus der Shop-Bestellung zu lesen ist und wie
 * die Nachfrage an die Fertigung lautet — ohne Datenbank, testbar unter
 * blankem Node (tests/extern-versand.test.ts).
 */

/** Was an der Lieferung steht (`stock_pickings.extern_versand`). */
export interface ExternVersand {
  quelle: 'shopify'
  carrier: string | null
  nummer: string | null
  url: string | null
  /** Zeitpunkt des Fulfillments laut Shop (ISO). */
  am: string
  fulfillment_id: string | null
}

type ShopStand = Pick<ShopifyOrder, 'displayFulfillmentStatus' | 'fulfillments'>

/**
 * Der Shop sagt „erfüllt": Trackingdaten des letzten erfolgreichen
 * Fulfillments. Teil-Erfüllungen zählen bewusst nicht — erst wenn alles
 * draußen ist, wird in KRNL der ganze Warenausgang gebucht.
 */
export function externVersandAusShop(order: ShopStand, jetzt = new Date().toISOString()): ExternVersand | null {
  if (order.displayFulfillmentStatus !== 'FULFILLED') return null
  const erfolgreich = (order.fulfillments ?? []).filter((f) => f.status === 'SUCCESS')
  const f = erfolgreich.at(-1) ?? null
  const spur = (f?.trackingInfo ?? []).find((t) => t.number) ?? f?.trackingInfo?.[0] ?? null
  return {
    quelle: 'shopify',
    carrier: spur?.company?.trim() || null,
    nummer: spur?.number?.trim() || null,
    url: spur?.url?.trim() || null,
    am: f?.createdAt ?? jetzt,
    fulfillment_id: f?.id ?? null,
  }
}

/** „DHL 00340434…" bzw. „ohne Trackingdaten" — für Protokoll und Anzeige. */
export function externVersandText(e: ExternVersand): string {
  const teile = [e.carrier, e.nummer].filter(Boolean)
  return teile.length ? teile.join(' ') : 'ohne Trackingdaten'
}

/**
 * Die Nachfrage ans Team Fertigung, wenn der Auftrag versendet ist, der
 * Fertigungsauftrag aber noch offen: Eine Aufgabe je Auftrag, der Titel ist
 * zugleich der Doppel-Schutz. `extern` = der Shop hat versendet (Sendcloud);
 * sonst wurde die Lieferung in KRNL von Hand gebucht (seit 2026-10-17).
 */
export function fertigungsNachfrage(
  auftrag: { id: string; number: string; shopify_order_name: string | null },
  mos: { id: string; number: string }[],
  extern = true,
): { titel: string; beschreibung: string } {
  const name = auftrag.shopify_order_name ? `${auftrag.number} (${auftrag.shopify_order_name})` : auftrag.number
  const nummern = mos.map((m) => m.number).join(', ')
  return {
    titel: `${extern ? NACHFRAGE_PRAEFIX : NACHFRAGE_PRAEFIX_KRNL}${nummern} zu ${name} noch durchführen?`,
    beschreibung:
      (extern
        ? `Der Shop meldet ${name} als versendet (Versand außerhalb von KRNL, z. B. Sendcloud); ` +
          'KRNL hat den Warenausgang gebucht.'
        : `Die Lieferung zu ${name} ist in KRNL gebucht, ohne dass die Fertigung fertig gemeldet war.`) +
      ' Der Fertigungsauftrag ist aber noch offen — wurde die Ware gebaut?\n' +
      '• Ja: Fertigungsauftrag „Fertig melden" — das Material wird verbraucht und das Erzeugnis gebucht, ' +
      'der Bestand des Erzeugnisses geht damit wieder auf null.\n' +
      '• Nein: Fertigungsauftrag stornieren und den Bestand des Erzeugnisses per Inventur korrigieren.\n' +
      `Fertigung: ${mos.map((m) => `/fertigung/${m.id}`).join(', ')} · Auftrag: /verkauf/${auftrag.id}`,
  }
}

/** Titel-Präfixe der Nachfrage — zugleich der Schlüssel, um sie wiederzufinden. */
export const NACHFRAGE_PRAEFIX = 'Extern versendet: Fertigung '
export const NACHFRAGE_PRAEFIX_KRNL = 'Versendet ohne Fertigmeldung: Fertigung '
export const NACHFRAGE_PRAEFIXE = [NACHFRAGE_PRAEFIX, NACHFRAGE_PRAEFIX_KRNL] as const

/** Ist diese Aufgabe eine Nachfrage an die Fertigung (gleich welcher Herkunft)? */
export function istFertigungsNachfrage(titel: string): boolean {
  return NACHFRAGE_PRAEFIXE.some((p) => titel.startsWith(p))
}

/** „Extern versendet: Fertigung FA/0418, FA/0419 zu S00042 (#5012) noch durchführen?" → ['FA/0418', 'FA/0419'] */
export function nachfrageNummern(titel: string): string[] {
  const praefix = NACHFRAGE_PRAEFIXE.find((p) => titel.startsWith(p))
  if (!praefix) return []
  const m = /^(.+?) zu \S+/.exec(titel.slice(praefix.length))
  return m ? m[1].split(',').map((n) => n.trim()).filter(Boolean) : []
}
