'use server'
import { redirect } from 'next/navigation'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import { type ActionResult, isActionError, isActionInfo } from '@/modules/shared/action'

/**
 * Dreizeiler um serverAktion(): geprüft, berechtigt und ausgeführt wird in
 * der Aktions-Registry (prozesse/registry/fertigung.ts) — hier lebt nur noch
 * der Server-Action-Transport samt revalidatePath und redirect.
 */

export async function createMo(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('fertigung.auftrag_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function confirmMo(moId: string): Promise<ActionResult> {
  return serverAktion('fertigung.bestaetigen', { recordId: moId })
}

export async function startMo(moId: string): Promise<ActionResult> {
  return serverAktion('fertigung.beginnen', { recordId: moId })
}

export async function checkAvailability(moId: string): Promise<ActionResult> {
  return serverAktion('fertigung.verfuegbarkeit_pruefen', { recordId: moId })
}

export async function bulkZettel(formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.zettel_drucken', { formData })
}

export async function bulkStart(formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.massenstart', { formData })
}

export async function produceMo(moId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.fertig_melden', { recordId: moId, formData })
}

export async function cancelMo(moId: string): Promise<ActionResult> {
  return serverAktion('fertigung.stornieren', { recordId: moId })
}

// --- Demontage -------------------------------------------------------------

export async function createUnbuild(formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.demontage_anlegen', { formData })
}

export async function applyUnbuild(unbuildId: string, force: boolean): Promise<ActionResult> {
  return serverAktion('fertigung.demontage_buchen', {
    recordId: unbuildId,
    parameter: { force },
  })
}

// --- Stücklisten -----------------------------------------------------------

export async function createBom(formData: FormData): Promise<ActionResult> {
  const ergebnis = await serverAktion('fertigung.stueckliste_anlegen', { formData })
  if (isActionError(ergebnis)) return ergebnis
  if (isActionInfo(ergebnis) && ergebnis.link) redirect(ergebnis.link)
}

export async function addBomLine(bomId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.stueckliste_position_hinzufuegen', { recordId: bomId, formData })
}

export async function removeBomLine(bomId: string, lineId: string): Promise<ActionResult> {
  return serverAktion('fertigung.stueckliste_position_entfernen', {
    recordId: bomId,
    parameter: { line_id: lineId },
  })
}

export async function setBomConsumption(bomId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.stueckliste_verbrauch', { recordId: bomId, formData })
}

export async function updateMoDetails(moId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.auftrag_details', { recordId: moId, formData })
}

export async function setBomLineIssueMethod(
  bomId: string,
  lineId: string,
  method: string,
): Promise<ActionResult> {
  return serverAktion('fertigung.stueckliste_verbrauchsart', {
    recordId: bomId,
    parameter: { line_id: lineId, method: method === 'manual' ? 'manual' : 'backflush' },
  })
}

// --- Arbeitsplätze ---------------------------------------------------------

export async function createWorkCenter(formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.arbeitsplatz_anlegen', { formData })
}

export async function updateWorkCenter(
  workCenterId: string,
  formData: FormData,
): Promise<ActionResult> {
  return serverAktion('fertigung.arbeitsplatz_aendern', { recordId: workCenterId, formData })
}

// --- Arbeitsgänge an der Stückliste ---------------------------------------

export async function addBomOperation(bomId: string, formData: FormData): Promise<ActionResult> {
  return serverAktion('fertigung.arbeitsgang_hinzufuegen', { recordId: bomId, formData })
}

export async function removeBomOperation(
  bomId: string,
  operationId: string,
): Promise<ActionResult> {
  return serverAktion('fertigung.arbeitsgang_entfernen', {
    recordId: bomId,
    parameter: { operation_id: operationId },
  })
}

// --- Arbeitsgänge am Auftrag ----------------------------------------------

export async function startOperation(
  moId: string,
  operationId: string,
  formData?: FormData,
): Promise<ActionResult> {
  return serverAktion('fertigung.arbeitsgang_starten', {
    recordId: moId,
    parameter: {
      operation_id: operationId,
      employee_id: String(formData?.get('employee_id') ?? '').trim() || undefined,
    },
  })
}

export async function finishOperation(
  moId: string,
  operationId: string,
  formData: FormData,
): Promise<ActionResult> {
  const raw = String(formData.get('minutes') ?? '').trim()
  return serverAktion('fertigung.arbeitsgang_beenden', {
    recordId: moId,
    parameter: {
      operation_id: operationId,
      minutes: raw === '' ? undefined : Number(raw),
    },
  })
}
