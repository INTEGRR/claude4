'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/** Kundenrechnungen (0115): dünne Server-Action-Hüllen um die Registry. */

export async function rechnungAusLieferung(pickingId: string): Promise<ActionResult> {
  const ergebnis = await serverAktion('verkauf.rechnung_erstellen', { recordId: pickingId })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function rechnungZahlen(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.rechnung_zahlen', { recordId: id, formData })
}

export async function rechnungAlsBezahlt(id: string): Promise<ActionResult> {
  return serverAktion('verkauf.rechnung_zahlen', { recordId: id, parameter: {} })
}

export async function rechnungStornieren(id: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('verkauf.rechnung_stornieren', { recordId: id, formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function gutschriftErstellen(id: string, formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('verkauf.gutschrift_erstellen', { recordId: id, formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function rechnungMahnen(id: string): Promise<ActionResult> {
  return serverAktion('verkauf.rechnung_mahnen', { recordId: id })
}

export async function rechnungDetails(id: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.rechnung_details', { recordId: id, formData })
}

export async function datevUebergeben(formData: FormData): Promise<ActionResult> {
  return serverAktion('verkauf.datev_uebergeben', { formData })
}
