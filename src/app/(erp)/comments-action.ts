'use server'
import { revalidatePath } from 'next/cache'
import { serverAktion } from '@/modules/prozesse/server-aktion'
import type { KommentarModell } from '@/modules/prozesse/registry/notizen'

/**
 * Kommentarfeld der Detailseiten — seit der Katalog-Auflösung ein dünner
 * Wrapper um die Registry-Aktion notiz.anlegen: EIN Schreibweg für
 * UI-Kommentare und KI-Notizen, mit Modell-Allowlist, canAccess-Prüfung
 * und Existenz-Check im Executor (Entscheidungslog 2026-08-27).
 */

export type { KommentarModell }

export async function addComment(
  model: KommentarModell,
  recordId: string,
  path: string,
  formData: FormData,
) {
  // Eine leere Notiz ist kein Fehler, sondern ein versehentlicher Klick.
  const note = String(formData.get('note') ?? '').trim()
  if (!note) return

  const ergebnis = await serverAktion('notiz.anlegen', {
    recordId,
    parameter: { model, text: note },
  })
  // Erfolg bleibt still (wie bisher) — nur Fehler erreichen das Formular.
  if (ergebnis && 'error' in ergebnis) return ergebnis
  revalidatePath(path)
}
