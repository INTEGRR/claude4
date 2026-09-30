'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionInfo } from '@/modules/shared/action'

/**
 * Transport für Einkaufsprojekte (0097) — geprüft und ausgeführt wird in
 * der Registry (registry/einkauf-projekte.ts). Angebote hängen an keinem
 * Beleg-Pfad, deshalb lädt der Wrapper die Projektseite selbst neu.
 */

const seite = (id: string) => `/einkauf/projekte/${id}`

export async function projektAnlegen(formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.projekt_anlegen', { formData })
  if (isActionInfo(r) && r.link) redirect(r.link)
  return r
}

export async function projektAendern(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_aendern', { recordId: id, formData })
}

export async function positionSetzen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_position_setzen', { recordId: id, formData })
}

export async function positionEntfernen(id: string, positionId: string): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_position_entfernen', { recordId: id, parameter: { position_id: positionId } })
}

export async function anfragenVorbereiten(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.anfragen_senden', { recordId: id, formData })
}

export async function anfragenFreigeben(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.anfragen_freigeben', { recordId: id })
}

export async function angebotErfassen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.angebot_erfassen', { recordId: id, formData })
}

export async function angebotAendern(id: string, formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.angebot_aendern', { formData })
  revalidatePath(seite(id))
  return r
}

export async function angebotVerwerfen(id: string, angebotId: string, verworfen: boolean): Promise<ActionResult> {
  const r = await serverAktion('einkauf.angebot_verwerfen', { parameter: { angebot_id: angebotId, verworfen } })
  revalidatePath(seite(id))
  return r
}

export async function projektEntscheiden(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_entscheiden', { recordId: id, formData })
}

export async function projektBestellen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_bestellen', { recordId: id })
}

export async function projektAbschliessen(id: string): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_abschliessen', { recordId: id })
}

export async function projektAbbrechen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.projekt_abbrechen', { recordId: id, formData })
}

export async function bestellungZuordnen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.bestellung_projekt_zuordnen', { recordId: id, formData })
}

export async function frachtsatzSetzen(formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.frachtsatz_setzen', { formData })
}

export async function zolltarifSetzen(formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.zolltarif_setzen', { formData })
}

export async function zolltarifLoeschen(hsPraefix: string): Promise<ActionResult> {
  return serverAktion('einkauf.zolltarif_setzen', { parameter: { hs_praefix: hsPraefix, loeschen: true } })
}

export async function ezbKurseHolen(): Promise<ActionResult> {
  return serverAktion('einkauf.ezb_kurse_abrufen')
}
