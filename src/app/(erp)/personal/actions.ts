'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/personal.ts).
 */

export async function createEmployee(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('personal.mitarbeiter_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function updateEmployee(employeeId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('personal.mitarbeiter_aendern', { recordId: employeeId, formData })
}

export async function clockToggle(employeeId: string): Promise<ActionResult> {
  return serverAktion('zeiterfassung.stempeln', { recordId: employeeId })
}

export async function clockByBarcode(formData: FormData): Promise<ActionResult> {
  return serverAktion('zeiterfassung.stempeln_barcode', { formData })
}

export async function stopEntry(entryId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('zeiterfassung.buchung_beenden', { recordId: entryId, formData })
}

export async function addTimeEntry(formData: FormData): Promise<ActionResult> {
  return serverAktion('personal.zeit_nachtragen', { formData })
}

export async function deleteTimeEntry(employeeId: string, entryId: string): Promise<ActionResult> {
  return serverAktion('personal.zeit_loeschen', {
    recordId: employeeId,
    parameter: { entry_id: entryId },
  })
}

export async function createShift(formData: FormData): Promise<ActionResult> {
  return serverAktion('personal.schicht_planen', { formData })
}

export async function deleteShift(shiftId: string): Promise<ActionResult> {
  return serverAktion('personal.schicht_loeschen', { recordId: shiftId })
}

export async function requestAbsence(formData: FormData): Promise<ActionResult> {
  return serverAktion('personal.abwesenheit_beantragen', { formData })
}

export async function decideAbsence(
  absenceId: string,
  state: 'approved' | 'rejected' | 'cancel',
): Promise<ActionResult> {
  return serverAktion('personal.abwesenheit_entscheiden', {
    recordId: absenceId,
    parameter: { state },
  })
}
