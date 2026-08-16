import { sql } from '@/db/client'
import type { AktionsErgebnis, AktionsKontext } from './typen.ts'

/** Ausführung der Prozess-Verwaltungsaktionen. */

export async function prozessschrittSchalten(
  p: { prozess_code: string; schritt_code: string; aktiv: boolean },
  ctx: AktionsKontext,
): Promise<AktionsErgebnis> {
  const [schritt] = await sql<{ optional: boolean; name: string }[]>`
    select s.optional, s.name from prozess_schritte s
    where s.version_id = prozess_aktive_version(${p.prozess_code})
      and s.code = ${p.schritt_code}`
  if (!schritt) {
    throw new Error(
      `Schritt „${p.schritt_code}" existiert nicht in der aktiven Version von ${p.prozess_code}.`,
    )
  }
  if (!p.aktiv && !schritt.optional) {
    throw new Error('Nur optionale Schritte lassen sich abschalten.')
  }

  await sql`
    insert into prozess_overrides (prozess_code, schritt_code, aktiv, geaendert_von)
    values (${p.prozess_code}, ${p.schritt_code}, ${p.aktiv}, ${ctx.actor})
    on conflict (prozess_code, schritt_code)
    do update set aktiv = excluded.aktiv, geaendert_von = excluded.geaendert_von`

  return {
    text: `„${schritt.name}" ist jetzt ${p.aktiv ? 'aktiv' : 'abgeschaltet'}.`,
    recordId: p.prozess_code,
  }
}
