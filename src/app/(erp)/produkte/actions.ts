'use server'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/produkte.ts). Der opportunistische
 * Outbox-Anstoß nach Shopify-relevanten Änderungen bleibt Transportsache
 * und lebt deshalb hier (after läuft nach der Antwort).
 */

function outboxAnstossen() {
  after(async () => {
    const { runDueJobs } = await import('@/modules/integrationen/jobs')
    await runDueJobs().catch(() => {})
  })
}

export async function createProduct(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('produkte.produkt_erfassen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function updateProduct(templateId: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('produkte.produkt_aendern', { recordId: templateId, formData })
  outboxAnstossen()
  return ergebnis
}

export async function addAttribute(templateId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('produkte.attribut_zuweisen', { recordId: templateId, formData })
}

export async function setVariantCodes(variantId: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('produkte.variante_codes', { recordId: variantId, formData })
  outboxAnstossen()
  return ergebnis
}

export async function createAttribute(formData: FormData): Promise<ActionResult> {
  return serverAktion('produkte.attribut_anlegen', { formData })
}

export async function produktZuShopify(templateId: string): Promise<ActionResult> {
  return serverAktion('produkte.zu_shopify', { recordId: templateId })
}

export async function addVendorPrice(templateId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('produkte.lieferantenpreis_anlegen', { recordId: templateId, formData })
}

export async function deleteVendorPrice(templateId: string, preisId: string): Promise<ActionResult> {
  return serverAktion('produkte.lieferantenpreis_loeschen', {
    recordId: templateId,
    parameter: { preis_id: preisId },
  })
}
