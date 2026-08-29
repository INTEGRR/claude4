'use server'

import { revalidatePath } from 'next/cache'
import { currentUser } from '@/modules/auth'
import { canAccess } from '@/modules/auth/permissions'
import { sql } from '@/db/client'
import { type ActionResult, actionError, actionFail, actionInfo } from '@/modules/shared/action'
import { AktionsFehler, aktionAusfuehrenGeprueft } from '@/modules/prozesse/torwaechter'

/**
 * Prüftabelle der Sprachsammlung: Hier passiert die Sichtprüfung — und erst
 * hier wird gebucht. Sequenziell über den Torwächter, Zählungen als Kette
 * erfassen → buchen (der Bestands-Wächter von inventory_apply greift damit
 * im Buchungsmoment, nicht Minuten vorher beim Sprechen).
 */

async function eigenesProtokoll(protokollId: string) {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) return null
  const [p] = await sql<{ id: string }[]>`
    select id from sprachprotokolle where id = ${protokollId} and user_id = ${user.id}`
  return p ? user : null
}

export async function vorgangVerwerfen(vorgangId: string): Promise<ActionResult> {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) return actionError('Nicht berechtigt')
  const geaendert = await sql`
    update sprach_vorgaenge v set status = 'verworfen'
    from sprachprotokolle p
    where v.id = ${vorgangId} and p.id = v.protokoll_id
      and p.user_id = ${user.id} and v.status = 'offen'`
  if (geaendert.count === 0) return actionError('Vorgang nicht gefunden oder nicht mehr offen')
  revalidatePath('/sprechen')
  return actionInfo('Vorgang verworfen.')
}

export async function zaehlmengeAendern(vorgangId: string, formData: FormData): Promise<ActionResult> {
  const user = await currentUser()
  if (!user || !canAccess(user.role, 'ki')) return actionError('Nicht berechtigt')
  const menge = Number(formData.get('counted_qty'))
  if (!Number.isFinite(menge) || menge < 0) {
    return actionError('Die gezählte Menge muss eine Zahl ≥ 0 sein.')
  }
  const geaendert = await sql`
    update sprach_vorgaenge v
    set parameter = v.parameter || jsonb_build_object('counted_qty', ${menge}::numeric),
        zusammenfassung = v.zusammenfassung || ${` (korrigiert: ${menge})`}
    from sprachprotokolle p
    where v.id = ${vorgangId} and p.id = v.protokoll_id
      and p.user_id = ${user.id} and v.status = 'offen'
      and v.aktion = 'lager.zaehlung_erfassen'`
  if (geaendert.count === 0) return actionError('Vorgang nicht gefunden oder nicht mehr offen')
  revalidatePath('/sprechen')
  return actionInfo(`Menge auf ${menge} korrigiert.`)
}

export async function sammlungBuchen(protokollId: string): Promise<ActionResult> {
  const user = await eigenesProtokoll(protokollId)
  if (!user) return actionError('Nicht berechtigt')

  const vorgaenge = await sql<
    { id: string; aktion: string; parameter: Record<string, unknown>; record_id: string | null }[]
  >`
    select id, aktion, parameter, record_id from sprach_vorgaenge
    where protokoll_id = ${protokollId} and status = 'offen'
    order by seq`
  if (vorgaenge.length === 0) return actionError('Keine offenen Vorgänge in dieser Sammlung.')

  let gebucht = 0
  let fehler = 0
  for (const v of vorgaenge) {
    try {
      let text: string
      if (v.aktion === 'lager.zaehlung_erfassen') {
        // Kette: Zählung JETZT erfassen (book_qty wird frisch festgehalten)
        // und sofort buchen — beides über den Torwächter.
        const erfasst = await aktionAusfuehrenGeprueft(
          'lager.zaehlung_erfassen',
          { parameter: v.parameter },
          user,
        )
        if (!erfasst.recordId) throw new AktionsFehler('Zählung ohne Beleg-ID')
        await aktionAusfuehrenGeprueft(
          'lager.zaehlung_buchen',
          { parameter: {}, recordId: erfasst.recordId },
          user,
        )
        text = 'Zählung gebucht'
      } else {
        // Ein vor der Katalog-Auflösung notierter Alt-Vorgang scheitert hier
        // sichtbar als „Unbekannte Aktion" — bewusst kein Alias-Weg.
        const ergebnis = await aktionAusfuehrenGeprueft(
          v.aktion,
          { parameter: v.parameter, recordId: v.record_id ?? undefined },
          user,
        )
        text = ergebnis.text ?? 'Ausgeführt'
      }
      await sql`update sprach_vorgaenge
                set status = 'gebucht', ergebnis_text = ${text.slice(0, 500)}, gebucht_am = now()
                where id = ${v.id}`
      gebucht += 1
    } catch (err) {
      const meldung = (err instanceof Error ? err.message : String(err)).replace(/^error: /, '')
      await sql`update sprach_vorgaenge
                set status = 'fehler', ergebnis_text = ${meldung.slice(0, 500)}
                where id = ${v.id}`
      fehler += 1
    }
  }

  try {
    await sql`update sprachprotokolle set beendet_am = coalesce(beendet_am, now())
              where id = ${protokollId}`
  } catch (err) {
    return actionFail(err)
  }
  revalidatePath('/sprechen')
  return fehler === 0
    ? actionInfo(`${gebucht} Vorgang/Vorgänge gebucht.`)
    : actionInfo(`${gebucht} gebucht, ${fehler} mit Fehler — Details in der Tabelle.`)
}
