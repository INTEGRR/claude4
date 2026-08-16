import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'
import type { ActionResult } from '@/modules/shared/action'

/**
 * Kompakte Zeile "Verantwortlich + Dringend" für Beleg-Detailseiten
 * (stock.picking / mrp.production / repair.order: user_id, priority).
 */
export async function ResponsibleForm({
  action,
  userId,
  priority,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  userId: string | null
  priority: string
}) {
  const benutzer = await sql<{ id: string; name: string }[]>`
    select id, name from users where active order by name`

  return (
    <ActionForm action={action} style={{ marginBottom: 0 }}>
      {/* .row richtet standardmäßig an der Unterkante aus — damit sitzen
          Auswahl, Schalter und Taste auf einer Linie, ohne geratene Abstände. */}
      <div className="row" style={{ marginBottom: 0 }}>
        <label className="field" style={{ marginBottom: 0, minWidth: 180 }}>
          <span>Verantwortlich</span>
          <select name="user_id" defaultValue={userId ?? ''}>
            <option value="">—</option>
            {benutzer.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        {/* "Dringend" ist ein kritischer Zustand — hier darf die Leuchte glühen. */}
        <label className="shrink" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingBottom: 7 }}>
          <input type="checkbox" name="priority" defaultChecked={priority === '1'} />
          {priority === '1' && <span className="led on" />}
          <span className="mono-label">Dringend</span>
        </label>
        <div className="shrink">
          <button className="small" type="submit">Übernehmen</button>
        </div>
      </div>
    </ActionForm>
  )
}
