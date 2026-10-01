'use server'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { ActionResult } from '@/modules/shared/action'
import type { DokumentArt, DokumentModell } from '@/modules/einkauf/dokument-modelle'
import { DOKUMENT_MODELLE } from '@/modules/einkauf/dokument-modelle'
import { revalidatePath } from 'next/cache'

/**
 * Dreizeiler um serverAktion(): geprüft und ausgeführt wird in der Registry
 * (registry/einkauf-dokumente.ts) — hier lebt nur der Transport. Pfade
 * zum Neuladen kommen aus dem Beleg, weil dieselben Knöpfe an Bestellung,
 * Rechnung, Artikel und Lieferant hängen.
 */

const PFADE: Record<DokumentModell, (id: string) => string> = {
  partner: (id) => `/einkauf/lieferanten/${id}`,
  purchase_order: (id) => `/einkauf/${id}`,
  vendor_bill: (id) => `/einkauf/rechnungen/${id}`,
  product_template: (id) => `/produkte/${id}`,
  mail_thread: (id) => `/einkauf/posteingang/${id}`,
  einkaufsprojekt: (id) => `/einkauf/projekte/${id}`,
  bemusterung: (id) => `/einkauf/muster/${id}`,
  werkzeug: (id) => `/einkauf/werkzeuge/${id}`,
  lieferantenvertrag: (id) => `/einkauf/vertraege/${id}`,
}

function neuLaden(modell: DokumentModell, recordId: string) {
  if (modell in DOKUMENT_MODELLE) revalidatePath(PFADE[modell](recordId))
}

export async function uploadVorbereiten(werte: {
  name: string
  mime?: string
  groesse: number
  modell: DokumentModell
  record_id: string
  art?: DokumentArt
}): Promise<ActionResult> {
  return serverAktion('einkauf.upload_vorbereiten', { parameter: werte })
}

export async function dokumentRegistrieren(
  werte: { sitzung_id: string; drive_file_id: string },
  modell: DokumentModell,
  recordId: string,
): Promise<ActionResult> {
  const r = await serverAktion('einkauf.dokument_registrieren', { parameter: werte })
  neuLaden(modell, recordId)
  return r
}

export async function dokumentAendern(modell: DokumentModell, recordId: string, formData: FormData): Promise<ActionResult> {
  const r = await serverAktion('einkauf.dokument_aendern', { formData })
  neuLaden(modell, recordId)
  return r
}

export async function dokumentLoesen(dokumentId: string, modell: DokumentModell, recordId: string): Promise<ActionResult> {
  const r = await serverAktion('einkauf.dokument_loesen', {
    parameter: { dokument_id: dokumentId, modell, record_id: recordId },
  })
  neuLaden(modell, recordId)
  return r
}

export async function ablageEinrichten(): Promise<ActionResult> {
  return serverAktion('einkauf.ablage_einrichten', {})
}

export async function lieferantendatenSetzen(partnerId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('einkauf.lieferantendaten_setzen', { recordId: partnerId, formData })
}
