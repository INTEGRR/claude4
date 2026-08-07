import { sql } from '@/db/client'
import { ActionForm } from '@/components/action-button'

/**
 * Kompakte Zeile "Verantwortlich + Dringend" für Beleg-Detailseiten
 * (stock.picking / mrp.production / repair.order: user_id, priority).
 */
export async function ResponsibleForm({
  action,
  userId,
  priority,
}: {
  action: (formData: FormData) => Promise<void>
  userId: string | null
  priority: string
}) {
  const benutzer = await sql<{ id: string; name: string }[]>`
    select id, name from users where active order by name`

  return (
    <ActionForm action={action} style={{ marginBottom: 0 }}>
      <div className="row" style={{ alignItems: 'center', marginBottom: 0 }}>
        <label className="field" style={{ marginBottom: 0, minWidth: 180 }}>
          <span>Verantwortlich</span>
          <select name="user_id" defaultValue={userId ?? ''}>
            <option value="">—</option>
            {benutzer.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        </label>
        <label className="shrink" style={{ marginTop: 16 }}>
          <input type="checkbox" name="priority" defaultChecked={priority === '1'} /> Dringend
        </label>
        <div className="shrink" style={{ marginTop: 16 }}>
          <button className="small" type="submit">Übernehmen</button>
        </div>
      </div>
    </ActionForm>
  )
}
