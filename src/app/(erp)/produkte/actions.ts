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

export async function setVariantenCodes(templateId: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('produkte.varianten_codes', { recordId: templateId, formData })
  outboxAnstossen()
  return ergebnis
}

export async function setShopProjekt(formData: FormData): Promise<ActionResult> {
  return serverAktion('produkte.shop_projekt_setzen', { formData })
}

/** Shop-Regeln eines Artikels (Karte am Produkt und an der Variante) — dieselbe Aktion wie in der Shop-Verfügbarkeit. */
export async function setShopRegeln(formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.shop_variante_setzen', { formData })
}

/**
 * Löschen bzw. Archivieren. Wirklich gelöscht → zurück zur Liste (die Seite
 * gibt es nicht mehr); archiviert → die Meldung bleibt stehen und erklärt, warum.
 */
export async function deleteProduct(templateId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('produkte.produkt_loeschen', { recordId: templateId })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.daten?.art === 'geloescht') redirect('/produkte')
  return ergebnis
}

export async function restoreProduct(templateId: string): Promise<ActionResult> {
  return serverAktion('produkte.produkt_wiederherstellen', { recordId: templateId })
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
