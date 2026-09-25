import Link from 'next/link'
import { sql } from '@/db/client'
import { einmalAnzeigeAbholen, requireUser } from '@/modules/auth'
import { ROLE_LABELS } from '@/modules/auth/permissions'
import {
  geraeteAuflisten,
  pflichtGilt,
  sicherheitsEinstellung,
  zweifaktorStatus,
} from '@/modules/auth/zweifaktor'
import { ActionButton, ActionForm } from '@/components/action-button'
import { AuditLog, Card, Empty, type LogEntry, PageHeader, TableWrap } from '@/components/ui'
import { date as datum, dateTime } from '@/modules/shared/format'
import { backupCodesErneuern, geraetWiderrufen } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Konto & Sicherheit — die eine Seite, die JEDE Rolle erreicht (requireUser,
 * kein Bereich): Stand des zweiten Faktors, Backup-Codes, vertraute Geräte,
 * Sicherheitsverlauf. Nach der Einrichtung zeigt ?neu=1 die Backup-Codes
 * genau einmal (Einmal-Anzeige an der Sitzung).
 */
export default async function KontoPage({
  searchParams,
}: {
  searchParams: Promise<{ neu?: string }>
}) {
  const user = await requireUser()
  const { neu } = await searchParams
  const frisch = neu ? await einmalAnzeigeAbholen<{ backup_codes: string[] }>() : null

  const status = await zweifaktorStatus(sql, user.id)
  const geraete = await geraeteAuflisten(sql, user.id)
  const { zwei_faktor } = await sicherheitsEinstellung(sql)
  const pflicht = pflichtGilt(user.role, zwei_faktor)
  const verlauf = await sql<LogEntry[]>`
    select id, kind, message, actor, created_at from audit_log
    where model = 'user' and record_id = ${user.id}
    order by created_at desc limit 40`

  return (
    <>
      <PageHeader
        title="Konto & Sicherheit"
        subtitle={`${user.name} · ${user.email} · ${ROLE_LABELS[user.role]}`}
      />

      {frisch && frisch.backup_codes.length > 0 && (
        <Card title="Ihre Backup-Codes — jetzt sichern">
          <div className="notice warn">
            Diese Codes erscheinen nur dieses eine Mal. Jeder ersetzt einmal den Code aus der App,
            wenn das Telefon nicht zur Hand ist. Ausdrucken oder im Passwortmanager ablegen.
          </div>
          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: 6,
              fontSize: 15,
            }}
          >
            {frisch.backup_codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </Card>
      )}

      <div className="grid-2">
        <Card title="Zweiter Faktor (Authenticator-App)">
          <div className="mono-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={status.aktiv ? 'led ok' : 'led warn'} />
            {status.aktiv
              ? `eingerichtet seit ${datum(status.aktiviert_at)}`
              : pflicht
                ? 'nicht eingerichtet — Pflicht'
                : 'nicht eingerichtet'}
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            {status.aktiv ? (
              <>
                Jede Anmeldung verlangt zusätzlich den Code aus der App — außer auf vertrauten
                Geräten. Telefon verloren? Ein Administrator setzt den zweiten Faktor zurück
                (Einstellungen → Benutzer), danach richten Sie ihn neu ein.
              </>
            ) : (
              <>
                Empfohlen: Ein Code aus der Authenticator-App schützt das Konto auch bei
                bekanntem Passwort.{' '}
                <Link href="/login/einrichten">Jetzt einrichten →</Link>
              </>
            )}
          </p>
        </Card>

        <Card title="Backup-Codes">
          <div className="mono-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={status.backup_offen > 2 ? 'led ok' : status.backup_offen > 0 ? 'led warn' : 'led off'} />
            {status.backup_offen} unbenutzt
          </div>
          {status.aktiv ? (
            <ActionForm action={backupCodesErneuern} style={{ marginTop: 10 }}>
              <div className="row">
                <label className="field">
                  <span>Code aus der App (Bestätigung)</span>
                  <input name="code" required inputMode="numeric" autoComplete="one-time-code" className="mono" />
                </label>
                <div className="shrink field">
                  <button className="small" type="submit">Neue Codes erzeugen</button>
                </div>
              </div>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Erzeugt zehn neue Codes; alle bisherigen verlieren sofort ihre Gültigkeit.
              </p>
            </ActionForm>
          ) : (
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              Backup-Codes entstehen mit der Einrichtung des zweiten Faktors.
            </p>
          )}
        </Card>
      </div>

      <Card title={`Vertraute Geräte (${geraete.length})`} tight>
        {geraete.length === 0 ? (
          <Empty>
            Kein Gerät gemerkt. Beim Eingeben des Codes lässt sich „Dieses Gerät 30 Tage merken"
            anhaken — dann fragt dieser Browser bis zum Ablauf nur nach dem Passwort.
          </Empty>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Gerät</th>
                  <th>Vertraut seit</th>
                  <th>Zuletzt</th>
                  <th>Läuft ab</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {geraete.map((g) => (
                  <tr key={g.id}>
                    <td>{g.bezeichnung || 'Browser'}</td>
                    <td className="small muted mono">{dateTime(g.erstellt_at)}</td>
                    <td className="small muted mono">{g.zuletzt_at ? dateTime(g.zuletzt_at) : '—'}</td>
                    <td className="small muted mono">{datum(g.laeuft_ab_at)}</td>
                    <td className="num">
                      <ActionButton
                        className="small danger"
                        action={geraetWiderrufen.bind(null, g.id)}
                        confirm="Gerät entfernen? Die nächste Anmeldung dort verlangt wieder den Code."
                      >
                        Entfernen
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <Card title="Sicherheitsverlauf">
        {verlauf.length === 0 ? (
          <Empty>Noch keine Einträge.</Empty>
        ) : (
          <AuditLog entries={verlauf} />
        )}
      </Card>
    </>
  )
}
