'use server'

import type { ActionResult } from '@/modules/shared/action'
import { serverAktion } from '@/modules/prozesse/server-aktion'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird im
 * Torwächter — hier steht nur, WELCHE Registry-Aktion transportiert wird.
 */

export async function rechnungTeilzahlung(billId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('finanzen.rechnung_teilzahlung', { recordId: billId, formData })
}

export async function poZahlplanSetzen(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('finanzen.po_zahlplan_setzen', { recordId: orderId, formData })
}

export async function zahlplanRateHinzufuegen(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('finanzen.zahlplan_rate_hinzufuegen', { recordId: orderId, formData })
}

export async function zahlplanRateEntfernen(rateId: string): Promise<ActionResult> {
  return serverAktion('finanzen.zahlplan_rate_entfernen', { parameter: { rate_id: rateId } })
}

export async function rateZahlen(rateId: string): Promise<ActionResult> {
  return serverAktion('finanzen.rate_zahlen', { parameter: { rate_id: rateId } })
}

export async function verschiffungErfassen(orderId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('finanzen.verschiffung_erfassen', { recordId: orderId, formData })
}

export async function zahlungStornieren(zahlungId: string): Promise<ActionResult> {
  return serverAktion('finanzen.zahlung_stornieren', { parameter: { zahlung_id: zahlungId } })
}

export async function vertragZahlen(vertragId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('finanzen.vertrag_zahlen', { recordId: vertragId, formData })
}
