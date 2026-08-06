import { sql } from '@/db/client'
import { requireArea, requireAdmin } from '@/modules/auth'
import { ALL_ROLES, ROLE_LABELS, type Role } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, PageHeader, TableWrap } from '@/components/ui'
import { dateTime } from '@/modules/shared/format'
import { createUser, resetPassword, setActive, setRole } from './actions'

export const dynamic = 'force-dynamic'

export default async function BenutzerPage() {
  await requireArea('einstellungen')
  const admin = await requireAdmin()

  const users = await sql<
    {
      id: string
      email: string
      name: string
      role: Role
      active: boolean
      created_at: string
    }[]
  >`select id, email, name, role, active, created_at from users order by created_at`

  const activeAdmins = users.filter((u) => u.role === 'admin' && u.active).length

  return (
    <>
      <PageHeader
        title="Benutzer"
        subtitle="Konten und Rollen. Lager- und Fertigungsrollen sehen nur ihre Bereiche."
      />

      <Card title={`Konten (${users.length})`} tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Rolle</th>
                <th>Status</th>
                <th>Angelegt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const lastAdmin = u.role === 'admin' && u.active && activeAdmins === 1
                return (
                  <tr key={u.id}>
                    <td>
                      {u.name}
                      {u.id === admin.id && <span className="muted small"> (Sie)</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      {lastAdmin ? (
                        <span title="Letzter aktiver Administrator">{ROLE_LABELS[u.role]}</span>
                      ) : (
                        <ActionForm action={setRole.bind(null, u.id)}>
                          <div className="row">
                            <select name="role" defaultValue={u.role} className="small">
                              {ALL_ROLES.map((r) => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                            <div className="shrink">
                              <button className="small" type="submit">Ändern</button>
                            </div>
                          </div>
                        </ActionForm>
                      )}
                    </td>
                    <td>
                      {u.active ? (
                        <span className="badge success">aktiv</span>
                      ) : (
                        <span className="badge neutral">deaktiviert</span>
                      )}
                    </td>
                    <td className="nowrap small muted">{dateTime(u.created_at)}</td>
                    <td className="num">
                      <div className="actions">
                        {u.active && !lastAdmin && u.id !== admin.id && (
                          <ActionButton
                            className="small danger"
                            action={setActive.bind(null, u.id, false)}
                            confirm={`${u.name} deaktivieren? Laufende Sitzungen werden beendet.`}
                          >
                            Deaktivieren
                          </ActionButton>
                        )}
                        {!u.active && (
                          <ActionButton className="small" action={setActive.bind(null, u.id, true)}>
                            Aktivieren
                          </ActionButton>
                        )}
                        <details style={{ display: 'inline-block' }}>
                          <summary className="btn small">Passwort…</summary>
                          <ActionForm action={resetPassword.bind(null, u.id)} style={{ marginTop: 6 }}>
                            <div className="row">
                              <input
                                type="password"
                                name="password"
                                placeholder="Neues Passwort"
                                minLength={8}
                                required
                              />
                              <div className="shrink">
                                <button className="small" type="submit">Setzen</button>
                              </div>
                            </div>
                          </ActionForm>
                        </details>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Card title="Neuen Benutzer anlegen">
        <ActionForm action={createUser}>
          <div className="row">
            <label className="field">
              <span>Name</span>
              <input name="name" required />
            </label>
            <label className="field">
              <span>E-Mail</span>
              <input type="email" name="email" required />
            </label>
            <label className="field">
              <span>Passwort</span>
              <input type="password" name="password" minLength={8} required />
            </label>
            <label className="field">
              <span>Rolle</span>
              <select name="role" defaultValue="mitarbeiter">
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </label>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
        </ActionForm>
      </Card>
    </>
  )
}
