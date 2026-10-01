import { sql } from '@/db/client'
import { requireArea, requireAdmin } from '@/modules/auth'
import { ALLE_BEFUGNISSE, ALL_ROLES, BEFUGNISSE, ROLE_LABELS, type Role } from '@/modules/auth/permissions'
import { ActionButton, ActionForm } from '@/components/action-button'
import { Card, TableWrap } from '@/components/ui'
import { EinstellungenKopf } from '@/components/einstellungen-kopf'
import { date as datum, dateTime } from '@/modules/shared/format'
import { createUser, deleteUser, resetPassword, resetZweiFaktor, setActive, setBefugnisse, setRole } from './actions'

export const dynamic = 'force-dynamic'

/** Als Zusatzrolle wählbar — Administrator nur als Hauptrolle (0096). */
const ZUSATZ_ROLLEN: Role[] = ['mitarbeiter', 'lager', 'fertigung']

export default async function BenutzerPage() {
  await requireArea('einstellungen')
  const admin = await requireAdmin()

  const users = await sql<
    {
      id: string
      email: string | null
      benutzername: string | null
      name: string
      role: Role
      zusatz_rollen: Role[]
      befugnisse: string[]
      active: boolean
      created_at: string
      totp_aktiviert_at: string | null
    }[]
  >`select id, email, benutzername, name, role, zusatz_rollen::text[] as zusatz_rollen, befugnisse, active,
           created_at, totp_aktiviert_at
    from users order by created_at`

  const activeAdmins = users.filter((u) => u.role === 'admin' && u.active).length

  return (
    <>
      <EinstellungenKopf href="/einstellungen/benutzer" />

      <Card title={`Konten (${users.length})`} tight>
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Anmeldung</th>
                <th>Rollen</th>
                <th>Befugnisse</th>
                <th>Status</th>
                <th>2FA</th>
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
                    <td className="mono small">
                      {u.email ?? u.benutzername}
                      {u.email && u.benutzername && <div className="muted">{u.benutzername}</div>}
                      {!u.email && <div className="muted" style={{ fontFamily: 'inherit' }}>ohne E-Mail</div>}
                    </td>
                    <td>
                      {lastAdmin ? (
                        // Gesperrter Zustand sichtbar machen, nicht nur im title-Attribut.
                        <>
                          <div>{ROLE_LABELS[u.role]}</div>
                          <div
                            className="mono-label"
                            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}
                          >
                            <span className="led warn" /> gesperrt · letzter Administrator
                          </div>
                        </>
                      ) : (
                        <ActionForm action={setRole.bind(null, u.id)}>
                          <input type="hidden" name="zusatz_gezeigt" value="1" />
                          <div className="row" style={{ alignItems: 'flex-start' }}>
                            <div>
                              <select name="role" defaultValue={u.role} className="small" aria-label="Hauptrolle">
                                {ALL_ROLES.map((r) => (
                                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                                ))}
                              </select>
                              {u.role !== 'admin' && (
                                <div style={{ marginTop: 4 }}>
                                  {ZUSATZ_ROLLEN.filter((r) => r !== u.role).map((r) => (
                                    <label key={r} className="small" style={{ display: 'block' }}>
                                      <input
                                        type="checkbox"
                                        name="zusatz_rollen"
                                        value={r}
                                        defaultChecked={u.zusatz_rollen.includes(r)}
                                      />{' '}
                                      + {ROLE_LABELS[r]}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="shrink">
                              <button className="small" type="submit">Ändern</button>
                            </div>
                          </div>
                        </ActionForm>
                      )}
                    </td>
                    <td>
                      {/* Personengebundene Zusatzrechte — Admins besitzen
                          jede Befugnis kraft Rolle, die Haken wären Deko. */}
                      {u.role === 'admin' ? (
                        <span className="muted small">alle (Administrator)</span>
                      ) : (
                        <ActionForm action={setBefugnisse.bind(null, u.id)}>
                          <div className="row" style={{ alignItems: 'center' }}>
                            <div>
                              {ALLE_BEFUGNISSE.map((b) => (
                                <label key={b} className="small" style={{ display: 'block' }}>
                                  <input
                                    type="checkbox"
                                    name="befugnisse"
                                    value={b}
                                    defaultChecked={u.befugnisse.includes(b)}
                                  />{' '}
                                  {BEFUGNISSE[b]}
                                </label>
                              ))}
                            </div>
                            <div className="shrink">
                              <button className="small" type="submit">Setzen</button>
                            </div>
                          </div>
                        </ActionForm>
                      )}
                    </td>
                    <td>
                      <span
                        className="mono-label"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <span className={u.active ? 'led ok' : 'led off'} />
                        {u.active ? 'aktiv' : 'deaktiviert'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="mono-label"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        title={u.totp_aktiviert_at ? 'Authenticator-App eingerichtet' : 'Zweiter Faktor fehlt'}
                      >
                        <span className={u.totp_aktiviert_at ? 'led ok' : 'led warn'} />
                        {u.totp_aktiviert_at ? `seit ${datum(u.totp_aktiviert_at)}` : 'fehlt'}
                      </span>
                    </td>
                    <td className="nowrap small muted mono">{dateTime(u.created_at)}</td>
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
                        {!lastAdmin && u.id !== admin.id && (
                          <ActionButton
                            className="small danger"
                            action={deleteUser.bind(null, u.id)}
                            title="Endgültig löschen — für Seed- und Testkonten. Wer im Betrieb gearbeitet hat, besser deaktivieren."
                            confirm={`Konto ${u.name} (${u.email ?? u.benutzername}) endgültig löschen? Zuständigkeiten an Belegen werden geleert, der Verlauf behält den Namen. Das lässt sich nicht rückgängig machen.`}
                          >
                            Löschen
                          </ActionButton>
                        )}
                        <ActionButton
                          className="small"
                          action={resetZweiFaktor.bind(null, u.id)}
                          title="Telefon verloren oder gewechselt: Geheimnis, Backup-Codes, Geräte und Sitzungen entfernen"
                          confirm={`Zweiten Faktor von ${u.name} zurücksetzen? Alle Sitzungen enden, der nächste Login richtet neu ein.`}
                        >
                          2FA zurücksetzen
                        </ActionButton>
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
              <span>E-Mail (optional)</span>
              <input type="email" name="email" />
            </label>
            <label className="field">
              <span>Benutzername (ohne E-Mail)</span>
              <input name="benutzername" className="mono" placeholder="z. B. max.m" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{1,39}" />
            </label>
            <label className="field">
              <span>Passwort</span>
              <input type="password" name="password" minLength={8} required />
            </label>
            <label className="field">
              <span>Hauptrolle</span>
              <select name="role" defaultValue="mitarbeiter">
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="feld-titel">Zusatzrollen</span>
              <div>
                {ZUSATZ_ROLLEN.map((r) => (
                  <label key={r} className="small" style={{ display: 'block' }}>
                    <input type="checkbox" name="zusatz_rollen" value={r} /> + {ROLE_LABELS[r]}
                  </label>
                ))}
              </div>
            </div>
            <div className="shrink field">
              <button className="primary" type="submit">Anlegen</button>
            </div>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Wer keine E-Mail-Adresse hat, bekommt einen Benutzernamen und meldet sich damit an. Mehrere
            Rollen: z. B. Hauptrolle Lager + Zusatzrolle Fertigung — die Rechte addieren sich.
          </p>
        </ActionForm>
      </Card>
    </>
  )
}
